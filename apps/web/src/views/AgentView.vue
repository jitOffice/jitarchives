<script setup lang="ts">
/**
 * 档案 Agent 助理（第一阶段对话式查档 + 第二阶段附件正文问答 + 第三阶段智能业务办理）。
 * - 会话栏、历史恢复、新建/删除、消息与档案卡片一律来自后端真实接口；
 * - 档案卡片与正文来源均复用既有路由（/archives/:id、/borrow），操作入口由后端权限判定；
 * - 正文问答的每条来源（档案 / 档号 / 附件 / 版本 / 位置 / 摘录）都来自后端检索结果，前端不做补齐；
 * - 第三阶段的借阅确认卡 / 进度卡 / 著录预览卡全部渲染后端真实业务数据；
 *   确认与取消只递交 token + 用户可改字段，申请内容由服务端草稿决定；
 * - 欢迎区快捷卡片要么直接发起检索、要么把问题填入输入框，均有真实功能；
 * - 第三阶段（图谱联动）：知识图谱页的「问 AI / 分析关联」通过 store.pendingGraphAsk 交接，
 *   进入本页时绑定当前分析范围并预填问题（用户可改写后发送）；图谱上下文只是检索线索，
 *   节点真实性与权限由后端每次提问重新查询校验；回答引用可返回图谱对应节点定位；
 * - 不把尚未实现的能力（OCR / AI 自动审批 / AI 自动归档）展示为已开放功能。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {sourceRoute,graphNodeRoute,graphEdgeRoute,answerCitationParts,graphEvidenceRows,groupAgentSources} from '../lib/agentSource';
import type { AgentSourceGroup } from '../lib/agentSource';
import type { AgentGraphCitation } from '../types';
import type { KgGraphNodeView } from '../lib/knowledge-graph/types';
import { useAgentStore, type AgentProgressStageId, type AgentProgressStageStatus } from '../stores/agent';
import type {
  AgentArchiveCard,
  AgentAttachmentCard,
  AgentBorrowDraftView,
  AgentBorrowRecordView,
  AgentCatalogDraftView,
  AgentCatalogFieldView,
  AgentMessageView,
  AgentPayload,
  AgentSource,
} from '../types';
import { notifyError, notifySuccess } from '../toast';
import { confirmDialog } from '../components/ui/dialog';
import AppLoading from '../components/ui/AppLoading.vue';
import BrandMark from '../components/BrandMark.vue';
import AgentAiSettingsDialog from '../components/AgentAiSettingsDialog.vue';

const store = useAgentStore();
const router = useRouter();

const input = ref('');
const sidebarOpen = ref(false);
const scroller = ref<HTMLElement | null>(null);
const aiSettingsOpen = ref(false);

async function onAiSettingsSaved() {
  await store.loadStatus(true);
}

const MAX_INPUT = 500;
const MAX_BORROW_DAYS = 90;
const canSend = computed(() => input.value.trim().length > 0 && !store.sending && store.regeneratingId === null);
const showWelcome = computed(() => !store.messagesLoading && store.messages.length === 0);

const progressSteps: Array<{ id: AgentProgressStageId; label: string }> = [
  { id: 'understand', label: '理解你的问题' },
  { id: 'archives', label: '检索相关档案记录' },
  { id: 'content', label: '查找相关附件内容' },
  { id: 'evidence', label: '整理匹配结果' },
  { id: 'answer', label: '生成最终回答' },
];

function progressStatus(id: AgentProgressStageId): AgentProgressStageStatus {
  return store.progress?.steps.find((step) => step.id === id)?.status ?? 'waiting';
}

function progressDescription(id: AgentProgressStageId, status: AgentProgressStageStatus): string {
  if (id === 'answer' && status === 'running') {
    const detail = store.progress?.steps.find((step) => step.id === 'answer')?.detail;
    if (detail) return detail;
  }
  const descriptions: Record<AgentProgressStageId, Record<AgentProgressStageStatus, string>> = {
    understand: {
      waiting: '等待梳理你的查询需求', running: '正在梳理你的查询需求', completed: '已识别你的查询需求',
      empty: '暂未识别到明确的查询条件', failed: '问题理解未能完成', skipped: '本次无需单独处理此步骤',
    },
    archives: {
      waiting: '等待查找符合条件的档案与相关记录', running: '正在查找符合条件的档案与相关记录', completed: '已完成相关记录查找',
      empty: '暂未找到匹配的档案或记录', failed: '相关记录查找遇到问题', skipped: '本次无需单独查找档案记录',
    },
    content: {
      waiting: '等待查找相关附件与正文', running: '正在查找相关附件和正文内容', completed: '已完成相关附件内容查找',
      empty: '暂未找到匹配的附件内容', failed: '附件内容查找遇到问题', skipped: '本次无需查找附件正文',
    },
    evidence: {
      waiting: '等待整理查询结果', running: '正在核对资料并整理匹配结果', completed: '已完成资料核对与整理',
      empty: '没有找到可用于回答的内容', failed: '资料整理未能完成', skipped: '本次无需单独整理正文依据',
    },
    answer: {
      waiting: '等待生成回答', running: '正在根据检索结果组织回答', completed: '已生成回答',
      empty: '暂时无法生成完整回答', failed: '回答生成遇到问题', skipped: '本次无需调用 AI 生成回答',
    },
  };
  return descriptions[id][status];
}

/** 快捷提问卡片：send = 直接发起检索；fill = 填入输入框待用户补全后发送。 */
interface QuickCard {
  label: string;
  mode: 'send' | 'fill';
  text: string;
}
const quickCards: QuickCard[] = [
  { label: '智能查档：按标题/档号/分类检索', mode: 'fill', text: '帮我查找' },
  { label: '档案内容问答：就附件正文提问', mode: 'fill', text: '档案《请填写档案标题或档号》的付款条件是什么？' },
  { label: '申请档案借阅', mode: 'fill', text: '帮我申请借阅档案：' },
  { label: '查询借阅进度', mode: 'send', text: '帮我查看最近的借阅记录' },
  { label: '智能辅助著录', mode: 'fill', text: '帮我整理这份档案的档案信息：' },
  { label: '如何更准确地查找档案？', mode: 'send', text: '如何更准确地查找档案？' },
];

function pickQuickCard(card: QuickCard) {
  if (card.mode === 'send') {
    void submit(card.text);
  } else {
    input.value = card.text;
    sidebarOpen.value = false;
  }
}

/** 本条回复携带的可点击提示语（仅后端在「答不了/查无结果/需补充信息」时返回）。 */
function answerSuggestions(msg: AgentMessageView): string[] {
  return msg.role === 'assistant' ? msg.payload?.suggestions ?? [] : [];
}

/** 只在最新一条回复下展示，发送中或重新生成中隐藏，避免历史会话堆叠过期引导。 */
function showAnswerSuggestions(msg: AgentMessageView, index: number): boolean {
  return index === store.messages.length - 1
    && !store.sending
    && store.regeneratingId === null
    && answerSuggestions(msg).length > 0;
}

/** 参考豆包：点击提示语直接作为下一条提问发送，而不是只填入输入框。 */
function pickSuggestion(text: string) {
  if (!text.trim() || store.sending || store.regeneratingId !== null) return;
  sidebarOpen.value = false;
  void submit(text);
}

async function submit(text: string) {
  const q = text.trim();
  if (!q || store.sending) return;
  // 发送即清空输入框，避免等待后端回复期间旧内容一直残留在输入区。
  // 仅在提交内容与输入框一致时清空，快捷卡片/提示语发送不误删用户正在编辑的内容。
  const cleared = input.value.trim() === q;
  if (cleared) input.value = '';
  // 第三阶段：携带当前绑定的图谱上下文（仅提示 ID，后端重新验证真实性与权限）
  const ok = await store.ask(q, store.graphContext ?? undefined);
  // 发送失败或被主动停止时回填内容，便于用户修改后重试；若期间已输入新内容则不覆盖。
  if (!ok && cleared && !input.value.trim()) input.value = q;
  await scrollToEnd();
}

function onSend() {
  if (!canSend.value) return;
  void submit(input.value);
}

function onStop() {
  store.stop();
}

function inventoryPage(question: string, page: number, size: number) {
  return `${question.replace(/第\s*\d+\s*页|每页\s*\d+\s*条/gu, '').trim()} 第 ${page} 页，每页 ${size} 条`;
}

function onKeydown(e: KeyboardEvent) {
  // Enter 发送，Shift+Enter 换行；输入法组合期间不触发
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onSend();
  }
}

async function selectConversation(id: number) {
  sidebarOpen.value = false;
  await store.selectConversation(id);
  await scrollToEnd();
}

async function newConversation() {
  store.newConversation();
  input.value = '';
  sidebarOpen.value = false;
}

async function removeConversation(conv: { id: number; title: string }) {
  const ok = await confirmDialog({
    title: '删除会话',
    message: `确定删除会话「${conv.title}」吗？该操作只删除此会话及其对话记录，不影响档案数据。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  await store.deleteConversation(conv.id);
}

function openDetail(card: AgentArchiveCard) {
  if (!card.canOpenDetail) return;
  void router.push(card.detailPath);
}

/** 统一检索：附件 / 正文来源同样只跳后端授权过的 detailPath，前端不推测档案 ID。 */
function openAttachment(card: AgentAttachmentCard) {
  if (!card.canOpenDetail || !card.detailPath) return;
  const target=sourceRoute(card);
  if(target)void router.push(target);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** 借阅记录 / 办理结果跳档：detailPath 由后端按真实档案 ID 生成并已过权限判定。 */
function openRecord(record: AgentBorrowRecordView) {
  if (!record.canOpenDetail || !record.detailPath) return;
  void router.push(record.detailPath);
}

function goBorrowPage(scope: 'mine' | 'review') {
  void router.push(scope === 'review' ? '/borrow' : '/borrow/mine');
}

/**
 * 候选档案卡片上的业务入口：把「就这一份」转成一条带真实档号的明确提问，
 * 由后端重新检索定位，前端不传递也不推测档案 ID。
 */
function pickTarget(card: AgentArchiveCard, mode: 'borrow' | 'catalog') {
  void submit(
    mode === 'borrow'
      ? `帮我申请借阅档号 ${card.archiveNo} 的档案`
      : `帮我整理档号 ${card.archiveNo} 这份档案的著录信息`,
  );
}

/** 真实 ISO 时间的前端格式化（与借阅/档案详情页一致，后端只回原始时间）。 */
function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 借阅状态标记：只根据后端回传的真实状态值上颜色，不自定义新状态。 */
function borrowBadgeClass(status: string): string {
  if (status === 'approved' || status === 'returned') return 'badge-success';
  if (status === 'rejected' || status === 'expired') return 'badge-danger';
  return 'badge-muted';
}

// ---------- 第三阶段：确认区与可编辑预览 ----------

/**
 * 借阅草稿的可改字段本地覆盖表（按 token 暂存）。
 * 默认值来自后端草稿的真实内容，确认时才上送；档案 ID / 申请人不接受本地修改。
 */
const borrowEdits = ref<Record<string, { purpose?: string; days?: string }>>({});
/** 本轮已确认/取消过的 token（只影响按钮展示；真正的防重复提交在服务端条件抢占）。
 * 历史会话恢复后本表为空，此时重按依旧不会重复提交，后端会回显既有真实结果。 */
const actedTokens = ref<Record<string, 'confirmed' | 'cancelled'>>({});

/** 著录预览的本地编辑值：仅内存暂存，确认时才一并上送；
 * 留空表示「保留现有著录值」（后端会用原值回填，不会反向清空）。 */
const catalogEdits = ref<Record<string, Record<string, string>>>({});

function draftBusy(token: string | null): boolean {
  return !token || store.sending || store.regeneratingId !== null || store.actionToken !== '' || !!actedTokens.value[token];
}

function editPurpose(draft: AgentBorrowDraftView): string {
  return borrowEdits.value[draft.token]?.purpose ?? draft.purpose ?? '';
}

function editDays(draft: AgentBorrowDraftView): string {
  const raw = borrowEdits.value[draft.token]?.days;
  return raw ?? (draft.days == null ? '' : String(draft.days));
}

function setPurpose(token: string, value: string) {
  borrowEdits.value[token] = { ...borrowEdits.value[token], purpose: value.slice(0, 500) };
}

function setDays(token: string, value: string) {
  borrowEdits.value[token] = { ...borrowEdits.value[token], days: value.replace(/[^0-9]/g, '').slice(0, 3) };
}

/** 只有用途非空且期限为 1-90 的整数才允许提交（与现有借阅接口的真实校验一致）。 */
function borrowCanConfirm(draft: AgentBorrowDraftView): boolean {
  if (draft.missing.length > 0) return false;
  const days = Number(editDays(draft));
  return editPurpose(draft).trim().length > 0
    && Number.isInteger(days) && days >= 1 && days <= MAX_BORROW_DAYS;
}

/** 确认提交借阅申请：只传 token + 可改的用途/期限，其余全部以服务端草稿为准。 */
async function confirmBorrow(draft: AgentBorrowDraftView) {
  if (!borrowCanConfirm(draft) || draftBusy(draft.token)) return;
  const ok = await store.act(draft.token, 'confirm', {
    purpose: editPurpose(draft).trim(),
    days: editDays(draft),
  });
  if (ok) {
    actedTokens.value[draft.token] = 'confirmed';
    delete borrowEdits.value[draft.token];
    await scrollToEnd();
  }
}

async function cancelAction(token: string) {
  if (draftBusy(token)) return;
  const ok = await store.act(token, 'cancel');
  if (ok) {
    actedTokens.value[token] = 'cancelled';
    delete borrowEdits.value[token];
    delete catalogEdits.value[token];
    await scrollToEnd();
  }
}

function catalogEditValue(token: string, field: AgentCatalogFieldView): string {
  return catalogEdits.value[token]?.[field.key] ?? field.value;
}

function setCatalogEdit(token: string, field: AgentCatalogFieldView, value: string) {
  catalogEdits.value[token] = { ...(catalogEdits.value[token] ?? {}), [field.key]: value.slice(0, 2000) };
}

/** 辅助著录预览：未提取到的字段保持为空，不伪造默认值。 */
function catalogHasEdits(draft: AgentCatalogDraftView): boolean {
  if (!draft.token) return false;
  const edits = catalogEdits.value[draft.token];
  if (!edits) return false;
  return draft.fields.some((f) => (edits[f.key] ?? f.value) !== f.value);
}

async function confirmCatalog(draft: AgentCatalogDraftView) {
  const token = draft.token;
  if (!token || !draft.canSave || draftBusy(token)) return;
  const values: Record<string, string> = {};
  for (const f of draft.fields) values[f.key] = catalogEditValue(token, f).trim();
  const ok = await store.act(token, 'confirm', values);
  if (ok) {
    actedTokens.value[token] = 'confirmed';
    delete catalogEdits.value[token];
    await scrollToEnd();
  }
}

/**
 * 业务卡片类回复的补充说明：只如实转述后端给出的 kind，
 * 未确认前绝不显示成「已提交」。
 */
function bizHint(payload: AgentPayload): string {
  if (payload.kind === 'borrow_confirm') return '以下内容尚未提交，需你点击「确认提交」后才会生成借阅申请';
  if (payload.kind === 'borrow_collect') return '已收集的信息先存在服务端待确认草稿里，补齐后仍需你确认才会提交';
  if (payload.kind === 'catalog_preview') return '以下为 AI 建议值，确认保存前不会写入档案数据';
  if (payload.kind === 'target_ask') return '请先确认目标档案，再继续办理';
  return '';
}

/** 草稿状态文案（对应后端 agent_pending_actions 的真实状态）。 */
function draftStatusText(status: string): string {
  if (status === 'pending') return '待确认';
  if (status === 'executed') return '已执行';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return '执行失败';
  if (status === 'none') return '仅预览（不行写）';
  return status;
}

/** 缺失字段的人读名称（只包现有借阅接口的两个真实必填项）。 */
function missingLabel(key: string): string {
  return key === 'purpose' ? '借阅用途' : key === 'days' ? '借阅期限' : key;
}

/** 来源跳转：detailPath 由后端按真实档案 ID 生成，且来源本身已过权限过滤。 */
function openSource(source: AgentSource) {
  if (!source.detailPath) return;
  const target=sourceRoute(source);
  if(target)void router.push(target);
}

/** 第三阶段：从回答引用回到知识图谱对应档案节点（图谱页会按当前用户权限重新过滤可见性）。 */
function locateInGraph(source: AgentSource) {
  if (!source.archiveId) return;
  void router.push({ path: '/knowledge-graph', query: { focus: `archive:${source.archiveId}` } });
}

function locateGraphNode(node: KgGraphNodeView) {
  const route=graphNodeRoute(node);if(route)void router.push(route);
}
function openGraphRelation(citation: AgentGraphCitation) {
  const route=graphEdgeRoute(citation);if(route)void router.push(route);
}
const answerParts=answerCitationParts;
const nodeLabels={category:'分类',archive:'档案',file:'附件',chunk:'正文知识块'};
const expandedSourceGroups = ref<Record<string, boolean>>({});
const expandedRelations = ref<Record<string, boolean>>({});
function sourceGroups(payload: AgentPayload | null | undefined): AgentSourceGroup[] {
  return groupAgentSources(payload?.sources);
}
function previousQuestion(replyIndex: number): string {
  const previous = store.messages[replyIndex - 1];
  return previous?.role === 'user' ? previous.content : '列出档案';
}
function toggleSourceGroup(key: string) {
  expandedSourceGroups.value = { ...expandedSourceGroups.value, [key]: !expandedSourceGroups.value[key] };
}
function openSourceGroup(group: AgentSourceGroup) {
  if (group.sources.length === 1) openSource(group.sources[0]);
  else toggleSourceGroup(group.key);
}
function toggleRelation(key: string) {
  expandedRelations.value = { ...expandedRelations.value, [key]: !expandedRelations.value[key] };
}
function graphCitationNode(citation: AgentGraphCitation, side: 'from' | 'to'): KgGraphNodeView | null {
  const node = side === 'from' ? citation.from : citation.to;
  return node && ['category', 'archive', 'file', 'chunk'].includes(node.type) ? node as KgGraphNodeView : null;
}
function openGraphNode(citation: AgentGraphCitation, side: 'from' | 'to') {
  const node = graphCitationNode(citation, side);
  if (node) { locateGraphNode(node); return; }
  const archiveId = side === 'from' ? citation.fromArchiveId : citation.toArchiveId;
  if (Number.isSafeInteger(archiveId) && (archiveId as number) > 0) {
    void router.push({ path: '/knowledge-graph', query: { focus: `archive:${archiveId}` } });
  }
}
function graphNodeText(citation: AgentGraphCitation, side: 'from' | 'to'): string {
  const node = graphCitationNode(citation, side);
  return node?.label ?? (side === 'from' ? citation.fromTitle : citation.toTitle);
}
function refreshReferences(){if(document.visibilityState==='visible')void store.refreshReferences();}
let referenceTimer: ReturnType<typeof setInterval>;
onMounted(()=>{window.addEventListener('focus',refreshReferences);document.addEventListener('visibilitychange',refreshReferences);
  refreshReferences();referenceTimer=setInterval(refreshReferences,30000);});
onBeforeUnmount(()=>{clearInterval(referenceTimer);window.removeEventListener('focus',refreshReferences);document.removeEventListener('visibilitychange',refreshReferences);});


async function scrollToEnd() {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 复制回答正文（不含卡片/来源等附属内容）；非安全上下文回退到隐藏文本框。 */
async function copyAnswer(msg: AgentMessageView) {
  const text = msg.content?.trim() ?? '';
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) throw new Error('copy failed');
    }
    notifySuccess('已复制回答内容');
  } catch {
    notifyError('复制失败，请手动选择文本复制');
  }
}

/** 重新生成最后一条回复：后端原地替换，历史对话不变。 */
async function regenerateAnswer(msg: AgentMessageView) {
  if (store.sending || store.regeneratingId !== null) return;
  const ok = await store.regenerate(msg.id);
  if (ok) {
    await scrollToEnd();
    return;
  }
  if (store.error) {
    const message = store.error;
    store.error = '';
    notifyError(message);
  }
}

// 消息数量变化（新增用户/回复、切换会话、加载历史）时滚到底部
watch(() => [store.messages.length, store.currentId], () => void scrollToEnd());

/**
 * 第三阶段：消费知识图谱页的交接入口——绑定当前分析范围（上下文条展示），
 * 并把预填问题写入输入框；是否发送、怎么提问都由用户决定（不自动发送）。
 */
function consumeGraphEntry() {
  const entry = store.consumeGraphAsk();
  if (!entry) return;
  input.value = entry.question;
}

onMounted(async () => {
  await Promise.all([store.loadStatus(), store.loadConversations()]);
  consumeGraphEntry();
});

// 已在本页时再次从图谱页点「问 AI」：路由复用组件不重新挂载，靠 watch 接住交接入口
watch(() => store.pendingGraphAsk, (entry) => {
  if (entry) consumeGraphEntry();
});
</script>

<template>
  <div class="agent-root">
    <!-- ===== 左侧会话栏 ===== -->
    <div class="conv-mask" v-if="sidebarOpen" @click="sidebarOpen = false"></div>
    <aside class="conv-panel" :class="{ open: sidebarOpen }">
      <div class="conv-head">
        <span class="conv-brand"><BrandMark :size="20" /> 档案 Agent 助理</span>
      </div>
      <button class="btn btn-primary btn-block new-chat" type="button" @click="newConversation">
        ＋ 新建对话
      </button>
      <div class="conv-list">
        <AppLoading v-if="store.conversationsLoading" text="加载会话…" size="sm" inline />
        <p v-else-if="store.conversations.length === 0" class="conv-empty">
          还没有历史会话，点击上方「新建对话」开始检索档案。
        </p>
        <ul v-else>
          <li
            v-for="conv in store.conversations"
            :key="conv.id"
            :class="{ active: conv.id === store.currentId }"
          >
            <button class="conv-item" type="button" @click="selectConversation(conv.id)">
              <span class="conv-title" :title="conv.title">{{ conv.title }}</span>
              <span class="conv-meta">{{ conv.messageCount }} 条 · {{ fmtTime(conv.updatedAt) }}</span>
            </button>
            <button
              class="conv-del"
              type="button"
              aria-label="删除该会话"
              title="删除会话"
              @click.stop="removeConversation(conv)"
            >
              ✕
            </button>
          </li>
        </ul>
      </div>
    </aside>

    <!-- ===== 右侧对话区 ===== -->
    <section class="chat">
      <header class="chat-bar">
        <button class="chat-menu" type="button" aria-label="打开会话列表" @click="sidebarOpen = true">
          ☰
        </button>
        <div class="chat-title">
          {{ store.currentId ? (store.conversations.find((c) => c.id === store.currentId)?.title ?? '档案 Agent 助理') : '新对话' }}
        </div>
        <div class="chat-ai-flag">
          <span v-if="store.status" class="badge" :class="store.status.aiConfigured ? 'badge-success' : 'badge-muted'">
            {{ store.status.aiConfigured
              ? `当前：${store.status.providerLabel ?? '系统模型'} · ${store.status.model ?? '已启用'}`
              : '规则检索模式' }}
          </span>
          <span
            v-if="store.status?.contentIndexReady && !store.status.contentFts"
            class="badge badge-muted"
            title="当前环境的数据库未启用全文索引，正文检索已降级为关键词匹配，仍能检索但精度与性能略低"
          >
            正文检索：降级匹配
          </span>
          <button class="btn btn-sm ai-settings-trigger" type="button" @click="aiSettingsOpen = true">
            ⚙ AI 设置
          </button>
        </div>
      </header>

      <div class="chat-body" ref="scroller">
        <AppLoading v-if="store.messagesLoading" text="正在恢复历史对话…" />

        <!-- 欢迎区：当前会话无消息且非加载态 -->
        <div v-else-if="showWelcome" class="welcome">
          <div class="welcome-mark"><BrandMark :size="40" /></div>
          <h2 class="welcome-title">你好，我是档案 Agent 助理</h2>
          <p class="welcome-desc">
            我可以帮助你查找档案、了解档案信息，并协助你完成权限范围内的档案业务。
          </p>
          <div class="quick-grid">
            <button
              v-for="card in quickCards"
              :key="card.label"
              class="quick-card"
              type="button"
              @click="pickQuickCard(card)"
            >
              {{ card.label }}
            </button>
          </div>
          <p class="welcome-note text-muted">
            借阅申请、智能辅助著录均需你逐项确认后才写入系统；我不会代为审批、归档或删除，
            也不会让你获得原本没有的权限。
          </p>
        </div>

        <!-- 消息列表 -->
        <div v-else class="messages">
          <template v-for="(msg, index) in store.messages" :key="msg.id">
            <div class="msg" :class="msg.role === 'user' ? 'is-user' : 'is-agent'">
              <div class="msg-avatar" v-if="msg.role !== 'user'"><BrandMark :size="18" /></div>
              <div class="msg-main">
                <div class="bubble" :class="msg.role === 'user' ? 'bubble-user' : 'bubble-agent'">
                  <span class="bubble-text"><template v-for="(part, index) in answerParts(msg.content, msg.payload)" :key="index"><button v-if="part.source" class="citation-link" :title="part.source.fileName + ' · ' + part.source.locator" @click="openSource(part.source)">{{ part.text }}</button><button v-else-if="part.graph" class="citation-link" @click="openGraphRelation(part.graph)">{{ part.text }}</button><template v-else>{{ part.text }}</template></template></span>
                </div>

                <div v-if="msg.payload?.pagination && msg.payload.pagination.totalPages > 1" class="source-notes">
                  <span>第 {{ msg.payload.pagination.page }} / {{ msg.payload.pagination.totalPages }} 页，共 {{ msg.payload.total }} 份</span>
                  <button v-if="msg.payload.pagination.hasMore" class="btn btn-text" :disabled="store.sending" @click="submit(inventoryPage(previousQuestion(index), msg.payload.pagination.page + 1, msg.payload.pagination.pageSize))">下一页</button>
                </div>
                <details v-if="msg.payload?.metadataSources?.length" class="source-block" data-testid="agent-metadata-sources">
                  <summary>档案信息依据 · {{ msg.payload.metadataSources.length }} 条</summary>
                  <p v-for="source in msg.payload.metadataSources" :key="source.ref" class="source-doc-meta">
                    <span class="fragment-ref">[{{ source.ref }}]</span> {{ source.excerpt }}
                  </p>
                </details>

                <!-- 检索结果卡片（仅当回复带有档案载荷时） -->
                <div
                  v-if="msg.payload && msg.payload.items.length > 0"
                  class="result-cards"
                >
                  <div
                    v-for="card in msg.payload.items"
                    :key="card.id"
                    class="arc-card"
                    :class="{ clickable: card.canOpenDetail }"
                    :role="card.canOpenDetail ? 'button' : undefined"
                    :tabindex="card.canOpenDetail ? 0 : undefined"
                    @click="openDetail(card)"
                    @keydown.enter.prevent="openDetail(card)"
                  >
                    <div class="arc-top">
                      <span class="arc-title" :title="card.title">{{ card.title }}</span>
                      <span class="badge" :class="card.status === 'archived' ? 'badge-success' : 'badge-muted'">
                        {{ card.statusLabel }}
                      </span>
                    </div>
                    <div class="arc-fields">
                      <span class="arc-no">档号：{{ card.archiveNo }}</span>
                      <span class="arc-cat">分类：{{ card.categoryPath || card.categoryName }}</span>
                      <span v-if="card.archiveType" class="arc-type">类型：{{ card.archiveType }}</span>
                    </div>
                    <p v-if="card.snippet" class="arc-snippet">{{ card.snippet }}</p>
                    <div class="arc-foot">
                      <span v-if="card.canOpenDetail" class="arc-link">打开对应附件 →</span>
                      <span v-else class="arc-denied">你暂无查看该档案详情的权限</span>
                      <!-- 第三阶段：候选档案上的业务入口（只把真实档号回传给助理重新定位，不传档案 ID） -->
                      <button
                        v-if="msg.payload.targetAsk === 'borrow'"
                        class="btn btn-sm arc-action"
                        type="button"
                        :disabled="store.sending"
                        @click.stop="pickTarget(card, 'borrow')"
                      >
                        申请借阅这一份
                      </button>
                      <button
                        v-else-if="msg.payload.targetAsk === 'catalog'"
                        class="btn btn-sm arc-action"
                        type="button"
                        :disabled="store.sending"
                        @click.stop="pickTarget(card, 'catalog')"
                      >
                        辅助著录这一份
                      </button>
                    </div>
                  </div>
                 <p v-if="msg.payload.total > msg.payload.shown" class="result-more text-muted">
                    共 {{ msg.payload.total }} 条，已展示前 {{ msg.payload.shown }} 条。
                  </p>
                </div>

                <!-- ============ 统一智能检索（第一批）：按档案 / 附件 / 正文 / 分类分组 ============ -->
                <div
                  v-if="msg.payload && msg.payload.kind === 'unified_search' && msg.payload.unified"
                  class="uni-groups"
                >

                  <!-- 档案组 -->
                  <section v-if="msg.payload.unified.scopes.includes('archive')" class="uni-group">
                    <h4 class="uni-head">档案<span class="uni-count">命中 {{ msg.payload.unified.archives.total }} 条</span></h4>
                    <p v-if="!msg.payload.unified.archives.items.length" class="uni-empty text-muted">该范围内没有命中的档案。</p>
                    <div
                      v-for="card in msg.payload.unified.archives.items"
                      :key="'a' + card.id"
                      class="arc-card"
                      :class="{ clickable: card.canOpenDetail }"
                      :role="card.canOpenDetail ? 'button' : undefined"
                      :tabindex="card.canOpenDetail ? 0 : undefined"
                      @click="openDetail(card)"
                      @keydown.enter.prevent="openDetail(card)"
                    >
                      <div class="arc-top">
                        <span class="arc-title" :title="card.title">{{ card.title }}</span>
                        <span class="badge" :class="card.status === 'archived' ? 'badge-success' : 'badge-muted'">{{ card.statusLabel }}</span>
                      </div>
                      <div class="arc-fields">
                        <span class="arc-no">档号：{{ card.archiveNo }}</span>
                        <span class="arc-cat">分类：{{ card.categoryPath || card.categoryName }}</span>
                      </div>
                      <div class="arc-foot">
                        <span v-if="card.canOpenDetail" class="arc-link">打开对应附件 →</span>
                        <span v-else class="arc-denied">你暂无查看该档案详情的权限</span>
                      </div>
                    </div>
                  </section>

                  <!-- 附件组 -->
                  <section v-if="msg.payload.unified.scopes.includes('attachment')" class="uni-group">
                    <h4 class="uni-head">附件<span class="uni-count">命中 {{ msg.payload.unified.attachments.total }} 个</span></h4>
                    <p v-if="!msg.payload.unified.attachments.items.length" class="uni-empty text-muted">该范围内没有命中的附件。</p>
                    <div
                      v-for="att in msg.payload.unified.attachments.items"
                      :key="'f' + att.fileId"
                      class="arc-card"
                      :class="{ clickable: att.canOpenDetail }"
                      :role="att.canOpenDetail ? 'button' : undefined"
                      :tabindex="att.canOpenDetail ? 0 : undefined"
                      @click="openAttachment(att)"
                      @keydown.enter.prevent="openAttachment(att)"
                    >
                      <div class="arc-top">
                        <span class="arc-title" :title="att.fileName">{{ att.fileName }}</span>
                        <span class="badge badge-muted">{{ att.extension || '文件' }}</span>
                      </div>
                      <div class="arc-fields">
                        <span class="arc-no">所属档案：{{ att.archiveTitle }}（{{ att.archiveNo }}）</span>
                        <span class="arc-cat">版本：{{ att.versionNo == null ? '原件（未入版本）' : 'v' + att.versionNo }}</span>
                        <span class="arc-type">大小：{{ formatBytes(att.fileSize) }}</span>
                      </div>
                      <div class="arc-foot">
                        <span v-if="att.canOpenDetail" class="arc-link">进入所属档案详情 →</span>
                        <span v-else class="arc-denied">你暂无查看该附件的权限</span>
                      </div>
                    </div>
                  </section>

                  <!-- 正文组 -->
                  <section v-if="msg.payload.unified.scopes.includes('content')" class="uni-group">
                    <h4 class="uni-head">正文片段<span class="uni-count">命中 {{ msg.payload.unified.contents.total }} 条</span></h4>
                    <p v-if="!msg.payload.unified.contents.items.length" class="uni-empty text-muted">该范围内没有命中的正文片段。</p>
                    <div
                      v-for="src in msg.payload.unified.contents.items"
                      :key="'c' + src.archiveId + '-' + src.fileId + '-' + src.ref"
                      class="src-card"
                      :class="{ clickable: !!src.detailPath }"
                      :role="src.detailPath ? 'button' : undefined"
                      :tabindex="src.detailPath ? 0 : undefined"
                      @click="openSource(src)"
                      @keydown.enter.prevent="openSource(src)"
                    >
                      <div class="src-loc text-muted">《{{ src.archiveTitle }}》· {{ src.fileName }} · {{ src.locator }}</div>
                      <details class="source-excerpt" @click.stop @keydown.stop><summary>查看原文</summary><p class="src-excerpt">{{ src.excerpt }}</p></details>
                    </div>
                  </section>

                  <!-- 分类组 -->
                  <section v-if="msg.payload.unified.scopes.includes('category')" class="uni-group">
                    <h4 class="uni-head">分类<span class="uni-count">命中 {{ msg.payload.unified.categories.total }} 个</span></h4>
                    <p v-if="!msg.payload.unified.categories.items.length" class="uni-empty text-muted">该范围内没有命中的分类。</p>
                    <div v-for="cat in msg.payload.unified.categories.items" :key="'k' + cat.id" class="cat-row">
                      <span class="cat-name">{{ '　'.repeat(cat.depth) }}{{ cat.name }}</span>
                      <span class="cat-code text-muted">编码 {{ cat.pathCode }}</span>
                      <span class="cat-count">档案 {{ cat.archiveCount }} 个</span>
                    </div>
                  </section>

                  <p v-if="msg.payload.unified.restrictedScopes.length" class="uni-note text-muted">
                    以下范围因权限限制未查询：
                    <span v-for="(item, index) in msg.payload.unified.restrictedScopes" :key="item.scope">
                      {{ item.label }}（{{ item.reason }}）<span v-if="index < msg.payload.unified.restrictedScopes.length - 1">；</span>
                    </span>
                  </p>

                  <!-- 借阅记录组 -->
                  <section v-if="msg.payload.unified.scopes.includes('borrow')" class="uni-group">
                    <h4 class="uni-head">
                      借阅记录
                      <span class="uni-count">命中 {{ msg.payload.unified.borrowings.total }} 条 · {{ msg.payload.unified.borrowings.scope === 'review' ? '审核视角' : '本人记录' }}</span>
                    </h4>
                    <p v-if="!msg.payload.unified.borrowings.items.length" class="uni-empty text-muted">该范围内没有可查看的借阅记录。</p>
                    <div
                      v-for="rec in msg.payload.unified.borrowings.items"
                      :key="'ub' + rec.id"
                      class="rec-card"
                      :class="{ clickable: rec.canOpenDetail }"
                      :role="rec.canOpenDetail ? 'button' : undefined"
                      :tabindex="rec.canOpenDetail ? 0 : undefined"
                      @click="openRecord(rec)"
                      @keydown.enter.prevent="openRecord(rec)"
                    >
                      <div class="rec-top">
                        <span class="rec-title">{{ rec.archiveTitle }}</span>
                        <span class="badge" :class="rec.status === 'approved' ? 'badge-success' : 'badge-muted'">{{ rec.statusLabel }}</span>
                      </div>
                      <div class="rec-fields">
                        <span>档号：{{ rec.archiveNo }}</span>
                        <span>申请人：{{ rec.applicantName }}</span>
                        <span>申请时间：{{ rec.createdAt }}</span>
                      </div>
                      <p class="arc-snippet">借阅用途：{{ rec.purpose }} · 期限：{{ rec.days }} 天</p>
                      <p v-if="rec.reviewNote" class="arc-snippet">审核意见：{{ rec.reviewNote }}</p>
                    </div>
                  </section>

                  <!-- 操作审计组：仅管理员会收到真实数据 -->
                  <section v-if="msg.payload.unified.scopes.includes('audit')" class="uni-group">
                    <h4 class="uni-head">操作审计<span class="uni-count">命中 {{ msg.payload.unified.audits.total }} 条</span></h4>
                    <p v-if="!msg.payload.unified.audits.items.length" class="uni-empty text-muted">该时间范围内没有命中的审计记录。</p>
                    <div v-for="audit in msg.payload.unified.audits.items" :key="'au' + audit.id" class="arc-card">
                      <div class="arc-top">
                        <span class="arc-title">{{ audit.actionLabel }} · {{ audit.objectTypeLabel }}</span>
                        <span class="badge" :class="audit.result === 'success' ? 'badge-success' : 'badge-muted'">{{ audit.resultLabel }}</span>
                      </div>
                      <div class="arc-fields">
                        <span>操作人：{{ audit.actorName || '未知' }}（{{ audit.actorRoleLabel }}）</span>
                        <span>时间：{{ audit.createdAt }}</span>
                      </div>
                      <p v-if="audit.objectLabel || audit.objectRef" class="arc-snippet">
                        对象：{{ audit.objectLabel || '原对象已不存在' }}{{ audit.objectRef ? ' · ' + audit.objectRef : '' }}
                      </p>
                      <p v-if="audit.summary" class="arc-snippet">{{ audit.summary }}</p>
                    </div>
                  </section>

                  <!-- 元数据模板组：仅管理员和著录员会收到真实数据 -->
                  <section v-if="msg.payload.unified.scopes.includes('template')" class="uni-group">
                    <h4 class="uni-head">元数据模板<span class="uni-count">命中 {{ msg.payload.unified.templates.total }} 个</span></h4>
                    <p v-if="!msg.payload.unified.templates.items.length" class="uni-empty text-muted">没有找到符合条件的元数据模板或字段。</p>
                    <div v-for="tpl in msg.payload.unified.templates.items" :key="'tp' + tpl.id" class="arc-card">
                      <div class="arc-top">
                        <span class="arc-title">{{ tpl.name }}</span>
                        <span class="badge" :class="tpl.status === 'active' ? 'badge-success' : 'badge-muted'">{{ tpl.statusLabel }}</span>
                      </div>
                      <p v-if="tpl.description" class="arc-snippet">{{ tpl.description }}</p>
                      <div class="arc-fields">
                        <span>字段数：{{ tpl.fieldCount }}</span>
                        <span v-if="tpl.boundCategories.length">绑定分类：{{ tpl.boundCategories.map((c) => c.name).join('、') }}</span>
                      </div>
                      <div v-if="tpl.fields.length" class="arc-fields">
                        <span v-for="field in tpl.fields" :key="field.fieldKey">
                          {{ field.label }}（{{ field.fieldKey }} · {{ field.type }}{{ field.required ? ' · 必填' : '' }}{{ field.active ? '' : ' · 已停用' }}）
                        </span>
                      </div>
                    </div>
                  </section>

                  <!-- 档案统计组：统计口径由 DashboardService 按当前角色生成 -->
                  <section v-if="msg.payload.unified.scopes.includes('stats')" class="uni-group">
                    <h4 class="uni-head">档案统计<span v-if="msg.payload.unified.statistics" class="uni-count">{{ msg.payload.unified.statistics.rangeLabel }}</span></h4>
                    <p v-if="!msg.payload.unified.statistics" class="uni-empty text-muted">当前账号暂时无法获取统计信息。</p>
                    <div v-else class="arc-card">
                      <p class="arc-snippet">{{ msg.payload.unified.statistics.archiveScopeLabel }} · {{ msg.payload.unified.statistics.borrowScopeLabel }}</p>
                      <div class="arc-fields">
                        <span v-for="metric in msg.payload.unified.statistics.metrics" :key="metric.key">
                          {{ metric.label }}：{{ metric.available ? (metric.total ?? '—') + metric.unit : '当前角色不可查看' }}
                          <template v-if="metric.available && metric.period !== null">（本期新增 {{ metric.period }}{{ metric.unit }}）</template>
                        </span>
                      </div>
                      <div class="arc-fields">
                        <span v-for="status in msg.payload.unified.statistics.statuses" :key="status.key">{{ status.label }}：{{ status.count }}</span>
                      </div>
                      <div v-if="msg.payload.unified.statistics.categories.length" class="arc-fields">
                        <span v-for="category in msg.payload.unified.statistics.categories" :key="category.label">{{ category.label }}：{{ category.count }}</span>
                      </div>
                      <p class="arc-snippet" v-if="msg.payload.unified.statistics.borrow.available">
                        借阅统计（{{ msg.payload.unified.statistics.borrow.scopeLabel }}）：共 {{ msg.payload.unified.statistics.borrow.total }} 条，待审核 {{ msg.payload.unified.statistics.borrow.pending }} 条，本期新增 {{ msg.payload.unified.statistics.borrow.periodTotal }} 条
                      </p>
                      <p class="arc-snippet" v-else-if="msg.payload.unified.statistics.borrow.reason">{{ msg.payload.unified.statistics.borrow.reason }}</p>
                      <p class="arc-snippet" v-if="msg.payload.unified.statistics.utilization.available">
                        档案利用：预览 {{ msg.payload.unified.statistics.utilization.previewTotal }} 次，下载 {{ msg.payload.unified.statistics.utilization.downloadTotal }} 次
                      </p>
                      <p class="arc-snippet">{{ msg.payload.unified.statistics.note }}</p>
                    </div>
                  </section>
                </div>

                <!-- ============ 第三阶段：智能借阅申请（待确认草稿） ============ -->
                <div
                  v-if="msg.payload && msg.payload.borrowDraft"
                  class="biz-card"
                  :class="{ 'is-denied': msg.payload.kind === 'borrow_denied' }"
                >
                  <div class="biz-head">
                    <span class="biz-title">
                      {{ msg.payload.borrowDraft.missing.length > 0 ? '借阅申请信息（待补充）' : '待确认的借阅申请' }}
                    </span>
                    <span class="badge" :class="msg.payload.borrowDraft.status === 'executed' ? 'badge-success' : 'badge-muted'">
                      {{ draftStatusText(msg.payload.borrowDraft.status) }}
                    </span>
                  </div>
                  <dl class="biz-fields">
                    <dt>待借阅档案</dt>
                    <dd>{{ msg.payload.borrowDraft.archiveTitle }}</dd>
                    <dt>档案编号</dt>
                    <dd>{{ msg.payload.borrowDraft.archiveNo }}</dd>
                    <dt>借阅用途</dt>
                    <dd>
                      <textarea
                        class="biz-input"
                        rows="2"
                        maxlength="500"
                        placeholder="请填写借阅用途（必填，不超过 500 字）"
                        :disabled="draftBusy(msg.payload.borrowDraft.token)"
                        :value="editPurpose(msg.payload.borrowDraft)"
                        @input="setPurpose(msg.payload.borrowDraft.token, ($event.target as HTMLTextAreaElement).value)"
                      ></textarea>
                    </dd>
                    <dt>借阅期限</dt>
                    <dd>
                      <input
                        class="biz-input biz-input-sm"
                        type="text"
                        inputmode="numeric"
                        placeholder="1-90"
                        :disabled="draftBusy(msg.payload.borrowDraft.token)"
                        :value="editDays(msg.payload.borrowDraft)"
                        @input="setDays(msg.payload.borrowDraft.token, ($event.target as HTMLInputElement).value)"
                      />
                      <span class="biz-unit">天</span>
                    </dd>
                    <dt>申请人</dt>
                    <dd>
                      {{ msg.payload.borrowDraft.applicantName }}
                      <span class="text-muted">（{{ msg.payload.borrowDraft.applicantRoleLabel }}，身份取自服务端会话）</span>
                    </dd>
                  </dl>
                  <p v-if="msg.payload.borrowDraft.missing.length > 0" class="biz-warn">
                    还缺：{{ msg.payload.borrowDraft.missing.map(missingLabel).join('、') }}。直接在下方回复即可补充，尚未提交任何申请。
                  </p>
                  <div class="biz-actions" v-if="msg.payload.borrowDraft.status === 'pending'">
                    <template v-if="actedTokens[msg.payload.borrowDraft.token]">
                      <span class="badge badge-muted">
                        本卡片{{ actedTokens[msg.payload.borrowDraft.token] === 'confirmed' ? '已确认' : '已取消' }}，请查看下方最新回复
                      </span>
                    </template>
                    <template v-else>
                      <button
                        class="btn btn-primary btn-sm"
                        type="button"
                        :disabled="!borrowCanConfirm(msg.payload.borrowDraft) || draftBusy(msg.payload.borrowDraft.token)"
                        @click="confirmBorrow(msg.payload.borrowDraft)"
                      >
                        {{ store.actionToken === msg.payload.borrowDraft.token ? '提交中…' : '确认提交' }}
                      </button>
                      <button
                        class="btn btn-sm"
                        type="button"
                        :disabled="draftBusy(msg.payload.borrowDraft.token)"
                        @click="cancelAction(msg.payload.borrowDraft.token)"
                      >
                        取消申请
                      </button>
                    </template>
                  </div>
                  <p class="biz-safe text-muted">
                    只有点击「确认提交」才会调用借阅申请接口；申请内容以服务端保存的草稿为准，重复点击不会重复提交。
                  </p>
                </div>

                <!-- ============ 第三阶段：借阅进度 / 记录列表（真实状态与时间） ============ -->
                <div
                  v-if="msg.payload && (msg.payload.borrowRecords?.length ?? 0) > 0"
                  class="record-list"
                >
                  <p class="record-head">
                    借阅记录（{{ msg.payload.borrowRecords!.length }} 条·{{
                      msg.payload.borrowScope === 'review' ? '审核视角（按现有角色权限）' : '本人申请'
                    }}）
                  </p>
                  <div
                    v-for="rec in msg.payload.borrowRecords"
                    :key="rec.id"
                    class="rec-card"
                    :class="{ clickable: rec.canOpenDetail }"
                    :role="rec.canOpenDetail ? 'button' : undefined"
                    :tabindex="rec.canOpenDetail ? 0 : undefined"
                    @click="openRecord(rec)"
                    @keydown.enter.prevent="openRecord(rec)"
                  >
                    <div class="rec-top">
                      <span class="rec-title" :title="rec.archiveTitle">{{ rec.archiveTitle }}</span>
                      <span class="badge" :class="borrowBadgeClass(rec.status)">{{ rec.statusLabel }}</span>
                    </div>
                    <div class="rec-fields">
                      <span>申请编号：#{{ rec.id }}</span>
                      <span>档号：{{ rec.archiveNo }}</span>
                      <span>申请时间：{{ fmtDateTime(rec.createdAt) }}</span>
                      <span>期限：{{ rec.days }} 天</span>
                      <span v-if="rec.dueAt">应归还：{{ fmtDateTime(rec.dueAt) }}</span>
                      <span v-if="rec.startAt">借阅开始：{{ fmtDateTime(rec.startAt) }}</span>
                    </div>
                    <p class="rec-purpose">用途：{{ rec.purpose }}</p>
                    <p v-if="rec.reviewerName || rec.reviewedAt || rec.reviewNote" class="rec-review">
                      审核：{{ rec.reviewerName || '—' }}
                      <span v-if="rec.reviewedAt"> · {{ fmtDateTime(rec.reviewedAt) }}</span>
                      <span v-if="rec.reviewNote"> · 意见：{{ rec.reviewNote }}</span>
                    </p>
                    <div class="rec-foot">
                      <span v-if="rec.canOpenDetail" class="arc-link">打开对应附件 →</span>
                      <span v-else class="arc-denied">该记录无可跳转的详情入口</span>
                      <span v-if="rec.canReturn" class="rec-return">可归还：请到「我的借阅」页操作</span>
                    </div>
                  </div>
                  <div class="biz-actions">
                    <button class="btn btn-sm" type="button" @click="goBorrowPage(msg.payload.borrowScope === 'review' ? 'review' : 'mine')">
                      {{ msg.payload.borrowScope === 'review' ? '前往借阅管理' : '前往我的借阅' }}
                    </button>
                  </div>
                </div>

                <!-- ============ 第三阶段：智能辅助著录预览（可编辑 + 确认后才保存） ============ -->
                <div v-if="msg.payload && msg.payload.catalogDraft" class="biz-card">
                  <div class="biz-head">
                    <span class="biz-title">智能辅助著录预览</span>
                    <span class="badge" :class="msg.payload.catalogDraft.canSave ? 'badge-muted' : 'badge-danger'">
                      {{ msg.payload.catalogDraft.mode === 'update' ? '编辑现有档案' : '新建草稿档案' }}
                    </span>
                    <span class="badge badge-muted">{{ draftStatusText(msg.payload.catalogDraft.status) }}</span>
                  </div>
                  <div class="rec-fields">
                    <span v-if="msg.payload.catalogDraft.mode === 'update'">目标档案：{{ msg.payload.catalogDraft.archiveTitle }}</span>
                    <span>档号：{{ msg.payload.catalogDraft.archiveNo || '（新建档时由系统生成）' }}</span>
                    <span>分类：{{ msg.payload.catalogDraft.categoryName }}</span>
                  </div>
                  <div class="cat-fields">
                    <div v-for="f in msg.payload.catalogDraft.fields" :key="f.key" class="cat-field">
                      <div class="cat-label">
                        <span>{{ f.label }}</span>
                        <span v-if="f.required" class="cat-req">必填</span>
                        <span class="cat-tag">{{ f.fixed ? '固定字段' : '模板信息项' }}</span>
                      </div>
                      <input
                        class="biz-input"
                        :placeholder="f.hasValue ? '' : '未识别到（保持为空，可手动补充）'"
                        :disabled="draftBusy(msg.payload.catalogDraft.token)"
                        :value="catalogEditValue(msg.payload.catalogDraft.token!, f)"
                        @input="setCatalogEdit(msg.payload.catalogDraft.token!, f, ($event.target as HTMLInputElement).value)"
                      />
                      <p v-if="f.original" class="cat-orig">现有值：{{ f.original }}</p>
                      <p v-if="f.evidenceText" class="cat-evidence">
                        原文依据<span v-if="f.evidenceRef">（{{ f.evidenceRef }}）</span>：{{ f.evidenceText }}
                        <span v-if="f.locator" class="text-muted">（{{ f.locator }}）</span>
                      </p>
                      <p v-else class="cat-none text-muted">未识别到原文依据，因此不预填。</p>
                    </div>
                  </div>
                  <div v-if="msg.payload.catalogDraft.unmapped.length > 0" class="cat-unmapped">
                    <p class="source-head">正文里识别到、但现有系统暂无对应字段的信息（仅展示，不写入）：</p>
                    <p v-for="(u, i) in msg.payload.catalogDraft.unmapped" :key="i" class="note-line">
                      {{ u.label }}：{{ u.value }}
                      <span v-if="u.evidenceText" class="text-muted">（依据{{ u.evidenceRef ? ' ' + u.evidenceRef : '' }}：{{ u.evidenceText }}）</span>
                    </p>
                  </div>
                  <div v-if="msg.payload.catalogDraft.missingRequired.length > 0" class="biz-warn">
                    必填项仍为空：{{ msg.payload.catalogDraft.missingRequired.join('、') }}，请补充后再确认。
                  </div>
                  <div class="biz-actions" v-if="msg.payload.catalogDraft.status === 'pending'">
                    <template v-if="msg.payload.catalogDraft.token && actedTokens[msg.payload.catalogDraft.token]">
                      <span class="badge badge-muted">
                        本预览{{ actedTokens[msg.payload.catalogDraft.token] === 'confirmed' ? '已确认' : '已取消' }}，请查看下方最新回复
                      </span>
                    </template>
                    <template v-else>
                      <button
                        class="btn btn-primary btn-sm"
                        type="button"
                        :disabled="!msg.payload.catalogDraft.canSave || draftBusy(msg.payload.catalogDraft.token)"
                        @click="confirmCatalog(msg.payload.catalogDraft)"
                      >
                        {{ store.actionToken === msg.payload.catalogDraft.token ? '保存中…' : '确认保存著录信息' }}
                      </button>
                      <button
                        v-if="msg.payload.catalogDraft.token"
                        class="btn btn-sm"
                        type="button"
                        :disabled="draftBusy(msg.payload.catalogDraft.token)"
                        @click="cancelAction(msg.payload.catalogDraft.token!)"
                      >
                        取消
                      </button>
                      <span v-if="msg.payload.catalogDraft.saveBlockedReason" class="biz-blocked">
                        {{ msg.payload.catalogDraft.saveBlockedReason }}
                      </span>
                      <span v-else-if="catalogHasEdits(msg.payload.catalogDraft)" class="text-muted">
                        已修改部分字段，确认后才写入
                      </span>
                    </template>
                  </div>
                  <p class="biz-safe text-muted">
                    未确认不会写入任何数据；已归档档案不会被覆盖，也不会绕过归档只读规则。
                  </p>
                </div>

                <!-- ============ 第三阶段：业务办理结果（成功/失败均如实展示） ============ -->
                <div
                  v-if="msg.payload && msg.payload.action"
                  class="biz-card"
                  :class="msg.payload.action.ok ? 'is-ok' : 'is-fail'"
                >
                  <div class="biz-head">
                    <span class="biz-title">{{ msg.payload.action.ok ? '业务办理结果' : '业务办理未完成' }}</span>
                    <span class="badge" :class="msg.payload.action.ok ? 'badge-success' : 'badge-danger'">
                      {{ msg.payload.action.ok ? (msg.payload.action.replayed ? '已存在（未重复提交）' : '已完成') : '未成功' }}
                    </span>
                  </div>
                  <p class="biz-msg">{{ msg.payload.action.message }}</p>
                  <p v-if="msg.payload.action.nextStep" class="biz-next">{{ msg.payload.action.nextStep }}</p>
                  <div v-if="msg.payload.action.borrow" class="rec-fields">
                    <span>申请编号：#{{ msg.payload.action.borrow.id }}</span>
                    <span>档号：{{ msg.payload.action.borrow.archiveNo }}</span>
                    <span>状态：{{ msg.payload.action.borrow.statusLabel }}</span>
                    <span>申请时间：{{ fmtDateTime(msg.payload.action.borrow.createdAt) }}</span>
                  </div>
                  <div class="biz-actions">
                    <button
                      v-if="msg.payload.action.archive"
                      class="btn btn-sm"
                      type="button"
                      @click="router.push(msg.payload.action.archive!.detailPath)"
                    >
                      打开对应附件 →
                    </button>
                    <button
                      v-if="msg.payload.action.borrow"
                      class="btn btn-sm"
                      type="button"
                      @click="goBorrowPage('mine')"
                    >
                      查看我的借阅
                    </button>
                  </div>
                </div>

                <!-- 正文问答：按档案/附件/版本归并的来源入口；默认折叠，展开后才显示引用片段。 -->
                <details
                  v-if="msg.payload && sourceGroups(msg.payload).length > 0"
                  class="source-block" data-testid="agent-sources"
                >
                  <summary>参考来源 · {{ sourceGroups(msg.payload).length }} 份文档</summary>
                  <template v-if="sourceGroups(msg.payload).length">
                    <p class="source-head">回答依据</p>
                    <div v-for="group in sourceGroups(msg.payload)" :key="group.key" class="source-doc" data-testid="agent-source-group">
                      <div class="source-doc-row">
                        <button type="button" class="source-doc-title" :title="group.fileName" @click="openSourceGroup(group)">{{ group.fileName }}</button>
                        <span class="source-doc-badge" :title="group.refs.join(' ')">{{ group.refs.slice(0, 3).join(' ') }}{{ group.refs.length > 3 ? ' …' : '' }}</span>
                        <button type="button" class="source-doc-toggle" :aria-expanded="!!expandedSourceGroups[group.key]" @click="toggleSourceGroup(group.key)">
                          {{ expandedSourceGroups[group.key] ? '收起引用' : '查看引用内容' }}
                        </button>
                      </div>
                      <p class="source-doc-meta" :title="group.archiveTitle">{{ group.archiveTitle }} · 档号 {{ group.archiveNo }} · {{ group.versionNo == null ? '上传原件' : 'v' + group.versionNo }}</p>
                      <div v-if="expandedSourceGroups[group.key]" class="source-fragments">
                        <button v-for="src in group.sources" :key="src.ref" type="button" class="source-fragment" :title="src.locator" @click="openSource(src)">
                          <span class="fragment-ref">[{{ src.ref }}]</span>
                          <span class="fragment-loc">{{ src.locator }}</span>
                          <span class="fragment-text">{{ src.excerpt.length > 160 ? src.excerpt.slice(0, 160) + '…' : src.excerpt }}</span>
                        </button>
                      </div>
                      <div class="source-doc-actions">
                        <button type="button" class="btn btn-text" @click="openSource(group.sources[0])">查看原文 →</button>
                        <button type="button" class="btn btn-text" data-testid="agent-locate-graph" @click="locateInGraph(group.sources[0])">在图谱中定位 →</button>
                      </div>
                    </div>
                  </template>
                </details>

                <!-- 图谱关系：默认只显示本轮实际引用的节点标签和关系路径，点击关系才展开依据。 -->
                <details v-if="msg.payload?.graphCitations?.length" class="graph-citation-block" data-testid="agent-graph-citations">
                  <summary>图谱引用 · {{ msg.payload.graphCitations.length }} 条</summary>
                  <div class="graph-citation-list">
                    <div v-for="citation in msg.payload.graphCitations" :key="citation.ref" class="graph-citation-row">
                      <div class="graph-citation-line">
                        <span class="graph-caption">图谱引用</span>
                        <span class="graph-ref">[{{ citation.ref }}]</span>
                        <button type="button" class="graph-node-chip" :title="graphNodeText(citation, 'from')" @click="openGraphNode(citation, 'from')">{{ graphNodeText(citation, 'from') }}</button>
                        <button type="button" class="graph-node-chip" :title="graphNodeText(citation, 'to')" @click="openGraphNode(citation, 'to')">{{ graphNodeText(citation, 'to') }}</button>
                      </div>
                      <div class="graph-citation-line">
                        <span class="graph-caption">关系依据</span>
                        <button type="button" class="graph-node-chip" :title="graphNodeText(citation, 'from')" @click="openGraphNode(citation, 'from')">{{ graphNodeText(citation, 'from') }}</button>
                        <span class="graph-arrow">→</span>
                        <button type="button" class="graph-relation-chip" data-testid="agent-graph-relation" :aria-expanded="!!expandedRelations[citation.ref]" @click="toggleRelation(citation.ref)">{{ citation.relationLabel }}</button>
                        <span class="graph-arrow">→</span>
                        <button type="button" class="graph-node-chip" :title="graphNodeText(citation, 'to')" @click="openGraphNode(citation, 'to')">{{ graphNodeText(citation, 'to') }}</button>
                      </div>
                      <div v-if="expandedRelations[citation.ref]" class="graph-citation-detail" data-testid="agent-graph-detail">
                        <p class="graph-citation-basis">{{ citation.basisLabel }}</p>
                        <p class="graph-citation-explanation">{{ citation.explanation }}</p>
                        <p v-if="citation.caveat && !citation.explanation.includes(citation.caveat)" class="graph-citation-caveat">{{ citation.caveat }}</p>
                        <details v-if="citation.evidence" data-testid="agent-graph-evidence">
                          <summary>查看关联依据</summary>
                          <p v-for="row in graphEvidenceRows(citation.evidence)" :key="row.label" class="graph-citation-explanation">{{ row.label }}：{{ row.value }}</p>
                          <div class="graph-citation-path">
                            <button v-for="node in citation.supportingNodes ?? []" :key="node.key" type="button" class="graph-node-chip" :data-node-key="node.key" :title="node.label" @click="locateGraphNode(node)">{{ node.type === 'chunk' ? (node.facts.fileName || node.label) + ' · ' + (node.facts.locator || '正文') : node.label }} · {{ nodeLabels[node.type] }}</button>
                          </div>
                        </details>
                        <button type="button" class="btn btn-text" @click="openGraphRelation(citation)">查看关系详情与原文 →</button>
                      </div>
                    </div>
                  </div>
                </details>

                <!-- 第三阶段：不阻断流程但必须如实告知的提示（如作废旧草稿、已归档转新建等） -->
                <div v-if="msg.payload && (msg.payload.notices?.length ?? 0) > 0" class="source-notes">
                  <p v-for="(n, i) in msg.payload.notices" :key="i" class="note-line">
                    · {{ n }}
                  </p>
                </div>

                <!-- 业务卡片的确认状态说明（未确认一律不得表现为已提交） -->
                <p v-if="msg.payload && bizHint(msg.payload)" class="biz-hint text-muted">
                  {{ bizHint(msg.payload) }}
                </p>

                <!-- 无法回答 / 查无结果 / 需补充信息：默认 3 条可点击提示语（参考豆包样式与点击逻辑） -->
                <div
                  v-if="showAnswerSuggestions(msg, index)"
                  class="suggestion-list"
                  data-testid="agent-suggestions"
                >
                  <button
                    v-for="suggestion in answerSuggestions(msg)"
                    :key="suggestion"
                    type="button"
                    class="suggestion-item"
                    :disabled="store.sending || store.regeneratingId !== null"
                    @click="pickSuggestion(suggestion)"
                  >
                    <span class="suggestion-text">{{ suggestion }}</span>
                    <span class="suggestion-arrow" aria-hidden="true">→</span>
                  </button>
                </div>

                <!-- 空结果 / 能力边界等状态：无卡片时以文本呈现（content 已含说明） -->
                <div class="msg-foot text-muted">
                  <div v-if="msg.role === 'assistant'" class="msg-actions">
                    <button
                      class="msg-action"
                      type="button"
                      title="复制回答"
                      aria-label="复制回答"
                      @click="copyAnswer(msg)"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
                    </button>
                    <button
                      v-if="index === store.messages.length - 1 && index > 0 && store.messages[index - 1].role === 'user'"
                      class="msg-action"
                      :class="{ loading: store.regeneratingId === msg.id }"
                      type="button"
                      title="重新生成"
                      aria-label="重新生成"
                      :disabled="store.sending || store.regeneratingId !== null"
                      @click="regenerateAnswer(msg)"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></svg>
                    </button>
                  </div>
                  <span class="msg-time">{{ fmtTime(msg.createdAt) }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- Agent 实时查询路径：阶段状态由后端实际执行过程更新。 -->
          <div class="msg is-agent" v-if="store.progress && (store.sending || store.regeneratingId !== null)">
            <div class="msg-avatar"><BrandMark :size="18" /></div>
            <div class="msg-main progress-msg-main">
              <section class="agent-progress-card" role="status" aria-live="polite" data-testid="agent-progress">
                <header class="agent-progress-head">
                  <strong>正在为你查询，请稍候</strong>
                  <span class="agent-progress-path-label">查询路径</span>
                </header>
                <ol class="agent-progress-list">
                  <li
                    v-for="step in progressSteps"
                    :key="step.id"
                    class="agent-progress-item"
                    :class="'is-' + progressStatus(step.id)"
                    :data-progress-step="step.id"
                  >
                    <span class="agent-progress-node" aria-hidden="true">
                      <svg v-if="progressStatus(step.id) === 'completed' || progressStatus(step.id) === 'empty'" viewBox="0 0 16 16" fill="none">
                        <path d="m3.5 8 3 3 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                      <span v-else-if="progressStatus(step.id) === 'running'" class="agent-progress-spinner"></span>
                      <span v-else class="agent-progress-node-dot"></span>
                    </span>
                    <span class="agent-progress-copy">
                      <strong>{{ step.label }}</strong>
                      <small>{{ progressDescription(step.id, progressStatus(step.id)) }}</small>
                    </span>
                    <span v-if="progressStatus(step.id) === 'running'" class="agent-progress-state">处理中</span>
                    <span v-else-if="progressStatus(step.id) === 'failed'" class="agent-progress-state is-failed">需重试</span>
                  </li>
                </ol>
              </section>
            </div>
          </div>
        </div>
      </div>

      <!-- 错误提示 + 重试（输入内容保留，可直接再发） -->
      <div class="chat-error" v-if="store.error">
        <span>{{ store.error }}</span>
        <button class="btn btn-sm" type="button" :disabled="store.sending" @click="onSend">重试</button>
      </div>

      <!-- 第三阶段：当前分析范围（来自知识图谱选中节点/关系，后端已复核；只作检索线索，不代表授权） -->
      <div v-if="store.graphContext" class="graph-context-bar" data-testid="agent-graph-context">
        <span class="gc-label">当前分析档案范围：{{ store.graphLabel }}</span>
        <button class="btn btn-sm gc-clear" type="button" data-testid="agent-graph-clear" @click="store.clearGraphContext()">解除绑定</button>
      </div>

      <!-- ===== 底部输入区 ===== -->
      <div class="composer">
        <textarea
          v-model="input"
          class="composer-input"
          rows="1"
          :maxlength="MAX_INPUT"
          placeholder="问我任意档案问题，例如「查找采购验收相关的档案」「档号 WS-2026-000007」"
          @keydown="onKeydown"
        ></textarea>
        <button
          v-if="store.sending || store.regeneratingId !== null"
          class="btn stop-btn"
          type="button"
          title="停止生成"
          aria-label="停止生成"
          @click="onStop"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
          </svg>
        </button>
        <button v-else class="btn btn-primary send-btn" type="button" :disabled="!canSend" @click="onSend">
          发送
        </button>
      </div>
      <p class="composer-hint text-muted">Enter 发送 · Shift+Enter 换行</p>
    </section>
    <AgentAiSettingsDialog :open="aiSettingsOpen" @close="aiSettingsOpen = false" @saved="onAiSettingsSaved" />
  </div>
</template>

<style scoped>
.graph-context-bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 12px 6px; padding:6px 12px; border:1px dashed var(--color-primary,#165dff); border-radius:8px; background:var(--color-primary-soft, rgba(22,93,255,.06)); font-size:12px; }
.graph-context-bar .gc-label { font-weight:600; color:var(--text-title,#1d2129); }
.graph-context-bar .gc-clear { margin-left:auto; flex:none; }

.agent-root {
  display: flex;
  gap: 0;
  height: calc(100vh - 104px);
  min-height: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

/* ===== 会话栏 ===== */
.conv-panel {
  width: 260px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-light);
  background: #fbfcfe;
  padding: 14px 12px;
  min-height: 0;
}
.conv-head { padding: 4px 6px 12px; }
.conv-brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: var(--text-title); }
.new-chat { margin-bottom: 12px; }
.conv-list { flex: 1; overflow-y: auto; min-height: 0; }
.conv-empty { font-size: 13px; color: var(--text-muted); padding: 8px 6px; line-height: 1.7; }
.conv-list ul { list-style: none; margin: 0; padding: 0; }
.conv-list li {
  position: relative;
  display: flex;
  align-items: stretch;
  border-radius: var(--radius-control);
  margin-bottom: 4px;
}
.conv-list li.active { background: var(--color-primary-soft); }
.conv-item {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 28px 9px 12px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  border-radius: var(--radius-control);
}
.conv-item:hover { background: rgba(22, 93, 255, 0.06); }
.conv-title {
  font-size: 14px;
  color: var(--text-title);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-list li.active .conv-title { color: var(--color-primary); }
.conv-meta { font-size: 12px; color: var(--text-muted); }
.conv-del {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  opacity: 0;
}
.conv-list li:hover .conv-del,
.conv-list li.active .conv-del { opacity: 1; }
.conv-del:hover { color: var(--color-danger); background: rgba(245, 63, 63, 0.08); }

/* ===== 对话区 ===== */
.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.chat-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-light);
}
.chat-menu { display: none; }
.chat-title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-ai-flag { flex: none; display: flex; align-items: center; gap: 6px; }
.ai-settings-trigger { white-space: nowrap; }

.chat-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 24px 20px;
  -webkit-overflow-scrolling: touch;
}

/* 欢迎区 */
.welcome {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 0;
  text-align: center;
}
.welcome-mark { display: flex; justify-content: center; margin-bottom: 12px; }
.welcome-title { font-size: 22px; margin-bottom: 8px; }
.welcome-desc { color: var(--text-body); margin: 0 auto 22px; max-width: 560px; }
.quick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 1fr;
  gap: 12px;
  max-width: 560px;
  margin: 0 auto 20px;
}
.quick-card {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fff;
  color: var(--text-body);
  font-size: 14px;
  cursor: pointer;
  text-align: center;
  transition: all 0.15s;
}
.quick-card:hover { border-color: var(--color-primary); color: var(--color-primary); box-shadow: var(--shadow-card-hover); }
.welcome-note { max-width: 560px; margin: 0 auto; line-height: 1.7; }

/* 消息 */
.messages { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.msg { display: flex; gap: 10px; }
.msg.is-user { flex-direction: row-reverse; }
.msg-avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.msg-main { min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 8px; }
.msg.is-user .msg-main { align-items: flex-end; }
.bubble {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.7;
  max-width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.bubble-text { white-space: pre-line; }
.bubble-user { background: var(--color-primary); color: #fff; border-top-right-radius: 4px; }
.bubble-agent { background: #f2f3f5; color: var(--text-title); border-top-left-radius: 4px; }
.typing { display: flex; gap: 4px; align-items: center; }
.typing .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-muted);
  animation: blink 1.2s infinite ease-in-out;
}
.typing .dot:nth-child(2) { animation-delay: 0.2s; }
.typing .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

/* 长耗时 Agent 查询路径：阶段状态由服务端真实执行事件驱动。 */
.progress-msg-main { width: min(100%, 600px); }
.agent-progress-card {
  width: 100%;
  padding: 14px 15px;
  border: 1px solid #dce7ff;
  border-radius: 14px;
  background: linear-gradient(145deg, #fff 0%, #f9fbff 100%);
  box-shadow: 0 5px 18px rgba(31, 78, 160, .07);
}
.agent-progress-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.agent-progress-head > strong { color: var(--text-title); font-size: 14px; font-weight: 650; }
.agent-progress-path-label {
  padding: 3px 8px;
  border-radius: 999px;
  background: #eaf2ff;
  color: #2465d9;
  font-size: 11px;
  font-weight: 600;
}
.agent-progress-list { display: flex; flex-direction: column; gap: 3px; margin: 10px 0 0; padding: 0; list-style: none; }
.agent-progress-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 7px 9px;
  border-radius: 10px;
}
.agent-progress-item:not(:last-child)::before {
  position: absolute;
  top: 26px;
  bottom: -10px;
  left: 18px;
  width: 2px;
  background: #e5ebf4;
  content: '';
}
.agent-progress-node {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 2px solid #cbd4e2;
  border-radius: 50%;
  background: #fff;
  color: #fff;
}
.agent-progress-node svg { width: 12px; height: 12px; }
.agent-progress-node-dot { width: 5px; height: 5px; border-radius: 50%; background: #b9c3d1; }
.agent-progress-copy { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; padding-top: 1px; }
.agent-progress-copy > strong { color: var(--text-title); font-size: 13px; font-weight: 620; line-height: 1.45; }
.agent-progress-copy > small { color: var(--text-muted); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.agent-progress-item.is-running { background: #edf4ff; }
.agent-progress-item.is-running::before { background: #c9dcff; }
.agent-progress-item.is-running .agent-progress-node { border-color: #2672f5; box-shadow: 0 0 0 4px rgba(38, 114, 245, .1); }
.agent-progress-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid #cfe0ff;
  border-top-color: #1765ee;
  border-radius: 50%;
  animation: agent-progress-spin .75s linear infinite;
}
.agent-progress-item.is-completed .agent-progress-node,
.agent-progress-item.is-empty .agent-progress-node { border-color: #12b99a; background: #12b99a; }
.agent-progress-item.is-completed::before { background: #9be5d7; }
.agent-progress-item.is-failed { background: #fff5f4; }
.agent-progress-item.is-failed .agent-progress-node { border-color: #e45c52; background: #e45c52; }
.agent-progress-item.is-failed .agent-progress-node-dot { background: #fff; }
.agent-progress-item.is-skipped .agent-progress-copy > strong,
.agent-progress-item.is-skipped .agent-progress-copy > small { color: #9aa5b5; }
.agent-progress-state {
  flex: none;
  align-self: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: #dceaff;
  color: #1c63df;
  font-size: 11px;
  font-weight: 600;
}
.agent-progress-state.is-failed { background: #ffe5e2; color: #c33e35; }
@keyframes agent-progress-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .agent-progress-spinner { animation: none; border-top-color: #1765ee; } }

/* 结果卡片 */
.result-cards { display: flex; flex-direction: column; gap: 10px; width: 100%; }
.arc-card {
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fff;
  padding: 12px 14px;
  box-shadow: var(--shadow-card);
  transition: all 0.15s;
}
.arc-card.clickable { cursor: pointer; }
.arc-card.clickable:hover,
.arc-card.clickable:focus-visible { border-color: var(--color-primary); box-shadow: var(--shadow-card-hover); outline: none; }
.arc-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.arc-title { font-weight: 600; color: var(--text-title); font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arc-fields { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 13px; color: var(--text-body); }
.arc-snippet { margin: 8px 0 0; font-size: 13px; color: var(--text-muted); line-height: 1.6; overflow-wrap: anywhere; }
.arc-foot { margin-top: 8px; }
.arc-link { font-size: 13px; color: var(--color-primary); }
.arc-denied { font-size: 13px; color: var(--text-muted); }
.result-more { padding-left: 2px; }

/* 正文问答来源卡片：只呈现最终回答实际引用的档案依据。 */
.citation-link { border:0; padding:0 3px; background:transparent; color:var(--primary); font:inherit; cursor:pointer; }
.source-block > summary, .source-excerpt > summary { cursor:pointer; font-size:12px; color:var(--text-muted); }
.source-excerpt { margin-top:6px; }
.source-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding-left: 12px;
  border-left: 2px solid var(--border-light);
}
.source-head { font-size: 12px; color: var(--text-muted); margin: 0; }
/* 来源按附件归并：默认只显示文件名一行，展开后才显示片段 */
.source-doc { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border-light); border-radius: 8px; background: #fff; min-width: 0; }
.source-doc-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.source-doc-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; background: transparent; padding: 0; font: inherit; font-size: 13px; font-weight: 600; color: var(--color-primary); text-align: left; cursor: pointer; }
.source-doc-title:hover, .source-doc-title:focus-visible { text-decoration: underline; outline: none; }
.source-doc-badge { flex: none; font-size: 11px; color: var(--color-primary); background: var(--color-primary-soft); border-radius: 999px; padding: 1px 6px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-doc-toggle { flex: none; border: 0; background: transparent; padding: 0; font: inherit; font-size: 11px; color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.source-doc-toggle:hover, .source-doc-toggle:focus-visible { color: var(--color-primary); outline: none; }
.source-doc-meta { margin: 0; font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-fragments { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.source-fragment { display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0; border: 0; border-left: 2px solid var(--color-primary-soft); border-radius: 0 6px 6px 0; background: #fafbfc; padding: 6px 8px; font: inherit; text-align: left; cursor: pointer; }
.source-fragment:hover, .source-fragment:focus-visible { background: var(--color-primary-soft); outline: none; }
.fragment-ref { flex: none; font-size: 11px; font-weight: 600; color: var(--color-primary); }
.fragment-loc { font-size: 11px; color: var(--text-muted); }
.fragment-text { font-size: 12px; line-height: 1.6; color: var(--text-body); overflow-wrap: anywhere; }
.source-doc-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.source-doc-actions .btn { padding: 0; font-size: 12px; }
.retrieved-block { border-left-style: dashed; }
/* 图谱引用：默认只显示节点标签与关系路径 */
.graph-citation-list { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.graph-citation-row { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--border-light); border-radius: 8px; background: #fff; min-width: 0; }
.graph-citation-line { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 6px; min-width: 0; font-size: 12px; }
.graph-caption { flex: none; color: var(--text-muted); }
.graph-ref { flex: none; font-size: 11px; font-weight: 600; color: var(--color-primary); }
.graph-node-chip { max-width: 100%; border: 0; border-radius: 999px; padding: 2px 8px; background: var(--color-primary-soft); color: var(--color-primary); font: inherit; font-size: 12px; cursor: pointer; overflow-wrap: anywhere; text-align: left; }
.graph-node-chip:hover, .graph-node-chip:focus-visible { background: #dbe8ff; outline: none; }
.graph-relation-chip { max-width: 100%; border: 1px solid rgba(22, 93, 255, .28); border-radius: 999px; padding: 2px 8px; background: #fff; color: var(--color-primary); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; overflow-wrap: anywhere; text-align: left; }
.graph-relation-chip:hover, .graph-relation-chip:focus-visible { background: var(--color-primary-soft); outline: none; }
.graph-arrow { flex: none; color: var(--text-muted); }
.graph-citation-detail { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; border-top: 1px dashed var(--border-light); min-width: 0; }
.graph-citation-basis { margin: 0; font-size: 12px; font-weight: 600; color: var(--text-title); }
.graph-citation-block { display:flex; flex-direction:column; gap:8px; margin-top:12px; padding-left:12px; border-left:2px solid var(--border-light); }
.graph-citation-block > summary { cursor:pointer; color:var(--text-muted); font-size:12px; }
.graph-citation-card { padding:10px 12px; border:1px solid var(--border-light); border-radius:var(--radius-control); background:var(--bg-card); display:flex; flex-direction:column; gap:7px; min-width:0; }
.graph-citation-path { display:flex; overflow-wrap:anywhere; flex-wrap:wrap; align-items:center; gap:6px; font-size:13px; }
.graph-node-link { border:0; padding:2px 6px; border-radius:6px; background:var(--color-primary-soft); color:var(--color-primary); font:inherit; cursor:pointer; text-align:left; }
.graph-path-arrow { color:var(--text-muted); }
.graph-relation-label { font-weight:600; color:var(--text-title); }
.graph-citation-meta { display:flex; flex-wrap:wrap; gap:6px 12px; color:var(--text-muted); font-size:11px; }
.graph-citation-explanation,.graph-citation-caveat { margin:0; color:var(--text-body); font-size:12px; line-height:1.6; }
.graph-citation-caveat { color:var(--text-muted); }
.graph-citation-foot { display:flex; flex-wrap:wrap; align-items:center; gap:6px; color:var(--text-muted); font-size:11px; }
.graph-citation-foot .btn { margin-left:auto; }
.src-card {
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fff;
  padding: 10px 12px;
  box-shadow: var(--shadow-card);
  transition: all 0.15s;
}
.src-card.clickable { cursor: pointer; }
.src-card.clickable:hover,
.src-card.clickable:focus-visible { border-color: var(--color-primary); box-shadow: var(--shadow-card-hover); outline: none; }
.src-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.src-ref { flex: none; font-size: 12px; font-weight: 600; color: var(--color-primary); }
.src-title {
  font-weight: 600;
  color: var(--text-title);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.src-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-body);
}
.src-excerpt {
  margin: 8px 0 0;
  padding: 8px 10px;
  background: #fafbfc;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.src-foot { margin-top: 6px; }
.source-notes { display: flex; flex-direction: column; gap: 2px; padding-left: 12px; }
.note-line { font-size: 12px; line-height: 1.6; }

/* 统一智能检索（第一批）：按档案 / 附件 / 正文 / 分类分组展示，条目复用 arc-card / src-card 样式 */
.uni-groups { display: flex; flex-direction: column; gap: 14px; width: 100%; }
.uni-note {
  font-size: 12px;
  line-height: 1.6;
  padding: 6px 10px;
  background: #fafbfc;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
}
.uni-group { display: flex; flex-direction: column; gap: 8px; }
.uni-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
}
.uni-count { font-size: 12px; font-weight: 400; color: var(--text-muted); }
.uni-empty { font-size: 12px; margin: 0; }
.uni-group .src-loc { font-size: 12px; line-height: 1.5; }
.cat-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  padding: 8px 12px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fff;
  box-shadow: var(--shadow-card);
}
.cat-name { font-size: 14px; font-weight: 600; color: var(--text-title); }
.cat-code { font-size: 12px; }
.cat-count { font-size: 12px; color: var(--text-body); }

/* 第三阶段：业务卡片（借阅确认 / 借阅进度 / 辅著预览 / 办理结果）
   所有字段均来自后端真实业务接口，前端不补齐、不推测 */
.biz-card,
.rec-card {
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fff;
  padding: 12px 14px;
  box-shadow: var(--shadow-card);
}
.biz-card.is-ok { border-color: rgba(0, 180, 42, 0.35); }
.biz-card.is-fail,
.biz-card.is-denied { border-color: rgba(245, 63, 63, 0.35); }
.biz-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.biz-title { font-size: 14px; font-weight: 600; color: var(--text-title); }
.biz-fields {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 6px 10px;
  margin: 0;
  font-size: 13px;
}
.biz-fields dt { color: var(--text-muted); }
.biz-fields dd { margin: 0; color: var(--text-title); overflow-wrap: anywhere; }
.biz-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.6;
  color: var(--text-title);
  resize: vertical;
}
.biz-input:focus { border-color: var(--color-primary); outline: none; }
.biz-input:disabled { background: #f7f8fa; color: var(--text-muted); }
.biz-input-sm { width: 96px; display: inline-block; }
.biz-unit { margin-left: 6px; font-size: 13px; color: var(--text-muted); }
.biz-warn {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 125, 0, 0.08);
  color: var(--color-warning);
  font-size: 12px;
  line-height: 1.6;
}
.biz-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-light);
}
.biz-safe { margin: 8px 0 0; font-size: 12px; line-height: 1.6; }
.biz-blocked { font-size: 12px; color: var(--color-danger); }
.biz-msg { margin: 0; font-size: 13px; color: var(--text-title); line-height: 1.7; }
.biz-next { margin: 6px 0 0; font-size: 12px; color: var(--text-body); line-height: 1.6; }
.biz-hint { font-size: 12px; line-height: 1.6; }
.arc-action { margin-left: 10px; }

.record-list { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.record-head { font-size: 12px; color: var(--text-muted); margin: 0; }
.rec-card.clickable { cursor: pointer; }
.rec-card.clickable:hover,
.rec-card.clickable:focus-visible { border-color: var(--color-primary); box-shadow: var(--shadow-card-hover); outline: none; }
.rec-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.rec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rec-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-body);
}
.rec-purpose, .rec-review {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.rec-foot { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 10px; }
.rec-return { font-size: 12px; color: var(--color-warning); }

/* 辅著预览：逐字段展示「AI 建议值 / 现有值 / 原文依据」，三者严格区分 */
.cat-fields { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.cat-field {
  padding: 8px 10px;
  border-radius: 6px;
  background: #fafbfc;
}
.cat-label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--text-title); }
.cat-req { font-size: 11px; color: var(--color-danger); }
.cat-tag { font-size: 11px; color: var(--text-muted); }
.cat-orig { margin: 6px 0 0; font-size: 12px; color: var(--text-muted); }
.cat-evidence {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-body);
  overflow-wrap: anywhere;
}
.cat-none { margin: 6px 0 0; font-size: 12px; }
.cat-unmapped { margin-top: 10px; }

.msg-foot { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.msg.is-user .msg-foot { justify-content: flex-end; }
.ai-note { color: var(--color-warning); }
.msg-time { color: var(--text-muted); }
.msg-actions { display: flex; align-items: center; gap: 2px; }
.msg-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: var(--text-muted); cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.msg-action:hover:not(:disabled) { background: rgba(0, 0, 0, .05); color: var(--text-title); }
.msg-action:disabled { cursor: not-allowed; opacity: .55; }
.msg-action svg { width: 16px; height: 16px; }
.msg-action.loading svg { animation: msg-spin 1s linear infinite; }
@keyframes msg-spin { to { transform: rotate(360deg); } }

/* 无法回答时的可点击提示语（参考豆包：浅灰胶囊、左文右箭头、点击直接追问） */
.suggestion-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 560px;
  max-width: 100%;
  margin-top: 2px;
}
.suggestion-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  min-height: 44px;
  padding: 11px 16px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: #f4f5f7;
  color: var(--text-title);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.suggestion-item:hover:not(:disabled) {
  background: var(--color-primary-soft);
  border-color: rgba(22, 93, 255, .22);
  color: var(--color-primary);
}
.suggestion-item:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.suggestion-item:disabled { cursor: not-allowed; opacity: .55; }
.suggestion-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.suggestion-arrow { flex: none; color: var(--text-muted); font-size: 15px; line-height: 1; }
.suggestion-item:hover:not(:disabled) .suggestion-arrow { color: var(--color-primary); }

/* 错误条 */
.chat-error {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 20px 8px;
  padding: 8px 14px;
  border-radius: var(--radius-control);
  background: rgba(245, 63, 63, 0.08);
  color: var(--color-danger);
  font-size: 13px;
}

/* 输入区 */
.composer {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 20px 4px;
  border-top: 1px solid var(--border-light);
}
.composer-input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid #e5e6eb;
  border-radius: var(--radius-control);
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.6;
  font-family: inherit;
  color: var(--text-title);
  outline: none;
  max-height: 140px;
  overflow-y: auto;
}
.composer-input:focus { border-color: var(--color-primary); }
.send-btn { flex: none; height: 40px; }
.stop-btn {
  flex: none;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fff;
  color: var(--text-title);
  cursor: pointer;
}
.stop-btn:hover { color: var(--color-danger); border-color: var(--color-danger); background: rgba(245, 63, 63, 0.06); }
.stop-btn:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.stop-btn svg { width: 18px; height: 18px; }
.composer-hint { padding: 0 20px 10px; text-align: right; }

.conv-mask { display: none; }

/* ===== 平板：会话栏收成抽屉 ===== */
@media (max-width: 1023px) {
  .agent-root { height: calc(100vh - 96px); }
  .conv-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 130;
    width: min(80vw, 280px);
    transform: translateX(-100%);
    transition: transform 0.24s ease;
    box-shadow: 0 8px 30px rgba(29, 33, 41, 0.18);
  }
  .conv-panel.open { transform: translateX(0); }
  .conv-mask {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 120;
    background: rgba(0, 0, 0, 0.35);
  }
  .chat-menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--border-light);
    border-radius: 8px;
    background: #fff;
    cursor: pointer;
  }
}

/* ===== 手机：保留双列快捷卡、缩小留白 ===== */
@media (max-width: 767px) {
  .agent-root { height: calc(100dvh - 88px); border-radius: 0; border-left: none; border-right: none; }
  .chat-body { padding: 16px 12px; }
  .quick-grid { gap: 10px; }
  .quick-card { padding-inline: 10px; }
  .welcome-title { font-size: 19px; }
  .chat-bar { padding: 10px 12px; }
  .chat-error { margin: 0 12px 8px; }
  .composer { padding: 10px 12px 4px; }
  .composer-hint { padding: 0 12px 8px; }
  .msg-main { max-width: calc(100vw - 88px); }
  .chat-ai-flag { display: flex; margin-left: auto; }
  .chat-ai-flag > .badge { display: none; }
  .ai-settings-trigger { min-height: 32px; padding: 5px 9px; }
  /* 业务卡片在窄屏下改为单列字段，确认按钮满宽便于点按 */
  .biz-fields { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .biz-fields dt { margin-top: 6px; }
  .biz-actions { flex-direction: column; align-items: stretch; }
  .biz-actions .btn { width: 100%; }
  .biz-input-sm { width: 100%; }
  .arc-action { margin-left: 0; width: 100%; }
  .arc-foot { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .source-doc-row { flex-wrap: wrap; row-gap: 2px; }
  .source-doc-title { flex-basis: 100%; }
  .source-doc-badge { max-width: 100%; }
  .source-doc-toggle { margin-left: auto; }
  .graph-citation-line { align-items: flex-start; }
  .graph-node-chip, .graph-relation-chip { overflow-wrap: anywhere; }
}
</style>
