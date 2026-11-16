/**
 * 图谱查询接口 · 请求参数 DTO 校验（第二阶段）。
 *
 * 项目未引入 class-validator，查询参数一律走「显式解析 + 明确 400」的既有写法
 * （与 ArchivesService.searchArchives / AuditController 保持同一风格）：
 * - 不信任任何外部输入：非法类型、越界数字、超长关键词一律 BadRequestException；
 * - 所有数量与深度都有硬上限，避免一次请求拖垮数据库或让画布无法布局。
 */
import { BadRequestException } from '@nestjs/common';
import { KgEdgeType, KgNodeType } from './graph.types';
import { KgGraphQuery, KgGraphView } from './graph.query.types';

/** 单次响应最多返回的节点数（默认值 / 硬上限）。 */
export const KG_NODE_LIMIT_DEFAULT = 300;
export const KG_NODE_LIMIT_MAX = 800;
/** 展开深度上限：第 4 层起一定是知识块之间的关联，画布已无法阅读，且查询成本陡增。 */
export const KG_DEPTH_DEFAULT = 1;
export const KG_DEPTH_MAX = 3;
/** 关系列表分页大小上限。 */
export const KG_RELATION_PAGE_MAX = 200;
/** 搜索关键词长度上限（与目录检索一致）。 */
export const KG_QUERY_MAX_LENGTH = 100;
/** 搜索每组的返回条数（默认 / 上限）。 */
export const KG_SEARCH_GROUP_DEFAULT = 20;
export const KG_SEARCH_GROUP_MAX = 50;
/** 分页浏览的页码上限与「最多可翻到第几条」上限（图谱不是无限深分页的业务列表）。 */
export const KG_MAX_PAGE = 200;
export const KG_MAX_OFFSET = 5000;

const NODE_TYPES: readonly string[] = ['category', 'archive', 'file', 'chunk'];
const EDGE_TYPES: readonly string[] = [
  'category_contains_archive',
  'archive_contains_file',
  'file_contains_chunk',
  'chunk_similar_to',
  'archive_related_to',
  'archive_shared_reference',
];

const isType = (raw: string): raw is KgNodeType => NODE_TYPES.includes(raw);
const isEdgeType = (raw: string): raw is KgEdgeType => EDGE_TYPES.includes(raw);

/** 正整数参数（空值回落默认；越界与非法一律 400，不静默修正）。 */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) throw new BadRequestException(`${label}必须是正整数`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new BadRequestException(`${label}必须是正整数`);
  if (value > max) throw new BadRequestException(`${label}不能超过 ${max}`);
  return value;
}

export function parseKgView(raw?: string): KgGraphView {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text || text === 'panorama' || text === 'all') return 'panorama';
  if (text === 'category') return 'category';
  throw new BadRequestException('视图类型仅支持 panorama（全景）或 category（分类）');
}

/** 路径参数 :type（节点类型）。 */
export function parseKgNodeType(raw: string): KgNodeType {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!isType(text)) throw new BadRequestException('节点类型仅支持 category / archive / file / chunk');
  return text;
}

/** 路径参数 :id（业务主键）。 */
export function parseKgRefId(raw: string): number {
  return parsePositiveInt(raw, 0, '节点编号');
}

/** 查询参数 center=「type:refId」（例如 archive:12）。 */
export function parseKgCenter(raw?: string): { type: KgNodeType; refId: number } | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  const [type, id, ...rest] = text.split(':');
  if (!isType(type) || !id || rest.length || !/^\d+$/.test(id)) {
    throw new BadRequestException('中心节点格式应为 type:id，例如 archive:12');
  }
  const refId = Number(id);
  if (!Number.isSafeInteger(refId) || refId <= 0) throw new BadRequestException('中心节点格式应为 type:id，例如 archive:12');
  return { type: type as KgNodeType, refId };
}

/** 逗号分隔的类型白名单（types=archive,file）。 */
export function parseKgNodeTypes(raw?: string): KgNodeType[] | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  const list = text
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.find((item) => !isType(item));
  if (bad) throw new BadRequestException(`不支持的节点类型：${bad}`);
  const unique = [...new Set(list)] as KgNodeType[];
  if (!unique.length) throw new BadRequestException('节点类型不能为空');
  return unique;
}

export function parseKgEdgeTypes(raw?: string): KgEdgeType[] | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  const list = text
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.find((item) => !isEdgeType(item));
  if (bad) throw new BadRequestException(`不支持的关系类型：${bad}`);
  if (!list.length) throw new BadRequestException('关系类型不能为空');
  return [...new Set(list)] as KgEdgeType[];
}

/** 布尔开关：接受 1/true，其余（含缺省）为 false，避免把任意字符串当假值。 */
export function parseBoolFlag(raw?: string): boolean {
  const text = String(raw ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

/** 搜索关键词：必填、去空白、限长（不做「空关键词全库返回」的宽松处理）。 */
export function parseKgQuery(raw?: string): string {
  const text = String(raw ?? '').trim();
  if (!text) throw new BadRequestException('请输入搜索关键词');
  if (text.length > KG_QUERY_MAX_LENGTH) throw new BadRequestException(`搜索关键词不能超过 ${KG_QUERY_MAX_LENGTH} 个字符`);
  return text;
}

export function parseKgLimit(raw?: string): number {
  return parsePositiveInt(raw, KG_NODE_LIMIT_DEFAULT, '节点数量上限', KG_NODE_LIMIT_MAX);
}

export function parseKgDepth(raw?: string): number {
  return parsePositiveInt(raw, KG_DEPTH_DEFAULT, '展开深度', KG_DEPTH_MAX);
}

/** 可选正整数（空值表示「不限制 / 未提供」，由服务层决定语义）。 */
export function parseOptionalId(raw?: string, label = '分类编号'): number | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) throw new BadRequestException(`${label}必须是正整数`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new BadRequestException(`${label}必须是正整数`);
  return value;
}

/** 带默认值的布尔开关（缺省值由调用方给出，避免把任意字符串当假值）。 */
function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  return text === '1' || text === 'true' || text === 'yes';
}

/** 分页对：页码与每页条数都受硬上限约束（防止深分页把整库扫一遍）。 */
function parsePaging(raw: Record<string, string | undefined>, label: string, max: number): { page: number; pageSize: number } {
  const pageSize = parsePositiveInt(raw.pageSize, Math.min(50, max), label, max);
  const page = parsePositiveInt(raw.page, 1, '页码', KG_MAX_PAGE);
  if ((page - 1) * pageSize + pageSize > KG_MAX_OFFSET) throw new BadRequestException(`翻页超出范围，单次最多浏览前 ${KG_MAX_OFFSET} 条`);
  return { page, pageSize };
}

/** GET /graph 参数整体装配（视图 / 分类 / 中心节点 / 深度 / 类型 / 分页）。 */
export function parseKgGraphParams(raw: Record<string, string | undefined>): KgGraphQuery {
  const view = parseKgView(raw.view);
  const categoryId = parseOptionalId(raw.categoryId, '分类编号');
  if (view === 'category' && categoryId === undefined) {
    throw new BadRequestException('分类视图必须同时指定 categoryId');
  }
  const center = parseKgCenter(raw.center);
  const pageSize = parsePositiveInt(raw.pageSize ?? raw.limit, KG_NODE_LIMIT_DEFAULT, '节点数量上限', KG_NODE_LIMIT_MAX);
  const page = parsePositiveInt(raw.page, 1, '页码', KG_MAX_PAGE);
  if (!center && (page - 1) * pageSize + pageSize > KG_MAX_OFFSET) {
    throw new BadRequestException(`翻页超出范围，单次最多浏览前 ${KG_MAX_OFFSET} 个节点`);
  }
  return {
    view,
    categoryId,
    center,
    depth: parseKgDepth(raw.depth),
    types: parseKgNodeTypes(raw.types),
    edgeTypes: parseKgEdgeTypes(raw.edgeTypes),
    // 全景视图默认带上档案级关联；展开模式默认只看结构层，需要内容关联时显式传 includeRelations=1
    includeRelations: parseFlag(raw.includeRelations, !center),
    page,
    pageSize,
  };
}

/** GET /nodes/:type/:id/relations 参数。 */
export function parseKgRelationParams(raw: Record<string, string | undefined>): { edgeTypes?: KgEdgeType[]; page: number; pageSize: number } {
  const { page, pageSize } = parsePaging(raw, '每页关系数', KG_RELATION_PAGE_MAX);
  return { edgeTypes: parseKgEdgeTypes(raw.edgeTypes), page, pageSize };
}

/** GET /search 参数（关键词必填，每组上限受控）。 */
export function parseKgSearchParams(raw: Record<string, string | undefined>): { keyword: string; limit: number; page: number } {
  const keyword = parseKgQuery(raw.q ?? raw.keyword);
  const limit = parsePositiveInt(raw.limit, KG_SEARCH_GROUP_DEFAULT, '每组返回数量', KG_SEARCH_GROUP_MAX);
  const page = parsePositiveInt(raw.page, 1, '页码', KG_MAX_PAGE);
  return { keyword, limit, page };
}
