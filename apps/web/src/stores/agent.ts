/**
 * 档案 Agent 助理状态 store（Pinia）。
 * 会话与消息一律以后端返回为准：本地不伪造档案数据、不缓存他人会话。
 * 「新建对话」只清空当前上下文（不落库、不删除历史），首次提问时由后端惰性建会话。
 * 第三阶段：确认/取消业务草稿只上报 token 与用户可改字段，申请内容由服务端保存的草稿决定；
 * 本地维护 actionToken 锁防止重复点击（服务端另有条件抢占与幂等回显）。
 * 知识图谱联动（第三阶段）：图谱页只把「选中了哪个节点/关系」的提示 ID 交给本 store，
 * 随提问一并上送 context；节点真实性与访问权限全部由后端重新查询校验，前端不做授权判断。
 */
import { defineStore } from 'pinia';
import { api, ApiError } from '../api/client.ts';
import type {
  AgentActionResultPayload,
  AgentAskResult,
  AgentConversationView,
  AgentGraphContext,
  AgentMessageView,
  AgentRegenerateResult,
  AgentStatusView,
} from '../types';

/** 图谱页→助理页的一次性交接入口（AgentView 消费后清空）。 */
export interface AgentGraphEntry {
  /** 预填进输入框的自然语言问题（用户可自行改写，不是固定匹配模板）。 */
  question: string;
  /** 展示用范围标签（来自后端已复核的节点详情，不用客户端拼造的名称）。 */
  label: string;
  context: AgentGraphContext;
}

export type AgentProgressStageId = 'understand' | 'archives' | 'content' | 'evidence' | 'answer';
export type AgentProgressStageStatus = 'waiting' | 'running' | 'completed' | 'empty' | 'failed' | 'skipped';
export interface AgentProgressView {
  status: 'running' | 'completed' | 'failed';
  steps: Array<{ id: AgentProgressStageId; status: AgentProgressStageStatus; detail?: string }>;
}

function initialAgentProgress(): AgentProgressView {
  return {
    status: 'running',
    steps: [
      { id: 'understand', status: 'running' },
      { id: 'archives', status: 'waiting' },
      { id: 'content', status: 'waiting' },
      { id: 'evidence', status: 'waiting' },
      { id: 'answer', status: 'waiting' },
    ],
  };
}

function watchAgentProgress(
  requestId: string,
  isActive: () => boolean,
  onProgress: (progress: AgentProgressView) => void,
): () => void {
  let active = true;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  const poll = async () => {
    if (!active) return;
    if (!isActive()) {
      active = false;
      if (revealTimer) clearTimeout(revealTimer);
      if (timer) clearInterval(timer);
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      const progress = await api.get<AgentProgressView>('/agent/progress/' + encodeURIComponent(requestId));
      if (active && isActive()) onProgress(progress);
    } catch {
      // Progress is supplemental UI; a missed poll must never fail the actual Agent request.
    } finally {
      inFlight = false;
    }
  };
  // 仅当请求持续一小段时间才展开进度卡，避免快速查询时闪一下就消失。
  revealTimer = setTimeout(() => {
    if (active && isActive()) onProgress(initialAgentProgress());
  }, 450);
  timer = setInterval(() => void poll(), 500);
  return () => {
    active = false;
    if (revealTimer) clearTimeout(revealTimer);
    if (timer) clearInterval(timer);
  };
}

/** 生成幂等键：同一浏览器不支持 crypto.randomUUID 时回退到时间戳+随机数。 */
function newClientRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `cr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 当前正在进行的提问/重新生成：用户点击「停止生成」时凭幂等键通知后端中止。 */
let activeClientRequestId = '';

/** 兼容旧后端：停止请求可能以 499 返回，此时不应展示为红色错误条。 */
function isCancellationError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 499 || error.message === '已终止本次回答');
}

interface AgentState {
  generation:number;
  referenceRevision:number;
  status: AgentStatusView | null;
  conversations: AgentConversationView[];
  /** 当前会话 id；null 表示「新建对话」尚未落库的空白态。 */
  currentId: number | null;
  messages: AgentMessageView[];
  conversationsLoading: boolean;
  messagesLoading: boolean;
  sending: boolean;
  /** 当前提问的实时进度，只包含面向用户的阶段状态。 */
  progress: AgentProgressView | null;
  /** 正在重新生成的回复消息 id；非 null 时禁止再次点击重新生成。 */
  regeneratingId: number | null;
  /** 正在提交确认/取消的草稿 token；非空时同类按钮全部禁用，防重复点击。 */
  actionToken: string;
  /** 面向用户的中文错误提示（不含堆栈/字段/路径）。 */
  error: string;
  /** 第三阶段：当前绑定的图谱节点/关系上下文（只随提问上送，授权以后端复核为准）。 */
  graphContext: AgentGraphContext | null;
  /** 当前分析范围的人读标签（展示用，同样源自后端已复核的节点详情）。 */
  graphLabel: string;
  /** 图谱页交接入口：待消费的问 AI 请求（进入 AgentView 后填充输入框并绑定上下文）。 */
  pendingGraphAsk: AgentGraphEntry | null;
}

export const useAgentStore = defineStore('agent', {
  state: (): AgentState => ({
    generation:0,
    referenceRevision:0,
    status: null,
    conversations: [],
    currentId: null,
    messages: [],
    conversationsLoading: false,
    messagesLoading: false,
    sending: false,
    progress: null,
    regeneratingId: null,
    actionToken: '',
    error: '',
    graphContext: null,
    graphLabel: '',
    pendingGraphAsk: null,
  }),
  getters: {
    /** 当前会话是否有消息：决定中间区展示欢迎页还是对话。 */
    hasMessages: (s) => s.messages.length > 0,
  },
  actions: {
    errMsg(e: unknown, fallback: string): string {
      return e instanceof ApiError ? e.message : fallback;
    },

    /** 读取 Agent 能力状态（模型是否已配置等），失败不阻断对话（基础检索仍可用）。 */
    async loadStatus(force = false) {
      if (this.status && !force) return;
      try {
        this.status = await api.get<AgentStatusView>('/agent/status');
      } catch {
        // 状态接口异常时给出保守默认：档案检索可用、模型与正文索引状态一律视为不可用
        this.status = {
          aiConfigured: false,
          model: null,
          provider: null,
          providerLabel: null,
          personalAiConfigured: false,
          aiAvailable: false,
          archiveSearchReady: true,
          contentIndexReady: false,
          contentFts: false,
          capabilities: {
            conversationSearch: true,
            archiveDetailLink: true,
            attachmentContentQa: false,
            borrowApply: false,
            borrowProgress: false,
            catalogAssist: false,
            unifiedSearch: false,
            ocr: false,
            autoApproval: false,
            autoArchive: false,
          },
        };
      }
    },

    async loadConversations() {
      this.conversationsLoading = true;
      try {
        const res = await api.get<{ items: AgentConversationView[] }>('/agent/conversations');
        this.conversations = res.items ?? [];
      } catch (e) {
        this.error = this.errMsg(e, '历史会话加载失败，请稍后重试');
      } finally {
        this.conversationsLoading = false;
      }
    },

    /** 切换历史会话：拉取并恢复其消息（含档案卡片载荷）。图谱上下文属于当前提问现场，切会话即解除。 */
    async selectConversation(id: number) {
      // Reload even the current conversation: cached replies never grant access.
      if (this.sending || this.regeneratingId !== null) this.stop();
      const generation=++this.generation;
      this.currentId=id;this.messages=[];this.sending=false;this.progress=null;this.regeneratingId=null;this.actionToken='';
      this.graphContext = null;
      this.graphLabel = '';
      this.pendingGraphAsk = null;
      this.messagesLoading = true;
      this.error = '';
      try {
        const res = await api.get<{ conversation: AgentConversationView; messages: AgentMessageView[] }>(
          `/agent/conversations/${id}`,
        );
        if(generation!==this.generation)return;
        this.currentId = id;
        this.messages = res.messages ?? [];
        // 列表里的标题可能被后端在首次提问后更新，回填保持同步
        const idx = this.conversations.findIndex((c) => c.id === id);
        if (idx >= 0) this.conversations[idx] = res.conversation;
        else this.conversations = [res.conversation, ...this.conversations];
      } catch (e) {
        if(generation===this.generation)this.error = this.errMsg(e, '会话消息加载失败，请稍后重试');
      } finally {
        if(generation===this.generation)this.messagesLoading = false;
      }
    },

    async refreshReferences() {
      if(!this.currentId || this.sending || this.regeneratingId !== null || this.messagesLoading || !this.messages.some(m=>m.payload))return;
      const id=this.currentId,generation=this.generation,revision=++this.referenceRevision,last=this.messages.at(-1)?.id;
      try {
        const res=await api.get<{messages:AgentMessageView[]}>('/agent/conversations/'+id);
        if(this.currentId===id && generation===this.generation && revision===this.referenceRevision && !this.sending && this.regeneratingId === null && this.messages.at(-1)?.id===last){
          this.messages=res.messages ?? [];
          if(this.messages.some(m=>m.payload?.kind==='error')){this.graphContext=null;this.graphLabel='';}
        }
      }catch(e){
        if(this.currentId===id && generation===this.generation && revision===this.referenceRevision && !this.sending && this.regeneratingId === null && this.messages.at(-1)?.id===last){this.messages=[];this.graphContext=null;this.graphLabel='';this.error=this.errMsg(e,'引用权限重新核验失败，请重新加载会话');}
      }
    },

    /** 新建对话：仅清空当前上下文，不删除任何历史记录；图谱绑定作用域一并解除。 */
    newConversation() {
      if (this.sending || this.regeneratingId !== null) this.stop();
      ++this.generation;this.sending=false;this.progress=null;this.regeneratingId=null;this.messagesLoading=false;this.actionToken='';
      this.currentId = null;
      this.messages = [];
      this.error = '';
      this.graphContext = null;
      this.graphLabel = '';
      this.pendingGraphAsk = null;
    },

    async deleteConversation(id: number) {
      try {
        await api.del<{ ok: true }>(`/agent/conversations/${id}`);
        this.conversations = this.conversations.filter((c) => c.id !== id);
        if (this.currentId === id) this.newConversation();
        return true;
      } catch (e) {
        this.error = this.errMsg(e, '删除会话失败，请稍后重试');
        return false;
      }
    },

    /**
     * 发送提问并获取 Agent 回复。
     * - 复用当前会话 id（无则由后端惰性新建，返回后回填）；
     * - 每次调用生成新的 clientRequestId 作为幂等键，配合 sending 锁防重复提交；
     * - 第三阶段：graphContext 只作为「当前选中的图谱节点/关系」提示上送，
     *   后端会重新查询验证真实性与权限（不存在/无权一律拒绝），前端传什么都不被信任。
     * 返回是否成功，供视图决定是否保留输入。
     */
    async ask(question: string, context?: AgentGraphContext): Promise<boolean> {
      const text = question.trim();
      if (!text || this.sending || this.regeneratingId !== null) return false;
      ++this.referenceRevision;
      const generation = this.generation;
      const conversationId = this.currentId;
      this.sending = true;
      this.progress = null;
      this.error = '';
      const clientRequestId = newClientRequestId();
      activeClientRequestId = clientRequestId;
      // 先乐观渲染用户消息；进度卡只显示后端真实阶段状态。
      const optimistic: AgentMessageView = {
        id: -Date.now(),
        role: 'user',
        content: text,
        payload: null,
        createdAt: new Date().toISOString(),
      };
      this.messages = [...this.messages, optimistic];
      const stopPolling = watchAgentProgress(
        clientRequestId,
        () => generation === this.generation && this.sending,
        (progress) => { this.progress = progress; },
      );
      try {
        const res = await api.post<AgentAskResult>('/agent/ask', {
          conversationId: conversationId ?? undefined,
          question: text,
          clientRequestId,
          context: context ?? undefined,
        });
        // The server may have completed (or persisted a stopped exchange) after the
        // user switched to another conversation. Always keep the durable conversation
        // in the sidebar, but never let a late response replace the newly selected chat.
        const conv = res.conversation;
        const idx = this.conversations.findIndex((item) => item.id === conv.id);
        if (idx >= 0) this.conversations[idx] = conv;
        else this.conversations = [conv, ...this.conversations];
        if (generation !== this.generation) return false;
        this.currentId = res.conversationId;
        this.messages = [
          ...this.messages.filter((message) => message.id !== optimistic.id),
          res.userMessage,
          res.reply,
        ];
        return true;
      } catch (e) {
        if (generation !== this.generation) {
          // A cancelled request can finish after the user has navigated away.
          // Refresh only the history list; the active conversation must stay untouched.
          if (isCancellationError(e)) await this.loadConversations();
          return false;
        }
        if (isCancellationError(e)) {
          this.messages = this.messages.filter((message) => message.id !== optimistic.id);
          // 停止后刷新历史列表与当前会话，确保服务端已落库的记录立即出现在左侧记录中。
          await this.loadConversations();
          if (this.currentId) {
            try {
              const res = await api.get<{ messages: AgentMessageView[] }>(`/agent/conversations/${this.currentId}`);
              if (generation === this.generation) this.messages = res.messages ?? [];
            } catch {
              /* 刷新失败不覆盖停止结果，用户仍可从左侧记录重新进入。 */
            }
          }
          return true;
        }
        this.error = this.errMsg(e, '发送失败，请稍后重试');
        this.messages = this.messages.filter((message) => message.id !== optimistic.id);
        return false;
      } finally {
        stopPolling();
        if (activeClientRequestId === clientRequestId) activeClientRequestId = '';
        if (generation === this.generation) {
          this.sending = false;
          this.progress = null;
        }
      }
    },

    /** 用户主动停止当前回答：通知后端停止生成，由后端落库本轮记录并返回，避免出现红色错误条。 */
    stop(): boolean {
      if (!this.sending && this.regeneratingId === null) return false;
      const requestId = activeClientRequestId;
      if (requestId) {
        void api.post<{ ok: true }>('/agent/cancel', { clientRequestId: requestId }).catch(() => {
          /* 请求可能已经自然结束；停止操作本身不应再提示错误。 */
        });
      }
      return true;
    },

    /**
     * 重新生成当前会话的最后一条回复。
     * 后端原地替换该条回复（不追加新的用户消息），前端只更新对应消息，历史保持不变。
     */
    async regenerate(messageId: number): Promise<boolean> {
      if (!this.currentId || !messageId || this.sending || this.regeneratingId !== null) return false;
      const last = this.messages.at(-1);
      const previous = this.messages.at(-2);
      if (!last || last.role !== 'assistant' || last.id !== messageId || previous?.role !== 'user') return false;
      const generation = this.generation;
      const conversationId = this.currentId;
      const clientRequestId = newClientRequestId();
      activeClientRequestId = clientRequestId;
      ++this.referenceRevision;
      this.regeneratingId = messageId;
      this.progress = null;
      this.error = '';
      const stopPolling = watchAgentProgress(
        clientRequestId,
        () => generation === this.generation && this.regeneratingId !== null,
        (progress) => { this.progress = progress; },
      );
      try {
        const res = await api.post<AgentRegenerateResult>('/agent/regenerate', {
          conversationId,
          messageId,
          clientRequestId,
        });
        if (generation !== this.generation) return false;
        this.messages = this.messages.map((message) => (message.id === res.reply.id ? res.reply : message));
        const conv = res.conversation;
        const idx = this.conversations.findIndex((item) => item.id === conv.id);
        if (idx >= 0) this.conversations[idx] = conv;
        return true;
      } catch (e) {
        if (generation !== this.generation) return false;
        if (isCancellationError(e)) return true;
        this.error = this.errMsg(e, '重新生成失败，请稍后重试');
        return false;
      } finally {
        stopPolling();
        if (activeClientRequestId === clientRequestId) activeClientRequestId = '';
        if (generation === this.generation) {
          this.regeneratingId = null;
          this.progress = null;
        }
      }
    },

    /**
     * 第三阶段：知识图谱页的「问 AI / 分析关联 / 基于当前档案继续提问」入口。
     * 只登记交接请求与提示性上下文，不在此处做任何权限判断（后端逐次复核）。
     */
    openFromGraph(entry: AgentGraphEntry) {
      this.graphContext = entry.context;
      this.graphLabel = entry.label;
      this.pendingGraphAsk = entry;
    },

    /** AgentView 消费一次性交接入口（取后即清，避免回到页面重复填充）。 */
    consumeGraphAsk(): AgentGraphEntry | null {
      const entry = this.pendingGraphAsk;
      this.pendingGraphAsk = null;
      return entry;
    },

    /** 用户手动解除当前分析范围（上下文条上的「解除绑定」）。 */
    clearGraphContext() {
      this.graphContext = null;
      this.graphLabel = '';
      this.pendingGraphAsk = null;
    },

    /**
     * 确认提交 / 取消 Agent 待执行业务草稿（借阅申请、辅助著录保存）。
     * - 只传 token + 动作 + 用户在卡片上改过的字段值，不传档案 ID / 申请人 / 权限信息；
     * - actionToken 锁 + 后端条件抢占双重防重复提交；
     * - 成功与否一律以后端回传的真实业务消息为准，本地不伪造结果。
     */
    async act(
      token: string,
      action: 'confirm' | 'cancel',
      values?: Record<string, string>,
    ): Promise<boolean> {
      if (!token || !this.currentId || this.actionToken || this.regeneratingId !== null) return false;
      const generation=this.generation;
      this.actionToken = token;
      this.error = '';
      try {
        const res = await api.post<AgentActionResultPayload>('/agent/action', {
          conversationId: this.currentId,
          token,
          action,
          values,
        });
        if(generation!==this.generation)return false;
        this.messages = [...this.messages, res.reply];
        const conv = res.conversation;
        const idx = this.conversations.findIndex((c) => c.id === conv.id);
        if (idx >= 0) this.conversations[idx] = conv;
        else this.conversations = [conv, ...this.conversations];
        return true;
      } catch (e) {
        if(generation!==this.generation)return false;
        // 失败时不猜测业务结果，只如实提示；用户可重新发起办理
        this.error = this.errMsg(e, action === 'confirm' ? '提交失败，请重试或重新发起办理' : '取消失败，请重试');
        return false;
      } finally {
        if(generation===this.generation)this.actionToken = '';
      }
    },
  },
});
