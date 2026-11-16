import { BadRequestException, Body, Controller, Get, HttpException, Inject, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { CurrentUser, Perm, PermissionGuard, Roles, RolesGuard, SessionGuard } from '../auth/guards';
import { UserView } from '../common/roles';
import { AgentToolRegistry } from '../agent/tool.registry';
import { KnowledgeSearchService } from './knowledge-search.service';
import { ContentIndexService } from '../archives/content/content-index.service';
import { DATABASE } from '../db/database';

@UseGuards(SessionGuard, PermissionGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly registry: AgentToolRegistry,
    private readonly search: KnowledgeSearchService,
    private readonly content: ContentIndexService,
    @Inject(DATABASE) private readonly db: DatabaseSync) {}
  private async run(name: string, params: unknown, user: UserView) {
    const result = await this.registry.execute(name, params, user);
    if (result.status !== 'success') throw new HttpException(result.error?.message ?? '知识检索失败', Number(result.error?.code) || 500);
    return result.data;
  }
  @Post('search') @Perm('archiveView')
  query(@Body() body: unknown, @CurrentUser() user: UserView) { return this.run('search_knowledge', body, user); }
  @Post('evidence') @Perm('archiveView')
  evidence(@Body() body: unknown, @CurrentUser() user: UserView) { return this.run('get_document_evidence', body, user); }
  @Get('status') @Perm('archiveView')
  stats(@CurrentUser() user: UserView) { return this.search.statistics(user); }
  @Get('attachments/:id/status') @Perm('archiveView')
  status(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: UserView) { return this.run('get_attachment_index_status', { attachmentId: id }, user); }
  @Get('attachments/:id/source/:chunkId') @Perm('archiveView')
  source(@Param('id',ParseIntPipe) id:number,@Param('chunkId',ParseIntPipe) chunkId:number,
    @Query('archiveId') archiveId: string|undefined,@CurrentUser() user:UserView) {
    const archive=archiveId===undefined?undefined:Number(archiveId);
    if(archive!==undefined && (!Number.isSafeInteger(archive)||archive<=0))throw new BadRequestException('archiveId 必须是正整数');
    return this.search.sourceLocation(id,chunkId,user,archive);
  }
  @Post('attachments/:id/retry') @UseGuards(RolesGuard) @Roles('admin')
  retry(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: UserView) {
    this.search.attachmentStatus(id, user);
    this.content.ensureJob(id, true);
    return this.search.attachmentStatus(id, user);
  }
  /** Cursor-based backfill bounds each request; the built-in worker also scans history automatically. */
  @Post('backfill') @UseGuards(RolesGuard) @Roles('admin')
  backfill(@Body() body: { afterId?: number } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'afterId') ||
        body.afterId !== undefined && (!Number.isSafeInteger(body.afterId) || body.afterId < 0)) throw new BadRequestException('afterId 必须是非负整数');
    const rows = this.db.prepare('SELECT id FROM archive_files WHERE id>? ORDER BY id LIMIT 100').all(body.afterId ?? 0);
    for (const r of rows) this.content.ensureJob(Number(r.id));
    return { scanned: rows.length, nextAfterId: rows.length ? Number(rows[rows.length-1].id) : null };
  }
}
