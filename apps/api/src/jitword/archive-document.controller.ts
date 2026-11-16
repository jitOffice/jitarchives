/**
 * 档案在线编辑与文档版本接口（阶段二第三批）。
 * 全部挂 SessionGuard + PermissionGuard，服务端独立校验；前端隐藏按钮不作为安全控制。
 * 票据只回传可安全下发前端的字段，绝不含 clientSecret；docId 一律后端取，不接受前端指定。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import * as fs from 'fs';
import type { Request, Response } from 'express';
import { SessionGuard, PermissionGuard, CurrentUser, Perm } from '../auth/guards';
import { UserView } from '../common/roles';
import { hasPermission, PermKey } from '../common/permissions';
import { MAX_UPLOAD_MB } from '../config';
import { safeInlineName } from '../archives/preview.file';
import { ArchiveDocumentService } from './archive-document.service';
import { resolveRequestOrigin } from './jitword.config';

function requirePerm(user: UserView, perm: PermKey): void {
  if (!hasPermission(user.role, perm)) throw new ForbiddenException('当前角色无权执行该操作');
}

/** 自检请求体原始字节上限（服务层再按正文 JSON 体积复核，超限即中断读取）。 */
const MAX_SELFCHECK_RAW_BYTES = 12 * 1024 * 1024;

/**
 * 读取原始请求体文本：正文自检的大体积 JSON 走该通道，避开全局 JSON 解析器的默认 100KB 上限
 * （不修改全局配置，以免顺带放宽其它接口的请求体上限）。
 */
async function readRawBody(req: Request, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.byteLength;
    if (size > maxBytes) throw new BadRequestException(`正文内容超出上限（${Math.round(maxBytes / 1024 / 1024)}MB）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析可选的源附件 fileId：缺省返回 undefined，非法值直接拒绝，避免误操作其它文档。 */
function parseOptionalFileId(raw: string | number | undefined | null): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new BadRequestException('fileId 不合法');
  return value;
}

/** 由本次请求解析票据 origin：优先浏览器 Origin 头，兼容代理转发头，最后回退 Host。 */
function requestOrigin(req: Request): string {
  return resolveRequestOrigin(
    req.get('host'),
    req.headers['x-forwarded-proto'],
    req.protocol,
    req.headers['x-forwarded-host'],
    req.headers.origin,
  );
}

@UseGuards(SessionGuard, PermissionGuard)
@Controller('jitword')
export class JitWordStatusController {
  constructor(private readonly service: ArchiveDocumentService) {}

  /** 在线编辑接入状态（供前端判断是否展示编辑入口，不含任何密钥）。 */
  @Get('status')
  @Perm('archiveView')
  status(@Req() req: Request) {
    // 附带本次请求解析出的票据 origin，便于直接核对访问地址与票据是否一致。
    const origin = requestOrigin(req);
    return this.service.status(origin);
  }
}

@UseGuards(SessionGuard, PermissionGuard)
@Controller('archives')
export class ArchiveDocumentController {
  constructor(private readonly service: ArchiveDocumentService) {}

  @Get(':id/document')
  @Perm('archiveView')
  getDocument(
    @Param('id', ParseIntPipe) id: number,
    @Query('fileId') fileIdRaw: string | undefined,
    @CurrentUser() user: UserView,
  ) {
    return this.service.getDocument(id, user, parseOptionalFileId(fileIdRaw));
  }

  /** 该档案已建立的全部在线文档关联（同档案不同 DOC/DOCX 附件各自一条）。 */
  @Get(':id/documents')
  @Perm('archiveView')
  listDocuments(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: UserView) {
    return this.service.listDocuments(id, user);
  }

  @Post(':id/document/link')
  @Perm('documentEdit')
  async link(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { fileId?: number | string },
    @CurrentUser() user: UserView,
  ) {
    return this.service.linkDocument(id, user, parseOptionalFileId(body?.fileId));
  }

  /**
   * 申请票据。编辑票额外要求 documentEdit 角色 + 建档者归属（服务层校验），
   * 只读票要求 archiveView。
   * 票据 origin 必须等于浏览器地址栏，故由本次请求的 Host 解析（非固定常量），白名单校验在服务层。
   */
  @Post(':id/document/ticket')
  @Perm('archiveView')
  async ticket(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { mode?: string; fileId?: number | string },
    @Req() req: Request,
    @CurrentUser() user: UserView,
  ) {
    const mode = String(body?.mode || 'view');
    if (mode !== 'edit' && mode !== 'view') throw new BadRequestException('票据模式不合法');
    if (mode === 'edit') requirePerm(user, 'documentEdit');
    const origin = requestOrigin(req);
    if (!origin) throw new BadRequestException('无法确定本次访问的来源地址，已拒绝签发票据');
    return this.service.issueTicket(id, mode, user, origin, parseOptionalFileId(body?.fileId));
  }

  /** 返回可导入的 DOCX 字节（.doc 会先由服务端转换），供编辑器 importDocx 灌入真实正文。 */
  @Post(':id/document/seed')
  @Perm('documentEdit')
  async seed(
    @Param('id', ParseIntPipe) id: number,
    @Query('fileId') fileIdRaw: string | undefined,
    @CurrentUser() user: UserView,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.service.seedBytes(id, user, parseOptionalFileId(fileIdRaw));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="seed.docx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(buffer);
  }

  @Post(':id/document/saved')
  @Perm('documentEdit')
  saved(
    @Param('id', ParseIntPipe) id: number,
    @Query('fileId') fileIdRaw: string | undefined,
    @CurrentUser() user: UserView,
  ) {
    return this.service.markSaved(id, user, parseOptionalFileId(fileIdRaw));
  }

  /**
   * 附件正文已由前端 importDocx 写入远端文档后的确认标记。
   * 与 saved 严格区分：导入≠保存≠入库，仅用于防止重复自动导入覆盖用户内容。
   */
  @Post(':id/document/seeded')
  @Perm('documentEdit')
  seeded(
    @Param('id', ParseIntPipe) id: number,
    @Query('fileId') fileIdRaw: string | undefined,
    @CurrentUser() user: UserView,
  ) {
    return this.service.markSeeded(id, user, parseOptionalFileId(fileIdRaw));
  }

  /**
   * 保存后自动入库：字节取自厂商导出件（需客户端实现 exportDocument）。
   * 能力未开放时服务层返回 503 并如实说明原因，前端降级为导出件上传。
   */
  @Post(':id/document/sync')
  @Perm('documentEdit')
  sync(
    @Param('id', ParseIntPipe) id: number,
    @Query('fileId') fileIdRaw: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: UserView,
  ) {
    const origin = requestOrigin(req);
    if (!origin) throw new BadRequestException('无法确定本次访问的地址，已拒绝自动入库');
    return this.service.syncExportVersion(id, user, origin, parseOptionalFileId(fileIdRaw));
  }

  /**
   * 正文渲染自检（一次性诊断，不形成文件版本）：把浏览器 getContent() 的正文 JSON
   * 交厂商 POST /export/docx 渲染为 DOCX，返回与源附件的包内条目差异。
   * 正文以原始流提交（application/octet-stream），因此不接受 multipart。
   */
  @Post(':id/document/content-selfcheck')
  @Perm('documentEdit')
  async contentSelfCheck(
    @Param('id', ParseIntPipe) id: number,
    @Query('fileId') fileIdRaw: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: UserView,
  ) {
    const contentType = String(req.headers['content-type'] ?? '');
    if (contentType.includes('multipart/form-data')) {
      throw new BadRequestException('请以原始 JSON 流提交正文');
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_SELFCHECK_RAW_BYTES) {
      throw new BadRequestException('正文内容过大，已拒绝自检');
    }
    const raw = await readRawBody(req, MAX_SELFCHECK_RAW_BYTES);
    if (!raw.trim()) throw new BadRequestException('正文内容为空');
    let content: unknown;
    try {
      content = JSON.parse(raw);
    } catch {
      throw new BadRequestException('正文内容不是合法 JSON');
    }
    return this.service.contentSelfCheck(id, user, content, parseOptionalFileId(fileIdRaw));
  }

  /**
   * 用户浏览器导出后确认回传入库，形成正式文件版本（裸流上传，复用受控存储）。
   * ?fileId= 显式声明本版本是对哪个现有 DOCX 附件的更新；缺省时沿用在线文档关联的源附件。
   * 归属关系决定正文索引「当前有效版本」的判定，因此必须校验归属，不接受任意文件 ID。
   */
  @Post(':id/versions')
  @Perm('documentEdit')
  async addVersion(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Query('name') nameRaw: string | undefined,
    @Query('fileId') fileIdRaw: string | undefined,
    @CurrentUser() user: UserView,
  ) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new BadRequestException(`文件大小超出上限（${MAX_UPLOAD_MB}MB）`);
    }
    const contentType = String(req.headers['content-type'] ?? '');
    if (contentType.includes('multipart/form-data')) {
      throw new BadRequestException('请使用原始文件流方式上传');
    }
    const source = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    const fileName = nameRaw ? decodeURIComponent(nameRaw) : 'jitword-export.docx';
    const fileId = fileIdRaw && /^\d+$/.test(fileIdRaw.trim()) ? Number(fileIdRaw.trim()) : undefined;
    return this.service.addVersion(id, source, fileName, user, fileId);
  }

  @Get(':id/versions')
  @Perm('archiveView')
  versions(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: UserView) {
    return this.service.listVersions(id, user);
  }

  /**
   * 文件版本在线预览：受控字节流（octet-stream 附件通道），由前端 JitWord-Preview SDK
   * 在页面内解析渲染。与附件预览同级授权（服务层复判 fileDownload + 借阅授权）。
   */
  @Get(':id/versions/:versionId/preview')
  @Perm('fileDownload')
  versionPreview(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @CurrentUser() user: UserView,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const { fileName, filePath, size } = this.service.resolveVersionForPreview(id, versionId, user);
    // 绝不下发 docx 官方 MIME：仅当字节流交给前端 SDK 解析
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeInlineName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
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
}
