/**
 * 档案著录 / 列表 / 检索接口（阶段二第二批）。
 * 检索由后端参数化 SQL 真实执行（标题/档号/关键词 + 分类筛选 + 分页）。
 * 创建人、时间、档号、状态均由服务端维护，不信任前端传入。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, PermissionGuard, CurrentUser, Perm } from '../auth/guards';
import { UserView } from '../common/roles';
import {
  ArchiveView,
  ArchiveListView,
  ArchiveFileView,
  ArchivesService,
} from './archives.service';
import { ArchiveContentStatus } from './content/content-index.service';

@UseGuards(SessionGuard, PermissionGuard)
@Controller('archives')
export class ArchivesController {
  constructor(private readonly service: ArchivesService) {}

  @Get()
  @Perm('archiveView')
  list(
    @CurrentUser() viewer: UserView,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('includeSub') includeSub?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('matchDynamic') matchDynamic?: string,
  ): ArchiveListView {
    return this.service.searchArchives({ q, categoryId, includeSub, status, page, pageSize, matchDynamic }, viewer);
  }

  @Get(':id')
  @Perm('archiveView')
  detail(@Param('id', ParseIntPipe) id: number, @CurrentUser() viewer: UserView) {
    return this.service.getArchiveDetail(id, viewer);
  }

  @Post()
  @Perm('archiveManage')
  create(
    @Body()
    body: {
      title?: string;
      categoryId?: number;
      archiveType?: string;
      keywords?: string;
      formationDate?: string | null;
      responsible?: string;
      remarks?: string;
      accessLevel?: string;
      fieldValues?: Record<string, unknown>;
      // 显式不接受客户端指定的状态/档号/创建人（即使传入也被服务端规则覆盖）
    },
    @CurrentUser() operator: UserView,
  ): ArchiveView {
    if ((body as { status?: unknown }).status !== undefined) {
      throw new BadRequestException('档案状态由系统流转，不接受直接指定');
    }
    return this.service.createArchive(body, operator);
  }

  /** 编辑著录信息：仅未归档（draft）档案可修改，服务层强制约束。 */
  @Put(':id')
  @Perm('archiveManage')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @CurrentUser() operator: UserView,
  ): ArchiveView {
    return this.service.updateArchive(id, body as never, operator);
  }

  /**
   * 删除档案：仅未归档的草稿可删（服务层强制），归档档案一律 400。
   * 删除同时清理附件/文件版本/动态著录值与物理文件，并写 archive.delete 审计。
   */
  @Delete(':id')
  @Perm('archiveManage')
  delete(@Param('id', ParseIntPipe) id: number, @CurrentUser() operator: UserView): { ok: true } {
    return this.service.deleteArchive(id, operator);
  }

  /** 归档流转（draft → archived，单向）：仅管理员/审核员。 */
  @Post(':id/transition-archive')
  @Perm('archiveTransition')
  transition(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operator: UserView,
  ): ArchiveView {
    return this.service.transitionToArchived(id, operator);
  }

  @Get(':id/files')
  @Perm('archiveView')
  files(@Param('id', ParseIntPipe) id: number, @CurrentUser() viewer: UserView): ArchiveFileView[] {
    return this.service.listFiles(id, viewer);
  }

  /**
   * 附件正文索引状态（第二阶段）：只返回状态与失败原因，不返回正文。
   * 权限与档案详情一致（archiveView + 服务层逐档复核）。
   */
  @Get(':id/content/status')
  @Perm('archiveView')
  contentStatus(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() viewer: UserView,
  ): ArchiveContentStatus {
    return this.service.getContentStatus(id, viewer);
  }

  /**
   * 重建该档案附件的正文索引：只重写检索索引，不改动档案/附件/版本等业务数据。
   * 历史附件（早于索引能力上线）可通过本入口补齐。
   */
  @Post(':id/content/reindex')
  @Perm('archiveView')
  reindexContent(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() viewer: UserView,
  ): ArchiveContentStatus {
    return this.service.reindexContent(id, viewer);
  }
}
