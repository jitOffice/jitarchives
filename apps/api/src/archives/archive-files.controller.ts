/**
 * 档案附件上传 / 下载 / 在线预览接口（阶段二第二批 + V1.0 多格式预览）。
 * 上传：application/octet-stream 裸流（文件名走 ?name=），请求体一律流式落盘
 * （不整体进内存），扩展名/大小/文件名在服务端校验；multipart 明确拒绝。
 * 下载：fileId 数据库解析 → 角色矩阵 → 归属档案复核 → realpath 越权防护，
 * 目录未做任何静态托管，无法绕过接口直接访问物理文件。
 * 预览：与下载同级授权（服务端独立复判）。PDF/常见位图按真实 MIME 内联输出；
 * DOCX 经 ZIP 中央目录确认后以 octet-stream 受控字节流下发，供前端 JitWord-Preview
 * SDK 在页面内解析（浏览器侧不内联、不接管文档）；HTML/SVG 等主动内容一律 415 拒绝。
 */
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import * as fs from 'fs';
import type { Request, Response } from 'express';
import { SessionGuard, PermissionGuard, CurrentUser, Perm } from '../auth/guards';
import { UserView } from '../common/roles';
import { ArchivesService, ArchiveFileView } from './archives.service';
import { MAX_UPLOAD_MB } from '../config';
import { safeInlineName } from './preview.file';

@UseGuards(SessionGuard, PermissionGuard)
@Controller('archive-files')
export class ArchiveFilesController {
  constructor(private readonly service: ArchivesService) {}

  /**
   * 上传附件：浏览器以 File 作 fetch body 直接流式发送（application/octet-stream），
   * 真实文件名经 ?name= 传递（已 URL 编码），服务端边读边落盘、不整体驻内存。
   */
  @Post('upload')
  @Perm('fileUpload')
  async upload(
    @Req() req: Request,
    @Query('archiveId') archiveIdRaw: string,
    @Query('name') nameRaw: string | undefined,
    @CurrentUser() operator: UserView,
  ): Promise<ArchiveFileView> {
    const archiveId = Number(archiveIdRaw);
    if (!Number.isInteger(archiveId) || archiveId <= 0) {
      throw new BadRequestException('缺少合法的档案编号参数');
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new BadRequestException(`文件大小超出上限（${MAX_UPLOAD_MB}MB）`);
    }
    const contentType = String(req.headers['content-type'] ?? '');
    if (contentType.includes('multipart/form-data')) {
      // Express 的 IncomingMessage 不提供 formData()，multipart 无法安全流式解析；
      // 前端与测试统一改用 application/octet-stream 裸流（文件名走 ?name=），边读边落盘。
      throw new BadRequestException('请使用原始文件流方式上传');
    }
    const source = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    const fileName = nameRaw ? decodeURIComponent(nameRaw) : '未命名文件';
    return this.service.uploadFile(archiveId, source, fileName, contentType, operator);
  }

  /** 授权下载原文件（访客默认拒绝；URL 中的 fileId 必须通过数据库归属与路径双重校验）。 */
  @Get(':id/download')
  @Perm('fileDownload')
  download(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() viewer: UserView,
    @Res() res: Response,
  ): void {
    const { view, filePath } = this.service.resolveForDownload(id, viewer);
    // 元数据与物理文件一致性复核：以磁盘实际大小为准，不信任可能过期的元数据
    const actualSize = fs.statSync(filePath).size;
    const fallback = `file-${view.id}${view.extension ? `.${view.extension}` : ''}`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(actualSize));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fallback.replace(/[^\w.\-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(view.originalName)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ message: '文件读取失败，请稍后重试' });
        return;
      }
      res.destroy();
    });
    stream.pipe(res);
  }

  /**
   * 在线预览受控文件流。
   * - inline（PDF / 常见位图）：按真实 MIME 内联，支持单段 Range 供浏览器 PDF 查看器使用；
   * - sdk（DOCX/XLSX/PPTX/OFD/TXT/MD/HTML）：octet-stream 附件通道，字节交由
   *   前端 JitWord-Preview SDK 解析，绝不以文档或主动内容 MIME 内联；
   * - blocked（zip / tiff / 旧版 .doc / 主动内容）：415 + 中文原因，不虚假放行。
   * 守卫：登录 + fileDownload 角色矩阵（预览不得弱于下载），受限档案另由服务层
   * 按借阅授权（can_download）复判。
   */
  @Get(':id/preview')
  @Perm('fileDownload')
  preview(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() viewer: UserView,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const { view, filePath, type, size } = this.service.resolveForPreview(id, viewer);
    if (type.delivery === 'blocked' || !type.mimeType) {
      res.status(415).json({ message: previewUnsupportedMessage(type.kind, view) });
      return;
    }
    // SDK 通道：整文件下发，不做 Range；文件名走 RFC5987，绝不下发文档/文本 MIME
    if (type.delivery === 'sdk') {
      res.status(200);
      res.setHeader('Content-Type', type.mimeType);
      res.setHeader('Content-Length', String(size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeInlineName(view.originalName)}"; filename*=UTF-8''${encodeURIComponent(view.originalName)}`,
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const sdkStream = fs.createReadStream(filePath);
      sdkStream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ message: '文件读取失败，请稍后重试' });
          return;
        }
        res.destroy();
      });
      sdkStream.pipe(res);
      return;
    }
    // Range（仅支持单段 bytes a-b，多段/后缀段拒绝）：浏览器 PDF 查看器依赖分段读取
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    let start = 0;
    let end = size - 1;
    if (rangeHeader) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (!m || Number(m[1]) >= size) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416).end();
        return;
      }
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
      if (end < start) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    } else {
      res.status(200);
    }
    const length = end - start + 1;
    // 安全头：真实格式定 MIME + nosniff + inline（文件名服务端净化）；会话鉴权资源禁缓存。
    res.setHeader('Content-Type', type.mimeType);
    res.setHeader('Content-Length', String(length));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeInlineName(view.originalName)}"; filename*=UTF-8''${encodeURIComponent(view.originalName)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ message: '文件读取失败，请稍后重试' });
        return;
      }
      res.destroy();
    });
    stream.pipe(res);
  }

  /**
   * 删除单个附件：仅未归档草稿可删，管理员或档案创建者本人（服务层复判归属与状态）。
   * 成功后同步清理物理文件、正文索引与知识库任务，并写 file.delete 审计。
   */
  @Delete(':id')
  @Perm('fileUpload')
  delete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operator: UserView,
  ): { ok: true } {
    return this.service.deleteFile(id, operator);
  }
}

/** 无安全预览通道格式的中文提示（kind 为真实字节判定结果，不信任库内扩展名）。 */
function previewUnsupportedMessage(kind: string, view: ArchiveFileView): string {
  switch (kind) {
    case 'tiff':
      return '当前浏览器不支持 TIFF 图片内联预览，请下载后使用专业看图软件查看';
    case 'archive':
      return ['docx', 'xlsx', 'pptx', 'ofd'].includes(view.extension)
        ? '文件内容与扩展名不一致或文档结构不完整，无法在线预览，请下载后核对或重新上传'
        : '压缩包不支持在线预览，请下载后解压查看';
    case 'office':
      return '旧版 Office 文档（.doc/.xls/.ppt）不支持在线预览，请另存为 .docx/.xlsx/.pptx 后重新上传';
    default:
      return '该文件格式不支持在线预览，请通过下载查看';
  }
}
