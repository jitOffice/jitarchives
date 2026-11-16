/**
 * 档案 ↔ JitWord 在线文档服务（阶段二第三批）。
 * 职责：文档关联（幂等）、票据签发（真实用户隔离）、编辑成果入库与文件版本、归档前置校验。
 * 权限边界：角色矩阵在控制器守卫上落实，本层对状态、归属、格式做二次复核（不信任前端）。
 *
 * 关键厂商约束落实（官方第 06/11 节 + 产品侧 OpenAPI 实测）：
 *   - embed 体系（租户密钥）侧没有取回文档字节的接口；产品侧 GET /export/docx/{docId}
 *     需用户 JWT，实测非建档主体一律 403，故服务端无法凭 docId 自行取导出件；
 *   - 白名单可用的是 POST /export/docx（按正文 JSON 渲染、不需 JWT，且请求体带 documentId 会 403），
 *     因此正文只能由浏览器 getContent() 取得后交服务端渲染 → 见 contentSelfCheck / renderDocx；
 *   - 入库字节必须是厂商导出件本身：手动通道 origin=jitword_export_reupload，
 *     自动通道 origin=jitword_auto_export；能力未开放时如实拒绝，绝不按正文伪造版本；
 *   - 演示租户无 ACL，非文档创建者主体换票 403 → 编辑票据只签给建档者本人（externalSubject 归属），
 *     绝不借用他人身份，他人访问如实返回限制说明。
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'node:stream';
import PizZip from 'pizzip';
import { ArchiveRepository, ArchiveRow, FileRepository, FileRow } from '../archives/archive.repositories';
import { readZipEntryNames } from '../archives/preview.file';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { FileStorage } from '../archives/file.storage';
import { ContentIndexService } from '../archives/content/content-index.service';
import { UserView } from '../common/roles';
import {
  DocumentRepository,
  DocumentRow,
  VersionOrigin,
  VersionRepository,
  VersionRow,
} from './jitword.repositories';
import { JitWordClient, TicketRequest } from './jitword.client';
import { isAllowedOrigin, loadJitWordConfig, loadPreviewSdkUrl } from './jitword.config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, AUDIT_OBJECT } from '../audit/audit.types';
import { convertDocToDocx } from './doc-convert';

export const JITWORD_CLIENT = 'JITWORD_CLIENT';

/** 官方公开接入地址（非机密，loader 与编辑器域名）：未配置时供前端兼容展示。 */
const DEFAULT_API_BASE = 'https://inner.jitword.com/api/v1';
const DEFAULT_EDITOR_URL = 'https://inner.jitword.com/px-editor';
const DEFAULT_LOADER_URL = 'https://inner.jitword.com/px-editor/iframe-sdk/v1/loader.js';

/** 文档关联对外视图。 */
export interface ArchiveDocumentView {
  id: number;
  archiveId: number;
  docId: string;
  docName: string;
  editState: string;
  canEdit: boolean; // 当前用户是否为该文档建档者
  creatorName: string;
  createdAt: string;
  lastSavedAt: string | null;
  /** 附件正文导入远端文档的时间；NULL 表示从未导入过（前端据此决定是否自动载入）。 */
  seededAt: string | null;
  /** 该关联对应的源电子文件（同档案可分别对多个 DOC/DOCX 建立关联）。 */
  sourceFileId: number | null;
  sourceFileName: string | null;
  sourceExtension: string | null;
}

/** 可进入在线编辑的源文件格式（.doc 在导入前由服务端转换为 .docx）。 */
export const ONLINE_EDIT_EXTENSIONS = ['doc', 'docx'] as const;

export interface ArchiveFileVersionView {
  id: number;
  versionNo: number;
  sha256: string;
  fileSize: number;
  origin: string;
  originLabel: string;
  createdByName: string;
  createdAt: string;
}

/** 正文自检的 JSON 体积上限：厂商渲染接口按内容计费，超限直接本地拒绝，不送远端。 */
const MAX_SELFCHECK_CONTENT_BYTES = 8 * 1024 * 1024;

/** 正文渲染自检结果（仅诊断用：条目差异与产物目录，不含任何密钥/票据）。 */
export interface SelfCheckResult {
  contentBytes: number;
  exported: { fileName: string; size: number; sha256: string; entries: number };
  source: { originalName: string; size: number; entries: number } | null;
  lostEntries: string[];
  addedEntries: string[];
  hasHeader: boolean;
  hasFooter: boolean;
  artifactDir: string;
}

const ORIGIN_LABELS: Record<string, string> = {
  upload: '原始上传件',
  jitword_export_reupload: '在线编辑回传入库',
  jitword_auto_export: '在线编辑自动入库（导出件）',
};

/** 由真实用户派生的稳定 JitWord 主体标识（不可变，符合官方对 externalSubject 的要求）。 */
export function externalSubjectFor(user: { id: number }): string {
  return `jitarchives-user-${user.id}`;
}

/** 生成 ASCII 文档名，规避阶段一发现的中文文档名导出 500（Content-Disposition 非法字符）。 */
function asciiDocName(archiveId: number, archiveNo: string, sourceFileId?: number): string {
  const safeNo = String(archiveNo).replace(/[^\w.\-]/g, '_').slice(0, 40);
  return sourceFileId == null
    ? `JITARCHIVES_A${archiveId}_${safeNo}`
    : `JITARCHIVES_A${archiveId}_F${sourceFileId}_${safeNo}`;
}

function isOnlineEditableExtension(extension: string | null | undefined): boolean {
  return (ONLINE_EDIT_EXTENSIONS as readonly string[]).includes(
    String(extension ?? '').toLowerCase(),
  );
}

function mapUnique(err: unknown, msg: string): never {
  const text = String((err as Error)?.message ?? err);
  if (/UNIQUE constraint failed/i.test(text)) throw new BadRequestException(msg);
  if (/FOREIGN KEY constraint failed/i.test(text)) throw new BadRequestException('关联数据不存在或已失效，请刷新后重试');
  throw err;
}

@Injectable()
export class ArchiveDocumentService {
  private readonly logger = new Logger(ArchiveDocumentService.name);

  constructor(
    @Inject(JITWORD_CLIENT) private readonly client: JitWordClient | null,
    @Inject(DocumentRepository) private readonly docs: DocumentRepository,
    @Inject(VersionRepository) private readonly versions: VersionRepository,
    @Inject(ArchiveRepository) private readonly archives: ArchiveRepository,
    @Inject(FileRepository) private readonly files: FileRepository,
    @Inject(FileStorage) private readonly storage: FileStorage,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ContentIndexService) private readonly content: ContentIndexService,
  ) {}

  /** 是否已接入 JitWord（配置密钥或测试注入客户端）。 */
  get available(): boolean {
    return !!this.client && this.client.available;
  }

  /** 是否已具备自动入库能力（厂商开放导出字节回传后才为 true）。 */
  get autoExportAvailable(): boolean {
    return this.available && typeof this.client?.exportDocument === 'function';
  }

  private requireClient(): JitWordClient {
    if (!this.available) {
      throw new ServiceUnavailableException('JitWord 未配置，在线编辑功能暂不可用');
    }
    return this.client as JitWordClient;
  }

  private requireArchive(id: number): ArchiveRow {
    const row = this.archives.findById(id);
    if (!row) throw new NotFoundException('档案不存在');
    return row;
  }

  /** 找该档案可在线编辑的源附件（.doc / .docx）。未指定 fileId 时取首个。 */
  private findEditableSource(archiveId: number, fileId?: number | null): FileRow | undefined {
    const files = this.archives.listFiles(archiveId);
    if (fileId != null) {
      const file = files.find((f) => f.id === fileId);
      return file && isOnlineEditableExtension(file.extension) ? file : undefined;
    }
    return files
      .filter((f) => isOnlineEditableExtension(f.extension))
      .sort((a, b) => a.id - b.id)[0];
  }

  /** 在线编辑必须明确落到一个本档案的 DOC/DOCX 附件；否则给出可读原因。 */
  private requireEditableSource(archiveId: number, fileId?: number | null): FileRow {
    if (fileId != null) {
      const files = this.archives.listFiles(archiveId);
      const file = files.find((f) => f.id === fileId);
      if (!file) throw new BadRequestException('所选附件不属于该档案，无法在线编辑');
      if (!isOnlineEditableExtension(file.extension)) {
        throw new BadRequestException('仅 .doc / .docx 电子文件支持在线编辑');
      }
      return file;
    }
    const source = this.findEditableSource(archiveId);
    if (!source) {
      throw new BadRequestException('仅 DOC/DOCX 电子文件支持在线编辑，请先上传 .doc 或 .docx 附件');
    }
    return source;
  }

  /** 按源附件定位关联；未指定 fileId 时沿用该档案的首条关联（兼容既有调用）。 */
  private resolveDocument(archiveId: number, fileId?: number | null): DocumentRow | undefined {
    return fileId != null
      ? this.docs.findBySourceFileId(archiveId, fileId)
      : this.docs.findByArchiveId(archiveId);
  }

  // ==================== 关联 ====================

  getDocument(archiveId: number, viewer: UserView, fileId?: number | null): ArchiveDocumentView | null {
    // 档案级权限：无权查看档案者，同样不能获取其在线文档关联信息（避免旁路泄露）。
    this.access.assertView(viewer, this.requireArchive(archiveId));
    const row = this.resolveDocument(archiveId, fileId);
    if (!row) return null;
    return this.toDocView(row, viewer);
  }

  /** 该档案已建立的全部在线文档关联（按源附件区分）。 */
  listDocuments(archiveId: number, viewer: UserView): ArchiveDocumentView[] {
    this.access.assertView(viewer, this.requireArchive(archiveId));
    return this.docs.listByArchiveId(archiveId).map((row) => this.toDocView(row, viewer));
  }

  /**
   * 建立/复用「档案 + 源附件」与在线文档的关联：
   * - 同一源附件幂等：已存在直接返回，绝不重复创建远端文档；
   * - 同一档案的多个 DOC/DOCX 附件可各建一条关联，由用户选择编辑哪一个；
   * - 其它格式明确拒绝；
   * - 建文档失败不落库错误 docId。
   */
  async linkDocument(
    archiveId: number,
    operator: UserView,
    fileId?: number | null,
  ): Promise<ArchiveDocumentView> {
    // 同一源附件重复关联必须幂等；未指定 fileId 时沿用首条关联（旧调用/旧前端）。
    const existing = this.resolveDocument(archiveId, fileId);
    if (existing) return this.toDocView(existing, operator);

    const archive = this.requireArchive(archiveId);
    if (archive.status === 'archived') {
      throw new BadRequestException('档案已归档，不可再建立在线编辑关联');
    }
    const source = this.requireEditableSource(archiveId, fileId);

    const client = this.requireClient();
    const externalSubject = externalSubjectFor(operator);
    const docName = asciiDocName(archiveId, archive.archiveNo, source.id);
    let created;
    try {
      created = await client.createDocument({ name: docName, externalSubject });
    } catch (err) {
      throw new ServiceUnavailableException(`建立在线文档失败：${(err as Error).message}`);
    }
    if (!created?.docId) {
      throw new InternalServerErrorException('建立在线文档失败：未返回有效文档标识');
    }
    try {
      const row = this.docs.insert({
        archiveId,
        docId: created.docId,
        docName: created.name || docName,
        externalSubject,
        creatorUserId: operator.id,
        editState: 'linked',
        sourceFileId: source.id,
      });
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.DOC_LINK,
        AUDIT_OBJECT.DOCUMENT,
        row.id,
        { archiveId, docName: row.docName },
      );
      return this.toDocView(row, operator);
    } catch (err) {
      mapUnique(err, '该文件已存在在线文档关联');
    }
    throw new InternalServerErrorException('文档关联登记失败，请重试');
  }

  // ==================== 票据 ====================

  /**
   * 签发编辑/只读票据。docId 一律取自后端关联记录，前端不能指定任意文档。
   * 编辑票强制：档案 draft + 申请人为建档者（externalSubject 归属）。
   * 已归档档案只拒绝编辑票，只读票仍可（供有查看权限者阅读，且远端已无编辑权）。
   * origin 取自当次请求 Host（浏览器地址栏），先过白名单：票据 origin 与实际访问地址不一致
   * 会被厂商拒绝（PERMISSION_DENIED embed ticket origin mismatch），因此绝不使用固定常量。
   */
  async issueTicket(
    archiveId: number,
    mode: 'edit' | 'view',
    operator: UserView,
    origin: string,
    fileId?: number | null,
  ): Promise<{ ticket: string; expiresAt: string; expiresIn: number; docId: string; origin: string; mode: string; scopes?: string[] }> {
    if (mode !== 'edit' && mode !== 'view') throw new BadRequestException('票据模式不合法');
    const doc = this.resolveDocument(archiveId, fileId);
    if (!doc) throw new NotFoundException('该文件尚未建立在线文档关联');
    const archive = this.requireArchive(archiveId);

    // 档案级权限：无档案查看权则不能签票（杜绝无权档案却通过在线编辑接口打开）。
    // 编辑票的实际归属限制仍由下方 externalSubject 校验落实（非建档者 400），保持第三批既有语义。
    this.access.assertView(operator, archive);

    // 来源校验：origin 来自本次浏览器请求（Origin 头 / 代理转发头 / Host），不是客户端业务参数。
    // 默认放行任意合法 http(s) 来源，正式公网域名无需再额外登记；严格白名单需显式开启 JITWORD_ORIGIN_STRICT=1。
    if (!isAllowedOrigin(origin)) {
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.DOC_TICKET,
        AUDIT_OBJECT.DOCUMENT,
        doc.id,
        { archiveId, mode, denied: 'origin_not_allowed' },
        'failure',
      );
      throw new BadRequestException('本次访问来源地址不在允许范围内，已拒绝签发票据（请检查反向代理的 Origin/Host 转发头）');
    }

    if (mode === 'edit') {
      if (archive.status === 'archived') {
        this.audit.record(
          { id: operator.id, role: operator.role, ip: null },
          AUDIT_ACTION.DOC_TICKET,
          AUDIT_OBJECT.DOCUMENT,
          doc.id,
          { archiveId, mode, denied: 'archived' },
          'failure',
        );
        throw new BadRequestException('档案已归档，普通编辑票据已停用');
      }
      if (doc.externalSubject !== externalSubjectFor(operator)) {
        // 非建档者换编辑票 = 服务端即时拦截的新越权尝试，明确记 failure（不混淆为已签发票据）。
        this.audit.record(
          { id: operator.id, role: operator.role, ip: null },
          AUDIT_ACTION.DOC_TICKET,
          AUDIT_OBJECT.DOCUMENT,
          doc.id,
          { archiveId, mode, denied: 'not_creator' },
          'failure',
        );
        throw new BadRequestException(
          `该在线文档由「${doc.creatorName ?? '他人'}」建档，受 JitWord 授权模型限制，仅建档者可编辑`,
        );
      }
    }

    const client = this.requireClient();
    const req: TicketRequest = {
      docId: doc.docId,
      origin,
      externalSubject: doc.externalSubject,
      displayName: operator.displayName || operator.username,
      mode,
      watermarkText: `${operator.displayName || operator.username} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`.slice(0, 100),
    };
    let issued;
    try {
      issued = await client.createTicket(req);
    } catch (err) {
      throw new ServiceUnavailableException(`申请编辑票据失败：${(err as Error).message}`);
    }
    // 建档者取得编辑票时，状态推进为 editing（著录进行中）。
    if (mode === 'edit' && doc.editState !== 'saved') {
      this.docs.updateState(doc.id, { editState: 'editing' });
    }
    // 签票成功留痕（绝不记录票据本身/时效密钥，仅记模式与文档来溯源）。
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.DOC_TICKET,
      AUDIT_OBJECT.DOCUMENT,
      doc.id,
      { archiveId, mode, docId: doc.docId },
    );
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      expiresIn: issued.expiresIn,
      docId: issued.docId || doc.docId,
      origin: issued.origin || origin,
      mode,
      scopes: issued.scopes,
    };
  }

  /** 编辑器保存成功回调：仅更新状态与时间，不代表正式入库。 */
  markSaved(archiveId: number, operator: UserView, fileId?: number | null): ArchiveDocumentView {
    const doc = this.resolveDocument(archiveId, fileId);
    if (!doc) throw new NotFoundException('该文件尚未建立在线文档关联');
    // 编辑权限已由票据签发层 + PermissionGuard 保证，不再重复校验 externalSubject。
    const updated = this.docs.updateState(doc.id, { editState: 'saved', lastSavedAt: new Date().toISOString() });
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.DOC_SAVED,
      AUDIT_OBJECT.DOCUMENT,
      doc.id,
      { archiveId },
    );
    return this.toDocView(updated ?? doc, operator);
  }

  /**
   * 附件正文导入远端文档成功后的标记：仅记录「已导入」事实，不代表保存或入库。
   * 前端拿到该标记后不再自动重导，避免覆盖用户尚未入库的编辑成果。
   */
  markSeeded(archiveId: number, operator: UserView, fileId?: number | null): ArchiveDocumentView {
    const archive = this.requireArchive(archiveId);
    if (archive.status === 'archived') {
      throw new BadRequestException('档案已归档，不可再向在线文档导入正文');
    }
    const doc = this.resolveDocument(archiveId, fileId);
    if (!doc) throw new NotFoundException('该文件尚未建立在线文档关联');
    if (doc.externalSubject !== externalSubjectFor(operator)) {
      throw new BadRequestException('仅文档建档者可导入附件正文');
    }
    const updated = this.docs.updateState(doc.id, { seededAt: new Date().toISOString() });
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.DOC_SEED,
      AUDIT_OBJECT.DOCUMENT,
      doc.id,
      { archiveId, docName: doc.docName },
    );
    return this.toDocView(updated ?? doc, operator);
  }

  /**
   * 返回可交给 importDocx 的源字节：
   * - .docx 直接回传原文件；
   * - .doc 先转换为 .docx（版式/正文尽力保留），文件名同步改为 .docx。
   */
  async seedBytes(
    archiveId: number,
    viewer: UserView,
    fileId?: number | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    // 仅文档编辑权者（创建者/管理员）可取回源字节，受限档案未授权者拒绝。
    this.access.assertView(viewer, this.requireArchive(archiveId));
    const doc = this.resolveDocument(archiveId, fileId);
    const linkedSource = doc?.sourceFileId ? this.files.findById(doc.sourceFileId) : undefined;
    const source = linkedSource ?? this.requireEditableSource(archiveId, fileId);
    if (!source) throw new NotFoundException('该档案没有可用于在线编辑的 DOC / DOCX 附件');
    if (!isOnlineEditableExtension(source.extension)) {
      throw new BadRequestException('源电子文件不是 DOC/DOCX，无法在线编辑');
    }
    const filePath = this.storage.resolveStored(source.storedName);
    if (!filePath) throw new NotFoundException('文件实体缺失，请联系管理员核查存储目录');
    const buffer = fs.readFileSync(filePath);
    if (source.extension === 'docx') return { buffer, fileName: source.originalName };
    return {
      buffer: await convertDocToDocx(buffer),
      fileName: `${source.originalName.replace(/\.[^.]+$/, '') || 'source'}.docx`,
    };
  }

  // ==================== 版本入库 ====================

  /**
   * 用户浏览器导出后确认重新上传，形成正式档案文件版本（origin=jitword_export_reupload）。
   * fileId：调用方声明本版本更新的是哪个附件；不传则归属到在线文档关联的源附件。
   */
  async addVersion(
    archiveId: number,
    source: ReadableStream<Uint8Array>,
    rawName: string,
    operator: UserView,
    fileId?: number,
  ): Promise<ArchiveFileVersionView> {
    return this.commitVersion(archiveId, source, rawName, operator, 'jitword_export_reupload', fileId ?? null);
  }

  /**
   * 从 DOCX 字节中提取 word/document.xml 的正文文本（去标签、去空白）。
   * 用于版本新鲜度比对：厂商导出的 DOCX 元数据（时间戳等）每次不同，
   * 全文件 SHA 永远不同，只有正文文本才能反映真实内容是否已更新。
   */
  private extractDocxBodyText(buf: Buffer): string | null {
    try {
      const zip = new PizZip(buf);
      const part = zip.file('word/document.xml');
      if (!part) return null;
      const node = part as unknown as { asNodeBuffer?: () => Buffer; asText?: () => string };
      const xml = typeof node.asNodeBuffer === 'function'
        ? node.asNodeBuffer().toString('utf8')
        : node.asText!();
      // 只取 <w:body> 内的文本
      const body = /<w:body[\s\S]*?<\/w:body>/.exec(xml)?.[0] ?? xml;
      // 提取所有 <w:t> 文本节点
      const texts: string[] = [];
      const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) texts.push(m[1]);
      return texts.join('').replace(/\s+/g, ' ').trim();
    } catch {
      return null;
    }
  }

  /**
   * 保存后自动入库：字节来自厂商导出件本身，仅当客户端实现 exportDocument 时可用。
   * 能力未开放时如实拒绝（不落空版本、不用正文重建），由前端降级为导出件上传。
   *
   * 版本新鲜度保障（厂商 GET /export/docx/{docId} 返回的是上一次保存的内容，
   * 存在异步同步延迟）：
   *   1. 首次导出前先等 5 秒，给厂商服务端同步窗口；
   *   2. 比对 word/document.xml 正文文本（而非全文件 SHA，因为 DOCX 元数据
   *      时间戳每次不同，SHA 永远不同）；
   *   3. 正文相同则等 2 秒重试，最多 3 次（总计最长约 11 秒）。
   */
  async syncExportVersion(
    archiveId: number,
    operator: UserView,
    origin: string,
    fileId?: number | null,
  ): Promise<ArchiveFileVersionView> {
    const archive = this.requireArchive(archiveId);
    if (archive.status === 'archived') {
      throw new BadRequestException('档案已归档，不可再加接新版本');
    }
    const doc = this.resolveDocument(archiveId, fileId);
    if (!doc) throw new NotFoundException('该文件尚未建立在线文档关联');
    // 编辑权限已由票据签发（issueTicket）时的建档者归属校验 + PermissionGuard 保证，
    // 此处不再重复校验 externalSubject（否则非建档者的编辑保存无法触发自动入库）。
    const client = this.requireClient();
    if (typeof client.exportDocument !== 'function') {
      throw new ServiceUnavailableException(
        'JitWord 未开放导出字节回传，暂无法自动入库；请导出 DOCX 后再上传入库',
      );
    }

    // 取上一入库版本的正文文本，用于后续比对导出件是否已刷新（厂商服务端同步有延迟）。
    const previousVersions = this.versions.listByArchiveId(archiveId);
    let previousBodyText: string | null = null;
    if (previousVersions.length > 0) {
      const prevVersion = previousVersions[0];
      // 从磁盘读取上一版本的 DOCX 文件提取正文
      try {
        const prevFile = this.storage.resolveStored(prevVersion.storedName);
        if (prevFile) {
          const prevBuf = fs.readFileSync(prevFile);
          previousBodyText = this.extractDocxBodyText(prevBuf);
        }
      } catch {
        this.logger.warn(`syncExportVersion: 无法读取上一版本文件，跳过正文比对`);
      }
    }
    this.logger.log(`syncExportVersion: archiveId=${archiveId}, docId=${doc.docId}, prevVersions=${previousVersions.length}, prevBodyTextLen=${previousBodyText?.length ?? 'N/A'}`);

    const MAX_SYNC_RETRIES = 3;
    const SYNC_RETRY_DELAY_MS = 2000;
    const INITIAL_SYNC_WAIT_MS = 5000;
    let exported: { buffer: Buffer; fileName: string } | null = null;
    let exportSha: string | null = null;
    let exportBodyText: string | null = null;

    for (let attempt = 0; attempt <= MAX_SYNC_RETRIES; attempt++) {
      // 首次导出前等 5 秒，给厂商服务端同步窗口
      if (attempt === 0) {
        this.logger.log(`syncExportVersion: 等待 ${INITIAL_SYNC_WAIT_MS}ms 让厂商服务端同步`);
        await new Promise((resolve) => setTimeout(resolve, INITIAL_SYNC_WAIT_MS));
      }

      try {
        exported = await client.exportDocument(doc.docId, doc.externalSubject, origin);
      } catch (err) {
        this.logger.error(`syncExportVersion: 导出失败 attempt=${attempt}: ${(err as Error).message}`);
        throw new ServiceUnavailableException(`自动入库失败：导出件获取失败（${(err as Error).message}）`);
      }
      if (!exported?.buffer?.length) {
        throw new InternalServerErrorException('自动入库失败：厂商返回的导出件为空');
      }
      exportSha = createHash('sha256').update(exported.buffer).digest('hex');
      exportBodyText = this.extractDocxBodyText(exported.buffer);
      this.logger.log(`syncExportVersion: attempt=${attempt}, exportSize=${exported.buffer.byteLength}, exportSha=${exportSha.slice(0, 12)}..., exportBodyLen=${exportBodyText?.length ?? 'null'}`);

      // 与上一版本正文相同 → 厂商还没同步完最新编辑成果，等待后重试
      if (previousBodyText && exportBodyText && exportBodyText === previousBodyText && attempt < MAX_SYNC_RETRIES) {
        this.logger.warn(`syncExportVersion: 正文与上一版本相同（len=${exportBodyText.length}），等待 ${SYNC_RETRY_DELAY_MS}ms 后重试 (attempt ${attempt + 1}/${MAX_SYNC_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, SYNC_RETRY_DELAY_MS));
        continue;
      }
      break;
    }

    // 重试耗尽后正文仍与上一版本相同，如实拒绝，不伪造新版本
    if (previousBodyText && exportBodyText && exportBodyText === previousBodyText) {
      this.logger.error(`syncExportVersion: 重试耗尽，正文仍与上一版本相同（len=${exportBodyText.length}），拒绝入库`);
      throw new ServiceUnavailableException(
        '自动入库失败：厂商导出件正文与上一版本完全相同，可能编辑成果尚未同步完成，请稍后重试',
      );
    }

    this.logger.log(`syncExportVersion: 入库成功 archiveId=${archiveId}, sha=${exportSha?.slice(0, 12)}..., size=${exported!.buffer.byteLength}, bodyLen=${exportBodyText?.length ?? 'null'}`);

    const source = Readable.toWeb(Readable.from([exported!.buffer])) as unknown as ReadableStream<Uint8Array>;
    return this.commitVersion(
      archiveId,
      source,
      exported!.fileName || `${doc.docName}.docx`,
      operator,
      'jitword_auto_export',
      doc.sourceFileId,
    );
  }

  // ==================== 正文渲染自检（只读诊断，不形成版本） ====================

  /**
   * 一次性诊断通路：把浏览器 getContent() 的正文 JSON 交给厂商 POST /export/docx 渲染为 DOCX，
   * 落盘到 storage/doc-selfcheck/ 并与源附件比对 ZIP 条目差异，用于判定保真度（页眉/页面设置丢多少）。
   *
   * 刻意不复用 exportDocument 语义：本方法只读，不写 archive_file_versions、不改 editState、
   * 不能让 autoExportAvailable 变成 true（能力未确认前绝不谎报自动入库已可用）。
   * 任何失败都如实抛出厂商原文，不降级伪造结果。
   */
  async contentSelfCheck(
    archiveId: number,
    operator: UserView,
    content: unknown,
    fileId?: number | null,
  ): Promise<SelfCheckResult> {
    const archive = this.requireArchive(archiveId);
    const doc = this.resolveDocument(archiveId, fileId);
    if (!doc) throw new NotFoundException('该文件尚未建立在线文档关联');
    if (doc.externalSubject !== externalSubjectFor(operator)) {
      throw new BadRequestException('仅文档建档者可执行正文自检');
    }
    if (!content || typeof content !== 'object' || (content as { type?: string }).type !== 'doc') {
      throw new BadRequestException('正文内容不是有效的文档 JSON（缺少 type:"doc"）');
    }
    const json = JSON.stringify(content);
    const contentBytes = Buffer.byteLength(json, 'utf8');
    if (contentBytes > MAX_SELFCHECK_CONTENT_BYTES) {
      throw new BadRequestException(`正文 JSON 过大（${Math.round(contentBytes / 1024)}KB），自检已取消`);
    }
    const client = this.requireClient();
    if (typeof client.renderDocx !== 'function') {
      throw new ServiceUnavailableException('当前 JitWord 客户端未实现正文渲染通道，无法自检');
    }

    const fileName = `${asciiDocName(archiveId, archive.archiveNo, doc.sourceFileId ?? undefined)}-selfcheck.docx`;
    let rendered: { buffer: Buffer; fileName: string };
    try {
      rendered = await client.renderDocx(content, fileName);
    } catch (err) {
      // 厂商原文如实上抛：403/404/超时分别对应归属、路由、网络问题，掩盖就会误判能力可用。
      throw new ServiceUnavailableException(`正文渲染失败：${(err as Error).message}`);
    }
    const buffer = rendered.buffer;
    if (!buffer?.length) throw new ServiceUnavailableException('正文渲染返回空字节');

    const dir = path.resolve(this.storage.root, '..', 'doc-selfcheck');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const docxPath = path.join(dir, `a${archiveId}-${stamp}.docx`);
    fs.writeFileSync(docxPath, buffer);
    fs.writeFileSync(path.join(dir, `a${archiveId}-${stamp}.content.json`), json, 'utf8');

    const exportedEntries = readZipEntryNames(docxPath);
    const source = doc.sourceFileId
      ? this.files.findById(doc.sourceFileId)
      : this.findEditableSource(archiveId);
    const sourcePath = source ? this.storage.resolveStored(source.storedName) : null;
    let sourceEntries: string[] = [];
    if (sourcePath && source) {
      if (source.extension === 'docx') {
        sourceEntries = readZipEntryNames(sourcePath);
      } else if (source.extension === 'doc') {
        // 旧版 DOC 不能直接读 ZIP 条目：先转换到同目录临时件，再按 DOCX 条目比对。
        try {
          const converted = await convertDocToDocx(fs.readFileSync(sourcePath));
          const convertedPath = path.join(dir, `a${archiveId}-${stamp}.source.docx`);
          fs.writeFileSync(convertedPath, converted);
          sourceEntries = readZipEntryNames(convertedPath);
        } catch {
          sourceEntries = [];
        }
      }
    }
    const exportedSet = new Set(exportedEntries);
    const sourceSet = new Set(sourceEntries);

    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.DOC_SEED,
      AUDIT_OBJECT.DOCUMENT,
      doc.id,
      { archiveId, selfCheck: true, size: buffer.byteLength, entries: exportedEntries.length },
    );

    return {
      contentBytes,
      exported: {
        fileName,
        size: buffer.byteLength,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        entries: exportedEntries.length,
      },
      source: source && sourcePath
        ? { originalName: source.originalName, size: source.fileSize, entries: sourceEntries.length }
        : null,
      lostEntries: sourceEntries.filter((n) => !exportedSet.has(n)),
      addedEntries: exportedEntries.filter((n) => !sourceSet.has(n)),
      hasHeader: exportedEntries.some((n) => /^word\/header\d*\.xml$/i.test(n)),
      hasFooter: exportedEntries.some((n) => /^word\/footer\d*\.xml$/i.test(n)),
      artifactDir: dir,
    };
  }

  /**
   * 版本入库公共实现：
   * - 仅 draft 档案、仅 docx；
   * - 流式落盘 + SHA-256；数据库写失败即删除物理文件（一致性补偿）；
   * - 版本号事务内自增，不覆盖历史；关联文档存在时记录 document_id 追溯来源。
   */
  private async commitVersion(
    archiveId: number,
    source: ReadableStream<Uint8Array>,
    rawName: string,
    operator: UserView,
    origin: VersionOrigin,
    fileIdArg?: number | null,
  ): Promise<ArchiveFileVersionView> {
    const archive = this.requireArchive(archiveId);
    if (archive.status === 'archived') {
      throw new BadRequestException('档案已归档，不可再加接新版本');
    }
    const safeName = path.basename(String(rawName || 'jitword-export.docx')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    const extension = (path.extname(safeName).replace(/^\./, '') || '').toLowerCase();
    if (extension !== 'docx') {
      throw new BadRequestException('在线编辑入库仅支持 .docx 文件');
    }
    // 先定归属再落盘：归属非法时直接拒绝，不留无法反查的物理文件。
    const sourceFileId = this.resolveVersionSourceFile(archiveId, fileIdArg);
    let stored;
    try {
      stored = await this.storage.saveStream(source, extension);
    } catch (err) {
      const { FileStoreError } = await import('../archives/file.storage');
      if (err instanceof FileStoreError) throw new BadRequestException(err.message);
      throw err;
    }
    const doc = sourceFileId != null
      ? this.docs.findBySourceFileId(archiveId, sourceFileId)
      : this.docs.findByArchiveId(archiveId);
    try {
      const row = this.versions.insertInTx({
        archiveId,
        documentId: doc?.id ?? null,
        sourceFileId,
        storedName: stored.storedName,
        sha256: stored.sha256,
        fileSize: stored.size,
        origin,
        createdBy: operator.id,
      });
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.DOC_VERSION,
        AUDIT_OBJECT.FILE_VERSION,
        row.id,
        { archiveId, versionNo: row.versionNo, origin: row.origin },
      );
      this.content.syncArchiveSafely(archiveId, 'JitWord version intake');
      return this.toVersionView(row);
    } catch (err) {
      this.storage.tryDelete(path.join(this.storage.root, stored.storedName)); // 入库失败即删除物理文件
      mapUnique(err, '版本登记失败，请重试');
    }
    throw new InternalServerErrorException('版本登记失败，请重试');
  }

  /**
   * 版本归属附件解析（服务层二次复核，不信任调用参数）：
   * - 显式 fileId：必须属于本档案且为 DOCX 附件，否则拒绝（跨档案指定或指向非 DOCX 均非法）；
   * - 未显式指定：沿用在线文档关联的源附件；无关联文档时为 null（该版本不归属任何附件，
   *   正文索引会如实回报「无版本」，不会把附件名当作版本依据）。
   */
  private resolveVersionSourceFile(archiveId: number, fileId?: number | null): number | null {
    const doc = this.docs.findByArchiveId(archiveId);
    if (fileId == null) return doc?.sourceFileId ?? null;
    const file = this.files.findById(fileId);
    if (!file || file.archiveId !== archiveId) {
      throw new BadRequestException('fileId 不属于该档案，版本入库拒绝归属');
    }
    if (!isOnlineEditableExtension(file.extension)) {
      throw new BadRequestException('在线编辑入库的版本只能归属 DOC/DOCX 附件');
    }
    return file.id;
  }

  listVersions(archiveId: number, viewer: UserView): ArchiveFileVersionView[] {
    const archive = this.requireArchive(archiveId);
    this.access.assertView(viewer, archive);
    return this.versions.listByArchiveId(archiveId).map((v) => this.toVersionView(v));
  }

  /** 归档前置校验：需要在线文档成果时，必须已有成功入库的版本。 */
  assertArchiveReady(id: number): void {
    const doc = this.docs.findByArchiveId(id);
    if (!doc) return; // 未使用在线编辑，沿用第二批原归档逻辑
    if (this.versions.countByArchiveId(id) === 0) {
      throw new BadRequestException('该档案已接入在线编辑，归档前需先形成文件版本（保存后自动入库或上传导出件）');
    }
  }

  /**
   * 文件版本预览：档案归属校验 → 与附件预览同级授权（fileDownload + 受限档案借阅授权）
   * → 物理定位 → 审计。版本入库仅接受 .docx，故按 docx 受控字节流下发。
   */
  resolveVersionForPreview(
    archiveId: number,
    versionId: number,
    viewer: UserView,
  ): { fileName: string; filePath: string; size: number } {
    const archive = this.requireArchive(archiveId);
    const row = this.versions.findById(versionId);
    if (!row || row.archiveId !== archiveId) throw new NotFoundException('文件版本不存在或已被清理');
    try {
      this.access.assertDownload(viewer, archive); // 预览与下载同级授权
    } catch (err) {
      // 越权预览尝试记 failure 后抛出，交由守卫返回 403（不泄露任何文件字节）。
      this.audit.record(
        { id: viewer.id, role: viewer.role, ip: null },
        AUDIT_ACTION.FILE_PREVIEW_DENIED,
        AUDIT_OBJECT.FILE_VERSION,
        row.id,
        { archiveId, versionNo: row.versionNo, denied: true },
        'failure',
      );
      throw err;
    }
    const filePath = this.storage.resolveStored(row.storedName);
    if (!filePath) throw new NotFoundException('文件实体缺失，请联系管理员核查存储目录');
    const size = fs.statSync(filePath).size;
    // 版本表不保存原始文件名，按「档号-vN.docx」生成可读名（仅用于预览/下载展示）。
    const safeNo = String(archive.archiveNo || `A${archive.id}`).replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `${safeNo}-v${row.versionNo}.docx`;
    this.audit.record(
      { id: viewer.id, role: viewer.role, ip: null },
      AUDIT_ACTION.FILE_PREVIEW,
      AUDIT_OBJECT.FILE_VERSION,
      row.id,
      { archiveId, name: fileName, kind: 'docx', versionNo: row.versionNo },
    );
    return { fileName, filePath, size };
  }

  // ==================== 视图映射 ====================

  private toDocView(row: DocumentRow, viewer: UserView): ArchiveDocumentView {
    const source = row.sourceFileId == null ? undefined : this.files.findById(row.sourceFileId);
    return {
      id: row.id,
      archiveId: row.archiveId,
      docId: row.docId,
      docName: row.docName,
      editState: row.editState,
      canEdit: row.externalSubject === externalSubjectFor(viewer),
      creatorName: row.creatorName ?? '未知用户',
      createdAt: row.createdAt,
      lastSavedAt: row.lastSavedAt,
      seededAt: row.seededAt,
      sourceFileId: row.sourceFileId,
      sourceFileName: source?.originalName ?? null,
      sourceExtension: source?.extension ?? null,
    };
  }

  private toVersionView(row: VersionRow): ArchiveFileVersionView {
    return {
      id: row.id,
      versionNo: row.versionNo,
      sha256: row.sha256,
      fileSize: row.fileSize,
      origin: row.origin,
      originLabel: ORIGIN_LABELS[row.origin] ?? row.origin,
      createdByName: row.creatorName ?? '未知用户',
      createdAt: row.createdAt,
    };
  }

  /**
   * 诊断用：返回当前是否已接入及公开接入参数（绝不返回密钥）。
   * origin 为本次请求解析出的票据来源；只有格式非法时返回 null。
   */
  status(requestOrigin: string): {
    available: boolean;
    source: string | null;
    apiBase: string;
    editorUrl: string;
    loaderUrl: string;
    previewSdkUrl: string;
    tenantKey: string;
    providerKey: string;
    origin: string | null;
    /** 是否支持保存后自动入库（厂商开放导出字节回传后为 true）。 */
    autoExportAvailable: boolean;
    /** 可进入在线编辑的源附件格式（前端据此筛选文件与文案）。 */
    editableExtensions: string[];
  } {
    const cfg = loadJitWordConfig();
    const base = {
      apiBase: cfg?.api ?? DEFAULT_API_BASE,
      editorUrl: cfg?.editorUrl ?? DEFAULT_EDITOR_URL,
      loaderUrl: DEFAULT_LOADER_URL,
      // 预览 SDK 为纯前端渲染，未配置密钥时同样可用（前端据此加载脚本）。
      previewSdkUrl: loadPreviewSdkUrl(),
      tenantKey: cfg?.tenantKey ?? '',
      providerKey: cfg?.providerKey ?? '',
      origin: isAllowedOrigin(requestOrigin) ? requestOrigin : null,
      autoExportAvailable: this.autoExportAvailable,
      editableExtensions: [...ONLINE_EDIT_EXTENSIONS],
    };
    if (!this.available) return { available: false, source: null, ...base };
    return { available: true, source: cfg?.source ?? '测试注入客户端', ...base };
  }
}
