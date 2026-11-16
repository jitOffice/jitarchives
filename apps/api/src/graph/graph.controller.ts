/**
 * 档案知识图谱查询接口（第二阶段：后端 API）。
 *
 * 路由前缀 knowledge-graph（全局前缀 api 之后即 /api/knowledge-graph/*），全部只读 GET：
 * - 入口授权沿用现有体系：SessionGuard（未登录 401）+ PermissionGuard + @Perm('archiveView')（越权角色 403），
 *   与档案列表 / 详情 / 统一检索完全同一套权限键，不另建权限体系；
 * - 档案级可见性不依赖角色矩阵：具体返回哪些节点、关系与统计，由服务层复用 ARCHIVE_VISIBILITY_SQL
 *   与 ArchiveAccessService 逐条判定（详见 GraphQueryService 文件头的权限模型）；
 * - 请求参数一律经 DTO 显式解析：非法类型、越界数字、超长关键词直接 400，不做宽松兜底。
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, Perm, SessionGuard, PermissionGuard } from '../auth/guards';
import { UserView } from '../common/roles';
import { GraphQueryService } from './graph.query.service';
import { GraphBuildService } from './graph.service';
import { parseKgGraphParams, parseKgNodeType, parseKgRefId, parseKgRelationParams, parseKgSearchParams } from './graph.query.dto';
import { KgEdgeDetailResponse, KgGraphResponse, KgNodeDetailResponse, KgOverviewResponse, KgRelationsResponse, KgSearchResponse } from './graph.query.types';

@UseGuards(SessionGuard, PermissionGuard)
@Controller('knowledge-graph')
export class KnowledgeGraphController {
  constructor(
    private readonly service: GraphQueryService,
    private readonly buildService: GraphBuildService,
  ) {}

  /** 概览：当前用户可见的档案 / 分类 / 附件 / 知识块 / 关联数量与分类列表（全部实时重算，非静态数字）。 */
  @Get('overview')
  @Perm('archiveView')
  overview(@CurrentUser() viewer: UserView): KgOverviewResponse {
    return this.service.overview(viewer);
  }

  /**
   * 图谱数据：
   * - 不带 center：全景（view=panorama，默认分类 + 档案层）或分类视图（view=category&categoryId=）；
   * - 带 center=type:id：以该节点为中心按 depth 逐层展开（双击节点、按需加载附件与知识块走这条路径）。
   */
  @Get('graph')
  @Perm('archiveView')
  graph(@CurrentUser() viewer: UserView, @Query() raw: Record<string, string | undefined>): KgGraphResponse {
    return this.service.graph(viewer, parseKgGraphParams(raw));
  }

  /** 搜索：复用统一检索（目录 / 附件 / 正文 / 分类），返回可直接定位到画布的节点信息。 */
  @Get('search')
  @Perm('archiveView')
  search(@CurrentUser() viewer: UserView, @Query() raw: Record<string, string | undefined>): KgSearchResponse {
    const { keyword, limit, page } = parseKgSearchParams(raw);
    return this.service.search(viewer, keyword, limit, page);
  }

  /** 节点详情：分类 / 档案 / 附件 / 知识块各自的字段集合；「存在但无权」与不存在同为 404。 */
  @Get('nodes/:type/:id')
  @Perm('archiveView')
  nodeDetail(@Param('type') type: string, @Param('id') id: string, @CurrentUser() viewer: UserView): KgNodeDetailResponse {
    return this.service.detail(viewer, parseKgNodeType(type), parseKgRefId(id));
  }

  /** 节点关系：返回关系类型、权重、关联依据与证据（按权重降序、分页）。 */
  @Get('nodes/:type/:id/relations')
  @Perm('archiveView')
  nodeRelations(
    @Param('type') type: string,
    @Param('id') id: string,
    @Query() raw: Record<string, string | undefined>,
    @CurrentUser() viewer: UserView,
  ): KgRelationsResponse {
    const { edgeTypes, page, pageSize } = parseKgRelationParams(raw);
    return this.service.relations(viewer, parseKgNodeType(type), parseKgRefId(id), edgeTypes, page, pageSize);
  }

  @Get('edges/:id')
  @Perm('archiveView')
  edge(@Param('id') id: string, @Query() raw: Record<string, string | undefined>, @CurrentUser() viewer: UserView): KgEdgeDetailResponse {
    const expected = raw.fromId !== undefined || raw.toId !== undefined
      ? { fromId: parseKgRefId(raw.fromId ?? ''), toId: parseKgRefId(raw.toId ?? '') } : undefined;
    return this.service.edge(viewer, parseKgRefId(id), expected);
  }

  /** 构建状态：最近一次构建信息、待处理任务数、成功/失败累计。 */
  @Get('build-status')
  @Perm('archiveView')
  buildStatus() {
    return this.buildService.buildStatus();
  }
}
