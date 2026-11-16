/**
 * 档案知识图谱 · 状态管理（Pinia）。
 *
 * 职责边界：
 * - 数据只来自 /api/knowledge-graph/*（后端已按当前用户权限过滤），store 不补数据、不做权限推断；
 * - 画布位置缓存与已加载子图都放在这里，主题切换 / 面板折叠都不会丢图谱数据；
 * - 搜索与展开都带请求序号，过期响应直接丢弃，避免「后发先至」造成结果错乱。
 */
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { ApiError } from '../api/client.ts';
import { createRequestGuard, knowledgeGraphApi, type KgGraphParams } from '../api/knowledgeGraph.ts';
import {
  childrenOf,
  mergeSubgraph,
  pruneNodes,
  seedPositions,
  type KgPoint,
} from '../lib/knowledge-graph/subgraph.ts';
import { settleLayout } from '../lib/knowledge-graph/forceLayout.ts';
import { layoutPassBudget, planLayout, topologyOf } from '../lib/knowledge-graph/layoutPlan.ts';
import type {
  KgEdgeDetailResponse,
  KgEdgeType,
  KgGraphEdgeView,
  KgGraphResponse,
  KgNodeDetailResponse,
  KgGraphNodeView,
  KgNodeType,
  KgOverviewResponse,
  KgRelationsResponse,
  KgSearchHit,
  KgSearchResponse,
} from '../lib/knowledge-graph/types.ts';

/** 单次请求的节点上限（与后端 KG_NODE_LIMIT_DEFAULT 同量级，避免一次拉爆画布）。 */
const LAYER_PAGE_SIZE = 300;
/** 展开深度：双击一次只多取一层（后端上限 3）。 */
const EXPAND_DEPTH = 1;

export type KgViewMode = 'panorama' | 'category';

export interface KgFocusRequest {
  key: string;
  token: number;
}

function emptyOverview(): KgOverviewResponse {
  return {
    archives: 0,
    categories: 0,
    files: 0,
    chunks: 0,
    relations: 0,
    nodesByType: { category: 0, archive: 0, file: 0, chunk: 0 },
    edgesByType: {},
    categoryList: [],
    notBuilt: true,
  };
}

export const useKnowledgeGraphStore = defineStore('knowledge-graph', () => {
  // ---------- 概览 ----------
  const overview = ref<KgOverviewResponse>(emptyOverview());
  const overviewLoading = ref(false);
  const overviewLoaded = ref(false);

  // ---------- 视图选择 ----------
  const viewMode = ref<KgViewMode>('panorama');
  const activeCategoryId = ref<number | null>(null);
  const typeFilter = ref<KgNodeType[]>([]);

  // ---------- 画布数据 ----------
  const nodes = ref<KgGraphNodeView[]>([]);
  const edges = ref<KgGraphEdgeView[]>([]);
  const graphLoading = ref(false);
  const truncated = ref(false);
  const totalNodes = ref(0);
  /** 节点位置（按 key 缓存；主题切换 / 展开增补都不重新洗牌）。 */
  const positions = reactive(new Map<string, KgPoint>());
  /** 已执行的布局次数（只在拓扑变化时 +1，用于验证「不重复布局」）。 */
  const layoutRuns = ref(0);
  /** 布局轮次：每次布局完成 +1，画布据此重绘一次（不据此重算布局）。 */
  const layoutRevision = ref(0);
  /** 最近一次布局是否真正收敛（false = 撞上预算上限，位置已冻结保留）。 */
  const layoutSettled = ref(true);

  // ---------- 选中与详情 ----------
  const selectedKey = ref<string | null>(null);
  const edgeDetail=ref<KgEdgeDetailResponse|null>(null);
  const navigationGuard=createRequestGuard();
  const selectedEdgeId = ref<number | null>(null);
  const detail = ref<KgNodeDetailResponse | null>(null);
  const detailLoading = ref(false);
  const detailError = ref('');
  const relations = ref<KgRelationsResponse | null>(null);
  const relationsLoading = ref(false);

  // ---------- 搜索 ----------
  const keyword = ref('');
  const searchResult = ref<KgSearchResponse | null>(null);
  const searching = ref(false);
  const searchError = ref('');

  // ---------- 主题（沿用页面作用域变量，数据不受影响） ----------
  const theme = ref<'light' | 'dark'>('light');

  // ---------- 提示 ----------
  const error = ref('');

  // ---------- 缓存与竞态 ----------
  const layerCache = new Map<string, KgGraphResponse>();
  const expandCache = new Map<string, KgGraphResponse>();
  const expandedKeys = new Set<string>();
  const graphGuard = createRequestGuard();
  const searchGuard = createRequestGuard();
  const detailGuard = createRequestGuard();
  const focusRequest = ref<KgFocusRequest | null>(null);
  const resetToken = ref(0);

  const nodeByKey = computed(() => new Map(nodes.value.map((node) => [node.key, node])));

  const selectedNode = computed<KgGraphNodeView | null>(() =>
    selectedKey.value ? nodeByKey.value.get(selectedKey.value) ?? null : null,
  );

  /** 强调集合：选中节点 + 一跳邻居 + 相连关系（其余淡出）。 */
  const highlight = computed<{ nodes: Set<string>; edges: Set<number> }>(() => {
    const nodeSet = new Set<string>();
    const edgeSet = new Set<number>();
    const key = selectedKey.value;
    if (!key) return { nodes: nodeSet, edges: edgeSet };
    nodeSet.add(key);
    for (const edge of edges.value) {
      if (edge.from !== key && edge.to !== key) continue;
      edgeSet.add(edge.id);
      nodeSet.add(edge.from);
      nodeSet.add(edge.to);
    }
    return { nodes: nodeSet, edges: edgeSet };
  });

  const categoryList = computed(() => overview.value.categoryList);
  const searchHits = computed<KgSearchHit[]>(() => {
    const groups = searchResult.value?.groups;
    if (!groups) return [];
    return [...groups.category, ...groups.archive, ...groups.file, ...groups.chunk];
  });

  function messageOf(err: unknown, fallback: string): string {
    if (err instanceof ApiError) {
      if (err.status === 401) return '登录状态已失效，请重新登录';
      if (err.status === 403) return '当前账号无权访问知识图谱';
      if (err.status === 404) return '节点不存在或已不在你的可见范围内';
      return err.message || fallback;
    }
    return fallback;
  }

  function storePositions(graph: { nodes: KgGraphNodeView[]; edges: KgGraphEdgeView[] }, anchor = { x: 0, y: 0 }): void {
    const filled = seedPositions(graph.nodes, graph, positions, anchor);
    // 只保留当前画布上真实存在的节点位置：收起 / 切层后的旧键不再占缓存
    const alive = new Set(graph.nodes.map((node) => node.key));
    positions.clear();
    for (const [key, point] of filled) {
      if (alive.has(key)) positions.set(key, point);
    }
  }

  /**
   * 把接口响应合并进画布，并在「拓扑真的变了」时做一次布局：
   * - 首次加载 / 切换整层 → 全量布局；
   * - 展开新增节点 → 增量布局（冻结既有节点，只有新节点收敛）；
   * - 选中、详情、主题、缩放、窗口尺寸 → 不触发布局。
   * 布局是位置缓存的唯一写入口，画布不再自行执行力导向迭代。
   */
  function applyResponse(graph: KgGraphResponse, options: { replaceLayer?: boolean; anchor?: { x: number; y: number } } = {}): void {
    const previousTopology = topologyOf({ nodes: nodes.value, edges: edges.value });
    const merged = mergeSubgraph(
      { nodes: nodes.value, edges: edges.value },
      graph,
      { replaceLayer: options.replaceLayer, layerTypes: layerTypesOf(graph) },
    );
    // 全景 / 分类视图是「整层快照」：先只保留本层类型，再合并，保证切换视图后不残留旧分类内容
    nodes.value = merged.nodes;
    edges.value = merged.edges;
    truncated.value = graph.page.truncated;
    totalNodes.value = graph.page.totalNodes;
    storePositions({ nodes: merged.nodes, edges: merged.edges }, options.anchor);
    if (!merged.nodes.length) return;

    const plan = planLayout(previousTopology, { nodes: merged.nodes, edges: merged.edges }, { replaceLayer: options.replaceLayer });
    if (plan.action === 'none') return;
    const result = settleLayout({ nodes: merged.nodes, edges: merged.edges }, positions, {
      maxPasses: layoutPassBudget(merged.nodes.length),
      fixedKeys: plan.action === 'incremental' ? plan.fixedKeys : undefined,
    });
    layoutRuns.value += 1;
    layoutRevision.value += 1;
    layoutSettled.value = result.settled;
  }

  function layerTypesOf(graph: KgGraphResponse): KgNodeType[] {
    const types = new Set<KgNodeType>();
    for (const node of graph.nodes) types.add(node.type);
    return [...types];
  }

  function layerCacheKey(p: KgGraphParams): string {
    return [p.view, p.categoryId ?? '', typeFilter.value.join(','), p.page ?? 1].join('|');
  }

  /** 概览：左栏统计与分类列表；同一会话内只拉一次，重建后可 force。 */
  async function loadOverview(force = false): Promise<void> {
    if (overviewLoaded.value && !force) return;
    overviewLoading.value = true;
    error.value = '';
    try {
      overview.value = await knowledgeGraphApi.overview();
      overviewLoaded.value = true;
    } catch (err) {
      error.value = messageOf(err, '图谱概览加载失败');
    } finally {
      overviewLoading.value = false;
    }
  }

  /** 加载当前视图层（全景或分类），命中缓存则不重复请求。 */
  async function loadLayer(): Promise<void> {
    const params: KgGraphParams = {
      view: viewMode.value,
      categoryId: viewMode.value === 'category' ? activeCategoryId.value ?? undefined : undefined,
      types: typeFilter.value.length ? typeFilter.value : undefined,
      pageSize: LAYER_PAGE_SIZE,
      page: 1,
    };
    const cacheKey = layerCacheKey(params);
    const cached = layerCache.get(cacheKey);
    if (cached) {
      applyResponse(cached, { replaceLayer: true });
      return;
    }
    const token = graphGuard.next();
    graphLoading.value = true;
    error.value = '';
    try {
      const graph = await knowledgeGraphApi.graph(params);
      if (!graphGuard.isCurrent(token)) return; // 过期响应：已被更快的视图切换取代
      layerCache.set(cacheKey, graph);
      resetSelectionState();
      applyResponse(graph, { replaceLayer: true });
      if (viewMode.value === 'category' && activeCategoryId.value != null) {
        expandedKeys.add(`category:${activeCategoryId.value}`);
      } else {
        expandedKeys.clear();
      }
    } catch (err) {
      if (!graphGuard.isCurrent(token)) return;
      error.value = messageOf(err, '图谱数据加载失败');
      nodes.value = [];
      edges.value = [];
    } finally {
      if (graphGuard.isCurrent(token)) graphLoading.value = false;
    }
  }

  /** 双击 / 展开：以该节点为中心取下一层，增量合并进画布。 */
  async function expandNode(node: KgGraphNodeView, depth = EXPAND_DEPTH): Promise<void> {
    const cacheKey = `${node.key}|${depth}|${typeFilter.value.join(',')}`;
    const cached = expandCache.get(cacheKey);
    if (cached) {
      applyResponse(cached);
      expandedKeys.add(node.key);
      return;
    }
    const token = graphGuard.next();
    graphLoading.value = true;
    error.value = '';
    try {
      const graph = await knowledgeGraphApi.graph({
        view: viewMode.value,
        categoryId: viewMode.value === 'category' ? activeCategoryId.value ?? undefined : undefined,
        center: { type: node.type, refId: node.refId },
        depth,
        types: typeFilter.value.length ? typeFilter.value : undefined,
        pageSize: LAYER_PAGE_SIZE,
      });
      if (!graphGuard.isCurrent(token)) return;
      expandCache.set(cacheKey, graph);
      const anchor = positions.get(node.key) ?? { x: 0, y: 0 };
      applyResponse(graph, { anchor });
      expandedKeys.add(node.key);
    } catch (err) {
      if (!graphGuard.isCurrent(token)) return;
      error.value = messageOf(err, '展开该节点的下层内容失败');
    } finally {
      if (graphGuard.isCurrent(token)) graphLoading.value = false;
    }
  }

  /** 收起：只移除该节点已展开的下层子树（本地集合，不发请求，也不影响后端数据）。 */
  function collapseNode(node: KgGraphNodeView): void {
    const remove = new Set<string>();
    const queue = [node.key];
    while (queue.length) {
      const key = queue.shift()!;
      for (const child of childrenOf(key, { nodes: nodes.value, edges: edges.value })) {
        if (remove.has(child.key)) continue;
        // 只收起「本次展开出来的下层」，被其他路径共享的节点保留
        if (child.key === node.key) continue;
        remove.add(child.key);
        queue.push(child.key);
      }
    }
    if (!remove.size) return;
    const pruned = pruneNodes({ nodes: nodes.value, edges: edges.value }, remove);
    nodes.value = pruned.nodes;
    edges.value = pruned.edges;
    for (const key of remove) positions.delete(key);
    if (selectedKey.value && remove.has(selectedKey.value)) selectedKey.value = null;
  }

  /** 节点详情每次重新授权，历史缓存不能代替当前访问权限。 */
  async function selectNode(node: KgGraphNodeView): Promise<void> {
    navigationGuard.cancel();
    selectedEdgeId.value = null;
    selectedKey.value = node.key;
    const token = detailGuard.next();
    detailError.value = '';
    detail.value=null;edgeDetail.value=null;
    detailLoading.value = true;
    relations.value = null;
    try {
      const result = await knowledgeGraphApi.nodeDetail(node.type, node.refId);
      if (!detailGuard.isCurrent(token)) return;
      detail.value = result;
    } catch (err) {
      if (!detailGuard.isCurrent(token)) return;
      detail.value = null;nodes.value=[];edges.value=[];positions.clear();relations.value=null;
      layerCache.clear();expandCache.clear();overview.value=emptyOverview();overviewLoaded.value=false;
      detailError.value = messageOf(err, '节点详情加载失败');
    } finally {
      if (detailGuard.isCurrent(token)) detailLoading.value = false;
    }
  }

  /** 关系面板：点击关系线或右栏「查看全部关联」时按需拉取（含依据与证据）。 */
  async function loadRelations(node: KgGraphNodeView, edgeTypes?: KgEdgeType[]): Promise<void> {
    const token = detailGuard.next();
    relationsLoading.value = true;
    try {
      const result = await knowledgeGraphApi.nodeRelations(node.type, node.refId, { edgeTypes, pageSize: 50 });
      if (!detailGuard.isCurrent(token)) return;
      relations.value = result;
    } catch (err) {
      if (!detailGuard.isCurrent(token)) return;
      relations.value = null;
      detailError.value = messageOf(err, '关联关系加载失败');
    } finally {
      if (detailGuard.isCurrent(token)) relationsLoading.value = false;
    }
  }

  async function selectEdge(edge: KgGraphEdgeView): Promise<void> {
    navigationGuard.cancel();
    const token=detailGuard.next();
    detail.value=null;edgeDetail.value=null;relations.value=null;selectedEdgeId.value=null;detailError.value='';detailLoading.value=true;
    try {
      const live=await knowledgeGraphApi.edgeDetail(edge.id,{fromId:edge.fromId,toId:edge.toId});
      const data=await knowledgeGraphApi.nodeDetail(live.from.type,live.from.refId);
      if(!detailGuard.isCurrent(token))return;
      edgeDetail.value=live;detail.value=data;selectedEdgeId.value=live.edge.id;selectedKey.value=live.from.key;
      relations.value={node:live.from,total:1,page:1,pageSize:1,items:[{edge:live.edge,node:live.to,evidence:live.evidence}]};
    }catch(err){
      if(!detailGuard.isCurrent(token))return;
      // Failed reauthorization must also remove cached names and topology.
      nodes.value=[];edges.value=[];positions.clear();invalidate();detailLoading.value=false;
      detailError.value=messageOf(err,'关系不存在或无权查看');
    }finally{if(detailGuard.isCurrent(token))detailLoading.value=false;}
  }

  async function locateReference(ref?: {type:KgNodeType;refId:number}, edgeId?: number, expected?: {fromId:number;toId:number}): Promise<boolean> {
    invalidate();
    const token=navigationGuard.next();
    nodes.value=[];edges.value=[];positions.clear();
    graphLoading.value=true;detailLoading.value=true;detailError.value='';
    try {
      const relation=edgeId ? await knowledgeGraphApi.edgeDetail(edgeId,expected):null;
      const target=ref ?? (relation ? {type:relation.from.type,refId:relation.from.refId}:undefined);
      if(!target)return false;
      const data=await knowledgeGraphApi.nodeDetail(target.type,target.refId);
      const graph=await knowledgeGraphApi.graph({center:target,depth:1,includeRelations:true,pageSize:LAYER_PAGE_SIZE});
      if(!navigationGuard.isCurrent(token))return false;
      if(relation){
        const byKey=new Map([...graph.nodes,relation.from,relation.to,...relation.supportingNodes].map(n=>[n.key,n]));
        graph.nodes=[...byKey.values()];graph.edges=[...graph.edges.filter(e=>e.id!==relation.edge.id),relation.edge];
      }
      applyResponse(graph);detail.value=data;selectedKey.value=data.node.key;
      if(relation){edgeDetail.value=relation;selectedEdgeId.value=relation.edge.id;
        relations.value={node:relation.from,total:1,page:1,pageSize:1,items:[{edge:relation.edge,node:relation.to,evidence:relation.evidence}]};}
      focusRequest.value={key:data.node.key,token:Date.now()};return true;
    }catch(err){
      if(navigationGuard.isCurrent(token)){resetSelectionState();nodes.value=[];edges.value=[];detailError.value=messageOf(err,'定位失败，请重新查询');}
      return false;
    }finally{if(navigationGuard.isCurrent(token)){graphLoading.value=false;detailLoading.value=false;}}
  }

  /** 搜索：过期响应丢弃；无结果时保留空集合给前端渲染友好空状态。 */
  async function search(text: string): Promise<void> {
    const term = text.trim();
    keyword.value = text;
    if (!term) {
      searchGuard.cancel();
      searchResult.value = null;
      searchError.value = '';
      searching.value = false;
      return;
    }
    const token = searchGuard.next();
    searching.value = true;
    searchError.value = '';
    try {
      const result = await knowledgeGraphApi.search(term, 20);
      if (!searchGuard.isCurrent(token)) return;
      searchResult.value = result;
    } catch (err) {
      if (!searchGuard.isCurrent(token)) return;
      searchResult.value = null;
      searchError.value = messageOf(err, '搜索失败');
    } finally {
      if (searchGuard.isCurrent(token)) searching.value = false;
    }
  }

  function clearSearch(): void {
    searchGuard.cancel();
    keyword.value = '';
    searchResult.value = null;
    searchError.value = '';
    searching.value = false;
  }

  /** 搜索命中 → 画布定位：先确保节点已加载（未加载则按其所属档案展开一层），再请求聚焦。 */
  async function locateHit(hit: KgSearchHit): Promise<void> {
    if (!hit.key) return;
    let target = nodeByKey.value.get(hit.key);
    if (!target && hit.type !== 'category') {
      // 命中节点尚未在画布上：以同档案的档案节点为入口按需展开一次
      const anchorKey = hit.type === 'archive' ? hit.key : hit.archiveId ? `archive:${hit.archiveId}` : undefined;
      const anchor = anchorKey ? nodeByKey.value.get(anchorKey) : undefined;
      if (anchor) await expandNode(anchor, 2);
      target = nodeByKey.value.get(hit.key);
    }
    if (!target) return;
    await selectNode(target);
    focusRequest.value = { key: target.key, token: Date.now() };
  }

  function setViewMode(mode: KgViewMode): void {
    if (viewMode.value === mode && (mode === 'panorama' || activeCategoryId.value != null)) return;
    viewMode.value = mode;
    if (mode === 'panorama') activeCategoryId.value = null;
  }

  async function pickCategory(categoryId: number | null): Promise<void> {
    if (categoryId == null) {
      setViewMode('panorama');
      await loadLayer();
      return;
    }
    activeCategoryId.value = categoryId;
    viewMode.value = 'category';
    await loadLayer();
  }

  function toggleTypeFilter(type: KgNodeType): void {
    const list = typeFilter.value;
    typeFilter.value = list.includes(type) ? list.filter((item) => item !== type) : [...list, type];
  }

  function requestResetView(): void {
    resetToken.value += 1;
  }

  function setTheme(next: 'light' | 'dark'): void {
    theme.value = next;
  }

  function resetSelectionState(): void {
    selectedKey.value = null;
    selectedEdgeId.value = null;
    edgeDetail.value=null;
    detail.value = null;
    relations.value = null;
    detailError.value = '';
  }

  /** 图谱重建 / 重新进入页面：清掉所有缓存，确保拿到最新真实数据。 */
  function invalidate(): void {
    navigationGuard.cancel();
    layerCache.clear();
    expandCache.clear();
    expandedKeys.clear();
    graphGuard.cancel();
    searchGuard.cancel();
    detailGuard.cancel();
    overviewLoaded.value = false;
    resetSelectionState();
  }

  return {
    // state
    edgeDetail,
    overview,
    overviewLoading,
    overviewLoaded,
    viewMode,
    activeCategoryId,
    typeFilter,
    nodes,
    edges,
    positions,
    layoutRuns,
    layoutRevision,
    layoutSettled,
    graphLoading,
    truncated,
    totalNodes,
    selectedKey,
    selectedEdgeId,
    detail,
    detailLoading,
    detailError,
    relations,
    relationsLoading,
    keyword,
    searchResult,
    searchHits,
    searching,
    searchError,
    theme,
    error,
    focusRequest,
    resetToken,
    // getters
    nodeByKey,
    selectedNode,
    highlight,
    categoryList,
    // actions
    loadOverview,
    loadLayer,
    expandNode,
    collapseNode,
    selectNode,
    selectEdge,
    locateReference,
    loadRelations,
    search,
    clearSearch,
    locateHit,
    setViewMode,
    pickCategory,
    toggleTypeFilter,
    requestResetView,
    setTheme,
    invalidate,
  };
});
