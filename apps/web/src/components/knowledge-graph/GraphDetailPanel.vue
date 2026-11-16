<script setup lang="ts">
/**
 * 右侧节点详情：按节点类型展示不同字段，全部来自 GET /api/knowledge-graph/nodes/:type/:id。
 * - 「查看原文」复用现有档案详情页；附件预览复用 ArchivePreviewDialog（受控字节流接口）。
 * - 入口显隐依据后端返回的 permissions.canView / canDownload，点击后后端仍会再次判权（不以前端为准）。
 * - 第三阶段：「问 AI / 分析关联 / 基于当前档案继续提问」把当前选中节点（或关系两端）的
 *   提示 ID 交给现有 Agent 助理；真实性与权限由后端重新查询校验，前端不做授权判断。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { sourceRoute, graphEvidenceRows } from '../../lib/agentSource';
import { api, previewUrl } from '../../api/client';
import AppEmpty from '../ui/AppEmpty.vue';
import ArchivePreviewDialog from '../ArchivePreviewDialog.vue';
import { useKnowledgeGraphStore } from '../../stores/knowledgeGraph.ts';
import { useAgentStore } from '../../stores/agent';
import { useAuthStore } from '../../stores/auth';
import { can, fmtSize } from '../../perms';
import { PREVIEW_EXTS } from '../../lib/previewSdk';
import { edgeStyle, nodeStyle } from '../../lib/knowledge-graph/styles.ts';
import type { AgentGraphContext } from '../../types';
import type { JitWordStatus } from '../../types';
import type {
  KgRelationItem,
  KgArchiveDetail,
  KgCategoryDetail,
  KgChunkDetail,
  KgFileDetail,
} from '../../lib/knowledge-graph/types.ts';

const store = useKnowledgeGraphStore();
const agent = useAgentStore();
const auth = useAuthStore();
const router = useRouter();

/** 收起入口由页面控制（桌面端收窄成窄条，移动端关闭抽屉）。 */
const emit = defineEmits<{ collapse: [] }>();

const jitword = ref<JitWordStatus | null>(null);
const previewTarget = ref<{ name: string; extension: string; fileSize: number; routePath: string } | null>(null);

const detail = computed(() => store.detail);
const loading = computed(() => store.detailLoading);

/** 分类详情不含附件与原文入口，因此没有 permissions 字段；其余三类都带后端真实授权结果。 */
const perms = computed(() => {
  const data = detail.value;
  if (!data || data.type === 'category') return null;
  return data.permissions;
});
/** 档案级授权：后端权限判定 ∩ 角色矩阵二次收敛（与档案详情页同口径）。 */
const canViewSource = computed(() => perms.value?.canView === true);
const canDownloadSource = computed(() => perms.value?.canDownload === true && can(auth.user?.role, 'fileDownload'));

const selectedEdge = computed(() => {
  if(store.edgeDetail)return store.edgeDetail.edge;
  const id = store.selectedEdgeId;
  return id == null ? null : store.edges.find((edge) => edge.id === id) ?? null;
});

const relatedItems = computed<KgRelationItem[]>(() => {
  if (store.relations?.items) return store.relations.items;
  const data = detail.value;
  if (!data) return [];
  if (data.type === 'archive') return data.relatedArchives;
  if (data.type === 'chunk') return data.relatedChunks;
  return [];
});

const relationsTitle = computed(() => {
  const data = detail.value;
  if (!data) return '关联';
  if (data.type === 'archive') return '关联档案';
  if (data.type === 'chunk') return '关联知识块';
  return '关联关系';
});

const relationTotal = computed(() => store.relations?.total ?? detail.value?.relationCount ?? 0);

function openRelations(): void {
  const node = store.selectedNode;
  if (node) void store.loadRelations(node);
}

/** 关联依据：把后端证据联合类型转成可读行（不展示内部 meta_json）。 */
const evidenceRows=graphEvidenceRows;

function viewSource(): void {
  const archiveId = archiveIdOfDetail();
  if (!archiveId || !canViewSource.value) return;
  // 档案详情接口会重新判权：无权时返回 403/404，图谱页不放开原文内容
  const data=detail.value;
  if(data?.type==='file' || data?.type==='chunk'){
    const route=sourceRoute({archiveId,fileId:data.type==='file'?data.node.refId:data.file.id,...(data.type==='chunk'?{chunkId:data.node.refId}: {})});
    if(route)void router.push(route);
  }else void router.push('/archives/'+archiveId);
}

function archiveIdOfDetail(): number | null {
  const data = detail.value;
  if (!data) return null;
  if (data.type === 'archive') return data.node.refId;
  if (data.type === 'file') return data.archive.id;
  if (data.type === 'chunk') return data.archive.id;
  return null;
}

async function openFilePreview(file: { id: number; name: string; extension: string; fileSize: number }): Promise<void> {
  if (!canDownloadSource.value || !PREVIEW_EXTS.includes(String(file.extension).toLowerCase())) return;
  if (!jitword.value) {
    try {
      jitword.value = await api.get<JitWordStatus>('/jitword/status');
    } catch {
      jitword.value = { available: false } as JitWordStatus;
    }
  }
  previewTarget.value = {
    name: file.name,
    extension: file.extension,
    fileSize: file.fileSize,
    routePath: previewUrl(file.id),
  };
}

function closePreview(): void {
  previewTarget.value = null;
}

function goChunkNode(key: string): void {
  const node=store.nodeByKey.get(key);
  if(node)void store.locateReference({type:node.type,refId:node.refId});
}

function fmtStatus(status: string): string {
  const labels: Record<string, string> = {
    draft: '草稿',
    archived: '已归档',
    pending: '待提取',
    extracting: '提取中',
    ready: '已索引',
    failed: '提取失败',
    unsupported: '格式不支持',
    empty: '无正文',
  };
  return labels[status] ?? status;
}

/** 关系线上的 basis 代码 → 中文说明（与后端四种依据同源）。 */
function basisLabel(basis: string): string {
  const labels: Record<string, string> = {
    business_structure: '业务结构',
    tfidf_cosine: '正文相似',
    tfidf_cosine_aggregated: '档案级聚合相似',
    metadata_exact_match: '著录字段相同',
  };
  return labels[basis] ?? basis;
}

function loadEdgeEvidence(): void {
  const node = store.selectedNode;
  const edge = selectedEdge.value;
  if (node && edge) void store.selectEdge(edge);
}

// ---------- 第三阶段：问 AI / 分析关联联动 ----------

/** 展示用范围标签：标题/档号都来自后端已复核的节点详情，不在前端拼造。 */
function titledWithNo(title: string, no: string): string {
  return no ? `《${title}》（档号 ${no}）` : `《${title}》`;
}

/**
 * 选中档案/附件/知识块节点后的「问 AI」：把节点类型与 refId 作为上下文提示
 * 交给现有 Agent 助理（不新建聊天）；preset 模式预填一句自然语言问题，
 * 用户可自行改写——后端不依赖固定问句，自然语言理解由模型完成。
 */
function askAi(mode: 'preset' | 'free'): void {
  const data = detail.value;
  if (!data || data.type === 'category') return;
  let context: AgentGraphContext;
  let label: string;
  let question = '';
  if (data.type === 'archive') {
    context = { graphNode: { nodeType: 'archive', refId: data.node.refId } };
    label = `档案${titledWithNo(data.title, data.archiveNo)}`;
    if (mode === 'preset') question = `${label} 主要讲了什么？它与其他哪些档案存在关联？为什么会产生关联？`;
  } else if (data.type === 'file') {
    context = { graphNode: { nodeType: 'file', refId: data.node.refId } };
    label = `档案${titledWithNo(data.archive.title, data.archive.archiveNo)}的附件《${data.name}》`;
    if (mode === 'preset') question = `附件${label}讲了什么？结合与它有关联的档案，分析这份附件的内容。`;
  } else {
    context = { graphNode: { nodeType: 'chunk', refId: data.node.refId } };
    label = `档案${titledWithNo(data.archive.title, data.archive.archiveNo)}附件《${data.file.name}》的知识块（${data.locator || `第${data.chunkNo}块`}）`;
    if (mode === 'preset') question = `${label}讲了什么？它为什么与其他档案正文产生关联？`;
  }
  agent.openFromGraph({ question, label, context });
  void router.push('/archives/search');
}

/** 仅当关系线两端都是档案节点时才能「分析关联」（后端会重新校验两端档案）。 */
const archiveEdge = computed(() => {
  const edge = selectedEdge.value;
  if (!edge) return null;
  const fromId = /^archive:(\d+)$/.exec(edge.from)?.[1];
  const toId = /^archive:(\d+)$/.exec(edge.to)?.[1];
  if (!fromId || !toId) return null;
  return {
    edgeId: edge.id,
    fromArchiveId: Number(fromId),
    toArchiveId: Number(toId),
    fromLabel: store.nodeByKey.get(edge.from)?.label ?? '档案',
    toLabel: store.nodeByKey.get(edge.to)?.label ?? '档案',
  };
});

/** 分析两份档案之间的关联：问题自然语言描述意图，依据/证据由后端图谱工具与检索链路提供。 */
function analyzeEdge(): void {
  const pair = archiveEdge.value;
  if (!pair) return;
  agent.openFromGraph({
    question: `这两份档案之间为什么会产生关联？系统是通过什么依据建立关联的？哪些正文内容支持这种关联？是否存在真实业务联系？`,
    label: `《${pair.fromLabel}》↔《${pair.toLabel}》的关联关系`,
    context: { graphEdge: { edgeId: pair.edgeId, fromArchiveId: pair.fromArchiveId, toArchiveId: pair.toArchiveId } },
  });
  void router.push('/archives/search');
}
</script>

<template>
  <aside class="kg-detail" data-testid="kg-detail">
    <!-- 标题区固定，只让下方内容区纵向滚动（避免多层嵌套滚动互抢滚轮） -->
    <header class="kg-detail__head">
      <h2 class="kg-detail__title">节点详情</h2>
      <button
        class="kg-detail__collapse"
        type="button"
        data-testid="kg-detail-collapse"
        title="收起节点详情"
        aria-label="收起节点详情"
        aria-expanded="true"
        @click="emit('collapse')"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path d="M9.5 5.5L16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </header>

    <div class="kg-detail__body" data-testid="kg-detail-body">
    <p v-if="store.detailError" class="kg-detail__error" data-testid="kg-detail-error">{{ store.detailError }}</p>

    <AppEmpty
      v-if="!detail && !loading && !store.detailError"
      compact
      :title="store.selectedKey ? '详情加载中' : '未选中节点'"
      :description="store.selectedKey ? '正在读取该节点的真实著录与正文信息。' : '点击画布上的节点查看分类、档案、附件或知识块详情。'"
    />

    <p v-else-if="loading && !detail" class="text-muted kg-detail__hint">详情加载中…</p>

    <!-- 点击关系线：先展示该条关系的真实依据与原因，再按需展开完整证据 -->
    <section v-if="selectedEdge" class="kg-block kg-block--edge" data-testid="kg-edge-detail">
      <div class="kg-block__head">
        <span class="kg-chip" :style="{ borderColor: edgeStyle(selectedEdge.type).color }">关系线</span>
        <h3 class="kg-block__name">{{ selectedEdge.label }}</h3>
      </div>
      <dl class="kg-kv">
        <div><dt>关联依据</dt><dd>{{ basisLabel(selectedEdge.basis) }}</dd></div>
        <div><dt>权重 / 相似度</dt><dd>{{ selectedEdge.weight.toFixed(4) }}</dd></div>
        <div><dt>两端节点</dt><dd>{{ store.nodeByKey.get(selectedEdge.from)?.label ?? selectedEdge.from }} ↔ {{ store.nodeByKey.get(selectedEdge.to)?.label ?? selectedEdge.to }}</dd></div>
        <div><dt>关联原因</dt><dd>{{ selectedEdge.reason || '—' }}</dd></div>
      </dl>
      <p v-if="selectedEdge.basis === 'tfidf_cosine' || selectedEdge.basis === 'tfidf_cosine_aggregated'" class="kg-detail__hint">该关联来自档案正文内容相似，只能说明存在文本关联，不能直接证明两份档案存在实际业务关系。</p>
      <dl v-if="store.edgeDetail" class="kg-kv" data-testid="kg-exact-edge-evidence">
        <div v-for="row in evidenceRows(store.edgeDetail.evidence)" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
      </dl>
      <div v-if="store.edgeDetail" class="kg-actions">
        <button v-for="node in [store.edgeDetail.from,store.edgeDetail.to,...store.edgeDetail.supportingNodes]" :key="node.key" class="btn btn-sm" @click="store.locateReference({type:node.type,refId:node.refId})">{{ node.label }}</button>
        <button v-for="node in [store.edgeDetail.from,store.edgeDetail.to,...store.edgeDetail.supportingNodes].filter(n=>n.archiveId)" :key="'source-'+node.key" class="btn btn-sm" @click="router.push(node.fileId ? sourceRoute({archiveId:node.archiveId!,fileId:node.fileId,...(node.type==='chunk'?{chunkId:node.refId}:{})})! : '/archives/'+node.archiveId)">查看{{ node.type === 'chunk' ? '正文' : node.type === 'file' ? '附件' : '档案' }}原文</button>
      </div>
      <div class="kg-actions">
        <button class="btn btn-sm" type="button" data-testid="kg-edge-evidence" @click="loadEdgeEvidence">查看完整证据</button>
        <button
          v-if="archiveEdge"
          class="btn btn-sm btn-primary"
          type="button"
          data-testid="kg-edge-analyze"
          @click="analyzeEdge"
        >
          分析关联
        </button>
      </div>
    </section>

    <template v-if="detail">
      <!-- ============ 分类 ============ -->
      <section v-if="detail.type === 'category'" class="kg-block" data-testid="kg-detail-category">
        <div class="kg-block__head">
          <span class="kg-chip" :style="{ borderColor: nodeStyle('category').stroke }">档案分类</span>
          <h3 class="kg-block__name">{{ (detail as KgCategoryDetail).name }}</h3>
        </div>
        <dl class="kg-kv">
          <div><dt>分类编码</dt><dd class="mono">{{ (detail as KgCategoryDetail).code || '—' }}</dd></div>
          <div><dt>上级分类</dt><dd>{{ (detail as KgCategoryDetail).parentName || '顶级分类' }}</dd></div>
          <div><dt>可见档案数</dt><dd>{{ (detail as KgCategoryDetail).archiveCount }}</dd></div>
          <div><dt>分类说明</dt><dd>{{ (detail as KgCategoryDetail).description || '未填写' }}</dd></div>
        </dl>
        <div class="kg-list">
          <div class="kg-list__title">包含的档案<span class="kg-list__num">{{ (detail as KgCategoryDetail).archives.length }}</span></div>
          <button
            v-for="item in (detail as KgCategoryDetail).archives"
            :key="item.key"
            class="kg-row"
            type="button"
            @click="goChunkNode(item.key)"
          >
            <span class="kg-row__main">{{ item.title }}</span>
            <span class="kg-row__sub mono">{{ item.archiveNo }}</span>
            <span class="kg-row__badge">{{ fmtStatus(item.status) }} · {{ item.fileCount }} 附件</span>
          </button>
          <p v-if="!(detail as KgCategoryDetail).archives.length" class="text-muted kg-detail__hint">该分类下暂无你有权访问的档案。</p>
        </div>
      </section>

      <!-- ============ 档案 ============ -->
      <section v-else-if="detail.type === 'archive'" class="kg-block" data-testid="kg-detail-archive">
        <div class="kg-block__head">
          <span class="kg-chip" :style="{ borderColor: nodeStyle('archive').stroke }">档案</span>
          <h3 class="kg-block__name">{{ (detail as KgArchiveDetail).title }}</h3>
        </div>
        <dl class="kg-kv">
          <div><dt>档号</dt><dd class="mono">{{ (detail as KgArchiveDetail).archiveNo || '—' }}</dd></div>
          <div><dt>所属分类</dt><dd>{{ (detail as KgArchiveDetail).categoryName || '未分类' }}</dd></div>
          <div><dt>档案状态</dt><dd>{{ (detail as KgArchiveDetail).statusLabel || fmtStatus((detail as KgArchiveDetail).status) }}</dd></div>
          <div><dt>类型 / 责任者</dt><dd>{{ (detail as KgArchiveDetail).archiveType || '—' }} / {{ (detail as KgArchiveDetail).responsible || '—' }}</dd></div>
          <div><dt>成文日期</dt><dd>{{ (detail as KgArchiveDetail).formationDate || '—' }}</dd></div>
          <div><dt>主题词</dt><dd>{{ (detail as KgArchiveDetail).keywords || '—' }}</dd></div>
        </dl>
        <div class="kg-actions">
          <button class="btn btn-sm btn-primary" type="button" :disabled="!canViewSource" data-testid="kg-view-source" @click="viewSource">
            查看原文
          </button>
          <span v-if="!canViewSource" class="text-muted kg-detail__hint">当前账号无查看授权，可在借阅管理申请。</span>
        </div>
        <div class="kg-list">
          <div class="kg-list__title">附件<span class="kg-list__num">{{ (detail as KgArchiveDetail).files.length }}</span></div>
          <button
            v-for="file in (detail as KgArchiveDetail).files"
            :key="file.key"
            class="kg-row"
            type="button"
            :data-testid="`kg-file-${file.id}`"
            @click="goChunkNode(file.key)"
          >
            <span class="kg-row__main">{{ file.name }}</span>
            <span class="kg-row__sub">{{ file.extension.toUpperCase() }} · {{ fmtSize(file.fileSize) }} · {{ fmtStatus(file.extractStatus) }} · {{ file.chunkCount }} 块</span>
            <span v-if="canDownloadSource && PREVIEW_EXTS.includes(file.extension)" class="kg-row__link" @click.stop="openFilePreview(file)">预览</span>
          </button>
          <p v-if="!(detail as KgArchiveDetail).files.length" class="text-muted kg-detail__hint">该档案暂无附件。</p>
        </div>
      </section>

      <!-- ============ 附件 ============ -->
      <section v-else-if="detail.type === 'file'" class="kg-block" data-testid="kg-detail-file">
        <div class="kg-block__head">
          <span class="kg-chip" :style="{ borderColor: nodeStyle('file').stroke }">附件</span>
          <h3 class="kg-block__name">{{ (detail as KgFileDetail).name }}</h3>
        </div>
        <dl class="kg-kv">
          <div><dt>文件类型</dt><dd>{{ (detail as KgFileDetail).extension.toUpperCase() }} · {{ fmtSize((detail as KgFileDetail).fileSize) }}</dd></div>
          <div><dt>正文提取</dt><dd>{{ fmtStatus((detail as KgFileDetail).extractStatus) }}<template v-if="(detail as KgFileDetail).extractMessage"> · {{ (detail as KgFileDetail).extractMessage }}</template></dd></div>
          <div><dt>提取器</dt><dd>{{ (detail as KgFileDetail).extractor || '—' }}</dd></div>
          <div><dt>正文字符 / 知识块</dt><dd>{{ (detail as KgFileDetail).charCount }} / {{ (detail as KgFileDetail).chunkCount }}</dd></div>
          <div><dt>所属档案</dt><dd>{{ (detail as KgFileDetail).archive.title }}</dd></div>
        </dl>
        <div class="kg-actions">
          <button class="btn btn-sm btn-primary" type="button" :disabled="!canViewSource" data-testid="kg-view-source" @click="viewSource">查看原文</button>
          <button
            v-if="canDownloadSource && PREVIEW_EXTS.includes((detail as KgFileDetail).extension)"
            class="btn btn-sm"
            type="button"
            data-testid="kg-file-preview"
            @click="openFilePreview({ id: (detail as KgFileDetail).node.refId, name: (detail as KgFileDetail).name, extension: (detail as KgFileDetail).extension, fileSize: (detail as KgFileDetail).fileSize })"
          >
            在线预览
          </button>
        </div>
        <div class="kg-list">
          <div class="kg-list__title">正文知识块<span class="kg-list__num">{{ (detail as KgFileDetail).chunks.length }}</span></div>
          <button
            v-for="chunk in (detail as KgFileDetail).chunks"
            :key="chunk.key"
            class="kg-row kg-row--chunk"
            type="button"
            @click="goChunkNode(chunk.key)"
          >
            <span class="kg-row__main">{{ chunk.locator || `第 ${chunk.chunkNo} 块` }}</span>
            <span class="kg-row__sub">{{ chunk.excerpt }}</span>
          </button>
          <p v-if="(detail as KgFileDetail).truncated" class="text-muted kg-detail__hint">知识块较多，此处仅展示前若干块，可在画布上双击附件继续展开。</p>
          <p v-if="!(detail as KgFileDetail).chunks.length" class="text-muted kg-detail__hint">该附件暂无已索引正文。</p>
        </div>
      </section>

      <!-- ============ 知识块 ============ -->
      <section v-else class="kg-block" data-testid="kg-detail-chunk">
        <div class="kg-block__head">
          <span class="kg-chip" :style="{ borderColor: nodeStyle('chunk').stroke }">正文知识块</span>
          <h3 class="kg-block__name">{{ (detail as KgChunkDetail).locator || `第 ${(detail as KgChunkDetail).chunkNo} 块` }}</h3>
        </div>
        <p class="kg-excerpt" data-testid="kg-chunk-excerpt">{{ (detail as KgChunkDetail).excerpt || '（该知识块正文为空）' }}</p>
        <dl class="kg-kv">
          <div><dt>定位</dt><dd>{{ (detail as KgChunkDetail).locator || '—' }}<template v-if="(detail as KgChunkDetail).pageNo"> · 第 {{ (detail as KgChunkDetail).pageNo }} 页</template></dd></div>
          <div><dt>字符区间</dt><dd>{{ (detail as KgChunkDetail).posFrom ?? '—' }} – {{ (detail as KgChunkDetail).posTo ?? '—' }}（共 {{ (detail as KgChunkDetail).textLength }} 字）</dd></div>
          <div><dt>所属附件</dt><dd>{{ (detail as KgChunkDetail).file.name }}</dd></div>
          <div><dt>所属档案</dt><dd>{{ (detail as KgChunkDetail).archive.title }}<span class="mono"> · {{ (detail as KgChunkDetail).archive.archiveNo }}</span></dd></div>
        </dl>
        <div class="kg-actions">
          <button class="btn btn-sm btn-primary" type="button" :disabled="!canViewSource" data-testid="kg-view-source" @click="viewSource">查看原文</button>
        </div>
      </section>

      <!-- ============ 关联关系（含依据与证据） ============ -->
      <section class="kg-block kg-block--relations" data-testid="kg-relations">
        <div class="kg-list__title">
          {{ relationsTitle }}<span class="kg-list__num">{{ relationTotal }}</span>
          <button v-if="!store.relations" class="kg-linkbtn" type="button" data-testid="kg-load-relations" @click="openRelations">展开全部</button>
        </div>
        <p v-if="store.relationsLoading" class="text-muted kg-detail__hint">关联加载中…</p>
        <p v-else-if="!relatedItems.length" class="text-muted kg-detail__hint">该节点暂无可见的关联关系。</p>
        <div v-for="item in relatedItems" :key="item.edge.id" class="kg-rel">
          <button class="kg-rel__head" type="button" :data-testid="`kg-rel-${item.edge.id}`" @click="goChunkNode(item.node.key)">
            <span class="kg-rel__type" :style="{ color: edgeStyle(item.edge.type).color }">{{ item.edge.label }}</span>
            <span class="kg-rel__node">{{ item.node.label }}</span>
            <span class="kg-rel__weight">{{ item.edge.weight.toFixed(3) }}</span>
          </button>
          <dl class="kg-kv kg-kv--tight">
            <div v-for="row in evidenceRows(item.evidence)" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
            <div v-if="item.edge.reason"><dt>关联原因</dt><dd>{{ item.edge.reason }}</dd></div>
          </dl>
        </div>
      </section>

      <!-- ============ 第三阶段：问 AI 联动（复用现有 Agent 助理，不新建聊天） ============ -->
      <section class="kg-block kg-block--ai" data-testid="kg-ai-block">
        <div class="kg-list__title">问 AI</div>
        <template v-if="detail.type !== 'category'">
          <div class="kg-actions">
            <button class="btn btn-sm btn-primary" type="button" data-testid="kg-ask-ai" @click="askAi('preset')">问 AI</button>
            <button class="btn btn-sm" type="button" data-testid="kg-ask-followup" @click="askAi('free')">基于当前档案继续提问</button>
          </div>
          <p class="text-muted kg-detail__hint">
            跳转现有档案助理并绑定当前选中范围；节点与权限由后端重新核验，图谱关联只作检索线索、不直接当作事实证据。
          </p>
        </template>
        <p v-else class="text-muted kg-detail__hint">分类节点不支持问 AI，请选中档案、附件或知识块节点。</p>
      </section>
    </template>
    </div>

    <ArchivePreviewDialog
      v-if="previewTarget"
      :key="previewTarget.routePath"
      :name="previewTarget.name"
      :extension="previewTarget.extension"
      :file-size="previewTarget.fileSize"
      :route-path="previewTarget.routePath"
      :sdk-url="jitword?.previewSdkUrl"
      :can-download="canDownloadSource"
      @close="closePreview"
    />
  </aside>
</template>

<style scoped>
.kg-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 关键：允许 flex 子项在父级固定高度内缩，否则内容会撑高后被父级裁切 */
  min-height: 0;
  overflow: hidden;
  background: var(--kg-panel, var(--bg-card));
  color: var(--kg-text, var(--text-body));
}
.kg-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--kg-border, var(--border-light));
  background: var(--kg-panel, var(--bg-card));
}
.kg-detail__collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  border: 1px solid var(--kg-border, var(--border-light));
  border-radius: 6px;
  background: transparent;
  color: var(--kg-text-muted, var(--text-muted));
  cursor: pointer;
}
.kg-detail__collapse:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
/* 详情内容唯一滚动容器：鼠标滚轮 / 触控板 / 触摸滑动都在这里生效，
   不再向页面链式滚动（overscroll-behavior: contain），内部也不再嵌套可滚动区 */
.kg-detail__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 14px 20px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
}
.kg-detail__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kg-text, var(--text-title));
}
.kg-detail__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.kg-detail__error {
  margin: 0;
  font-size: 12px;
  color: var(--color-danger);
}
.kg-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--kg-border, var(--border-light));
}
.kg-block:last-child {
  border-bottom: 0;
}
.kg-block__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.kg-block__name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kg-text, var(--text-title));
  word-break: break-all;
}
.kg-chip {
  padding: 1px 7px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 11px;
  color: var(--kg-text-muted, var(--text-muted));
  white-space: nowrap;
}
.kg-kv {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  font-size: 12.5px;
}
.kg-kv > div {
  display: flex;
  gap: 8px;
}
.kg-kv dt {
  flex: 0 0 96px;
  color: var(--kg-text-muted, var(--text-muted));
}
.kg-kv dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  color: var(--kg-text, var(--text-title));
  word-break: break-word;
}
.kg-kv--tight > div {
  display: flex;
}
.kg-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.kg-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kg-list__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--kg-text, var(--text-title));
}
.kg-list__num {
  font-family: Consolas, Monaco, monospace;
  font-weight: 400;
  color: var(--kg-text-muted, var(--text-muted));
}
.kg-linkbtn {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--color-primary);
  font-size: 12px;
  cursor: pointer;
}
.kg-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: var(--kg-row-bg, rgba(22, 93, 255, 0.03));
  text-align: left;
  cursor: pointer;
  color: inherit;
}
.kg-row:hover {
  background: var(--color-primary-soft);
}
.kg-row__main {
  font-size: 13px;
  color: var(--kg-text, var(--text-title));
}
.kg-row__sub {
  font-size: 12px;
  color: var(--kg-text-muted, var(--text-muted));
  word-break: break-all;
}
.kg-row__badge {
  font-size: 11px;
  color: var(--color-primary);
}
.kg-row__link {
  font-size: 12px;
  color: var(--color-primary);
}
.kg-row--chunk .kg-row__sub {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.kg-excerpt {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--kg-quote-bg, rgba(114, 46, 209, 0.05));
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--kg-text, var(--text-body));
  white-space: pre-wrap;
  word-break: break-word;
}
.kg-rel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--kg-border, var(--border-light));
  border-radius: 8px;
}
.kg-rel__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.kg-rel__type {
  flex: 0 0 auto;
  font-weight: 600;
  white-space: nowrap;
}
/* 关联档案标题完整换行展示：不单行截断，卡片高度随内容自撑 */
.kg-rel__node {
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.5;
  color: var(--kg-text, var(--text-title));
}
.kg-rel__weight {
  flex: 0 0 auto;
  font-family: Consolas, Monaco, monospace;
  font-size: 11px;
  color: var(--kg-text-muted, var(--text-muted));
}
.mono {
  font-family: Consolas, Monaco, monospace;
}
.kg-block--ai {
  opacity: 0.85;
}
</style>
