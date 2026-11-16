/**
 * 档案知识图谱 · API 层（第二阶段）。
 *
 * 只做「参数装配 + 类型化响应」，不含任何视图状态；全部只读 GET：
 * - /api/knowledge-graph/overview                 概览（当前用户可见规模 + 分类列表）
 * - /api/knowledge-graph/graph                    全景 / 分类视图 / 以中心节点按需展开
 * - /api/knowledge-graph/nodes/:type/:id          节点详情
 * - /api/knowledge-graph/nodes/:type/:id/relations 节点关系（含依据与证据）
 * - /api/knowledge-graph/search                   图谱搜索（后端复用统一检索）
 * 权限完全由后端裁决：空结果与无权结果都如实返回，前端不做二次补数据。
 */
import { api } from './client.ts';
import type {
  KgEdgeDetailResponse,
  KgEdgeType,
  KgGraphResponse,
  KgNodeDetailResponse,
  KgNodeRef,
  KgNodeType,
  KgOverviewResponse,
  KgRelationsResponse,
  KgSearchResponse,
} from '../lib/knowledge-graph/types.ts';

export interface KgGraphParams {
  view?: 'panorama' | 'category';
  categoryId?: number;
  center?: KgNodeRef;
  depth?: number;
  types?: KgNodeType[];
  edgeTypes?: KgEdgeType[];
  includeRelations?: boolean;
  page?: number;
  pageSize?: number;
}

export interface KgRelationParams {
  edgeTypes?: KgEdgeType[];
  page?: number;
  pageSize?: number;
}

/** 空值不拼进 query：避免后端把空字符串当成非法参数拒绝。 */
function query(pairs: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** center 与后端同格式：type:refId。 */
function centerOf(center?: KgNodeRef): string | undefined {
  if (!center) return undefined;
  return `${center.type}:${center.refId}`;
}

export function kgGraphQuery(p: KgGraphParams): string {
  return query({
    view: p.view,
    categoryId: p.categoryId,
    center: centerOf(p.center),
    depth: p.depth,
    types: p.types?.length ? p.types.join(',') : undefined,
    edgeTypes: p.edgeTypes?.length ? p.edgeTypes.join(',') : undefined,
    includeRelations: p.includeRelations === undefined ? undefined : p.includeRelations ? '1' : '0',
    page: p.page,
    pageSize: p.pageSize,
  });
}

export const knowledgeGraphApi = {
  edgeDetail: (id: number, expected?: {fromId:number;toId:number}): Promise<KgEdgeDetailResponse> =>
    api.get<KgEdgeDetailResponse>('/knowledge-graph/edges/'+id+query(expected ?? {})),
  overview: (): Promise<KgOverviewResponse> => api.get<KgOverviewResponse>('/knowledge-graph/overview'),

  graph: (p: KgGraphParams = {}): Promise<KgGraphResponse> =>
    api.get<KgGraphResponse>(`/knowledge-graph/graph${kgGraphQuery(p)}`),

  nodeDetail: (type: KgNodeType, refId: number): Promise<KgNodeDetailResponse> =>
    api.get<KgNodeDetailResponse>(`/knowledge-graph/nodes/${type}/${encodeURIComponent(refId)}`),

  nodeRelations: (type: KgNodeType, refId: number, p: KgRelationParams = {}): Promise<KgRelationsResponse> =>
    api.get<KgRelationsResponse>(
      `/knowledge-graph/nodes/${type}/${encodeURIComponent(refId)}/relations${query({
        edgeTypes: p.edgeTypes?.length ? p.edgeTypes.join(',') : undefined,
        page: p.page,
        pageSize: p.pageSize,
      })}`,
    ),

  search: (keyword: string, limit?: number, page?: number): Promise<KgSearchResponse> =>
    api.get<KgSearchResponse>(`/knowledge-graph/search${query({ q: keyword.trim(), limit, page })}`),
};

/**
 * 过期响应守卫：搜索与展开都是「后发先至」易错位的场景。
 * 每次请求取一个序号，回包时序号不是最新即丢弃（结果不会覆盖新请求，避免错乱）。
 */
export function createRequestGuard(): { next: () => number; isCurrent: (token: number) => boolean; cancel: () => void } {
  let latest = 0;
  return {
    next: () => {
      latest += 1;
      return latest;
    },
    isCurrent: (token: number) => token === latest,
    cancel: () => {
      latest += 1;
    },
  };
}
