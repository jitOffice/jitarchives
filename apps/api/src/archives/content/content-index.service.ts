/**
 * 附件正文索引服务（第二阶段）。
 *
 * 职责：把「档案下的当前有效正文」变成可检索片段，并在文件更新/版本入库/删除后维护一致性。
 *
 * 一致性规则（对应需求「避免重复索引同一版本」「文件更新后旧索引不再被错误使用」）：
 * 1. 索引单元以物理文件名 stored_name 为唯一键——每次上传/在线入库都会产生新的
 *    stored_name，因此同一版本内容不会被重复索引，重试也只是覆盖；
 * 2. 某文件写入新索引后，立即删除该文件其余历史内容的索引单元（旧版本正文不再可检索）；
 * 3. 检索路径还额外要求索引内容等于文件的「当前有效正文」，双保险，即使 prune 未执行
 *    （例如并发中断）也不会把旧版本正文交给模型。
 *
 * 安全边界：本服务只按 archiveId 做索引，不做权限判定；调用方（档案服务/Agent）必须已完成
 * 当前用户的访问校验。提取失败一律落状态与原因，绝不写入伪造正文。
 */
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { extractInBackground, PreparedContent } from './content.background';
import { readFileSync, statSync } from 'node:fs';
import { DATABASE } from '../../db/database';
import { ARCHIVE_VISIBILITY_SQL, ArchiveRepository, FileRepository, FileRow } from '../archive.repositories';
import { VersionRepository } from '../../jitword/jitword.repositories';
import { FileStorage } from '../file.storage';
import { SqliteTransaction } from '../../db/transaction';
import { chunkBlocks, ChunkDraft, CONTENT_PIPELINE_VERSION } from './content.chunk';
import { extractFileContent } from './content.extract';
import { ExtractResult, ExtractStatus } from './content.types';
import { ContentIndexRepository, ContentUnitRow, ViewerScope } from './content-index.repositories';
import { GraphMaintenanceHooks } from '../../graph/graph.hooks';

/** 单个附件的索引状态（对外可读，用于详情页/Agent 说明「哪些附件还没正文」）。 */
export interface FileContentStatus {
  fileId: number;
  fileName: string;
  extension: string;
  versionNo: number | null;
  status: ExtractStatus | 'pending' | 'processing';
  message: string;
  extractor: string;
  charCount: number;
  chunkCount: number;
  truncated: boolean;
  indexedAt: string | null;
  jobStatus?: string;
  embeddingStatus?: string;
  embeddingError?: string;
  attempts?: number;
}

export interface ArchiveContentStatus {
  archiveId: number;
  /** 本次实际新建/重建的索引单元数 */
  synced: number;
  files: FileContentStatus[];
}

@Injectable()
export class ContentIndexService {
  constructor(
    @Inject(ContentIndexRepository) private readonly units: ContentIndexRepository,
    @Inject(ArchiveRepository) private readonly archives: ArchiveRepository,
    @Inject(FileRepository) private readonly files: FileRepository,
    @Inject(VersionRepository) private readonly versions: VersionRepository,
    @Inject(FileStorage) private readonly storage: FileStorage,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
    @Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(GraphMaintenanceHooks) private readonly graph: GraphMaintenanceHooks,
  ) {}

  /**
   * 知识图谱刷新钩子（图谱未启用时为空操作）：必须在索引事务提交之后调用，
   * 失败只记告警，绝不影响正文索引与上传业务。
   */
  private refreshGraphSafely(fileId: number, scene: string): void {
    this.graph.refreshFileSafely(fileId, scene);
  }

  /**
   * 业务写入后的钩子：索引失败不得影响上传/入库/生成本身，只降级为「该附件暂无正文索引」。
   */
  syncArchiveSafely(archiveId: number, scene: string): void {
    try {
      for (const file of this.archives.listFiles(archiveId)) this.ensureJob(file.id);
    } catch (err) {
      console.warn(`[content] ${scene} 正文索引失败（不影响业务）：${(err as Error)?.message ?? err}`);
    }
  }

  /** 同步档案下全部附件的正文索引（已索引当前内容的文件直接跳过）。 */
  syncArchive(archiveId: number, retry = false): ArchiveContentStatus {
    const rows = this.archives.listFiles(archiveId);
    let synced = 0;
    for (const file of rows) {
      const job = this.db.prepare('SELECT status FROM knowledge_index_jobs WHERE file_id=?').get(file.id);
      if (this.indexFileById(file.id, retry && job?.status !== 'indexed')) synced += 1;
    }
    return { archiveId, synced, files: this.describe(archiveId) };
  }

  /** 只索引指定附件（上传单个文件后用，避免全档扫描）。 */
  indexFileById(fileId: number, retry = false): boolean {
    const claim = this.claimFile(fileId, retry);
    if (!claim) return false;
    try { this.finishClaim(claim); } catch (error) { this.failClaim(claim, error); }
    this.refreshGraphSafely(fileId, '附件正文索引');
    return true;
  }

  /** Parsing runs in a bounded worker thread; no upload request or SQLite write lock waits on PDF/OOXML parsing. */
  async indexFileInBackground(fileId: number): Promise<boolean> {
    const claim = this.claimFile(fileId, false);
    if (!claim) return false;
    try {
      const prepared = await extractInBackground(this.storage.resolveStored(claim.current.storedName), claim.file.extension);
      this.finishClaim(claim, prepared);
    } catch (error) { this.failClaim(claim, error); }
    this.refreshGraphSafely(fileId, '后台正文索引');
    return true;
  }

  private claimFile(fileId: number, retry: boolean) {
    return this.tx.run(() => {
      this.ensureJob(fileId, retry);
      const file = this.files.findById(fileId);
      if (!file) return null;
      const current = this.currentContentOf(file), token = randomUUID(), now = Date.now();
      const claimed = this.db.prepare(`UPDATE knowledge_index_jobs SET status='processing', attempts=attempts+1,
        claim_token=?, lease_until=?, updated_at=? WHERE file_id=? AND status='pending' AND next_attempt_at<=?`)
        .run(token, now+60000, new Date(now).toISOString(), fileId, now);
      return claimed.changes ? { file, current, token } : null;
    });
  }

  private finishClaim(claim: NonNullable<ReturnType<ContentIndexService['claimFile']>>, prepared?: PreparedContent): void {
    const {file, current, token} = claim;
    this.tx.run(() => {
      const fresh = this.files.findById(file.id);
      const job = this.db.prepare('SELECT claim_token FROM knowledge_index_jobs WHERE file_id=?').get(file.id);
      if (!fresh || job?.claim_token !== token) return;
      const effective = this.currentContentOf(fresh);
      if (effective.storedName !== current.storedName || effective.sha256 !== current.sha256) { this.ensureJob(file.id); return; }
      const unit = this.indexFile(file.archiveId, file, current, prepared);
      const status = unit.status === 'indexed' ? 'indexed' : ['failed','corrupt','no_text','encrypted'].includes(unit.status) ? 'failed' : 'unsupported';
      this.db.prepare(`UPDATE knowledge_index_jobs SET status=?, message=?, updated_at=?, embedding_status=?,
        next_attempt_at=?, lease_until=0, claim_token='' WHERE file_id=? AND claim_token=?`)
        .run(status,unit.message,new Date().toISOString(),status==='indexed'?'pending':'disabled',Date.now()+10000,file.id,token);
    });
  }

  private failClaim(claim: NonNullable<ReturnType<ContentIndexService['claimFile']>>, error: unknown): void {
    const mismatch = error instanceof Error && error.message === 'File content hash mismatch';
    this.tx.run(() => {
      const owns = this.db.prepare('SELECT 1 FROM knowledge_index_jobs WHERE file_id=? AND claim_token=?').get(claim.file.id,claim.token);
      if (!owns) return;
      if (mismatch) this.units.pruneUnitsExcept(claim.file.id,'');
      this.db.prepare(`UPDATE knowledge_index_jobs SET status='failed', message=?, updated_at=?, next_attempt_at=?,
        lease_until=0, claim_token='' WHERE file_id=? AND claim_token=?`)
        .run(mismatch?'文件内容哈希与登记版本不一致，请核对附件或重新上传':'索引处理失败，可重试',new Date().toISOString(),Date.now()+10000,claim.file.id,claim.token);
    });
  }

  /** Durable, idempotent enqueue; no file text is stored in jobs. */
  ensureJob(fileId: number, retry = false): void {
    const file = this.files.findById(fileId);
    if (!file) return;
    const current = this.currentContentOf(file);
    const unit = this.units.findUnitByStored(current.storedName);
    const pipeline = unit ? this.db.prepare('SELECT pipeline_version FROM archive_content_units WHERE id=?').get(unit.id)?.pipeline_version : '';
    const old = this.db.prepare('SELECT * FROM knowledge_index_jobs WHERE file_id=?').get(fileId);
    // A retry is for failed/missing content, never for an already indexed identical version.
    if (unit?.status === 'indexed' && unit.sha256 === current.sha256 && pipeline === CONTENT_PIPELINE_VERSION && old?.status === 'indexed') {
      if (!retry) return;
      // Explicit integrity checks must still detect missing/tampered bytes without rebuilding unchanged text.
      try {
        const filePath = this.storage.resolveStored(current.storedName);
        const actual = filePath ? createHash('sha256').update(readFileSync(filePath)).digest('hex') : '';
        if (actual === current.sha256) return;
      } catch { /* Let the claim record the real extraction failure below. */ }
    }
    if(old?.status==='processing' && old.stored_name===current.storedName && old.sha256===current.sha256)return;
    const changed = !old || old.stored_name !== current.storedName || old.sha256 !== current.sha256 || (unit && pipeline !== CONTENT_PIPELINE_VERSION);
    if (!changed && !retry) return;
    if (retry && old?.status === 'processing') return;
    const complete = !retry && unit?.status === 'indexed' && unit.sha256 === current.sha256 && pipeline === CONTENT_PIPELINE_VERSION;
    this.db.prepare(`INSERT INTO knowledge_index_jobs(file_id,stored_name,sha256,status,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(file_id) DO UPDATE SET stored_name=excluded.stored_name, sha256=excluded.sha256,
      status=excluded.status, attempts=0, message='', updated_at=excluded.updated_at, next_attempt_at=0,
      claim_token='', lease_until=0, embedding_lease_until=0, embedding_status='pending', embedding_attempts=0, embedding_retry_at=0, embedding_error=''`)
      .run(fileId, current.storedName, current.sha256, complete ? 'indexed' : 'pending', new Date().toISOString());
  }

  /**
   * 索引某文件当前有效正文：提取 → 切块 → 原子替换索引单元 → 清理该文件其余历史索引。
   */
  private indexFile(
    archiveId: number,
    file: FileRow,
    current: { storedName: string; sha256: string; versionId: number | null; versionNo: number | null },
    prepared?: PreparedContent,
  ): ContentUnitRow {
    const filePath = this.storage.resolveStored(current.storedName);
    if (filePath && statSync(filePath).size > 40 * 1024 * 1024) prepared = { actualHash: current.sha256, result: {status: 'unsupported',message: '文件超过40MB正文提取上限',extractor: '',blocks: [],truncated: false} };
    // Actual bytes must match the business version hash; never reuse a hash from unverified bytes.
    const actualHash = prepared?.actualHash ?? (filePath ? createHash('sha256').update(readFileSync(filePath)).digest('hex') : '');
    if (filePath && current.sha256 && current.sha256 !== actualHash) throw new Error('File content hash mismatch');
    const existing = this.units.findUnitByStored(current.storedName);
    const donor = prepared?.result.status==='unsupported' ? undefined : this.db.prepare("SELECT * FROM archive_content_units WHERE sha256=? AND extension=? AND status='indexed' AND pipeline_version=? LIMIT 1")
      .get(actualHash, file.extension, CONTENT_PIPELINE_VERSION);
    if (donor && Number(donor.id) !== existing?.id) {
      const chunks = this.db.prepare('SELECT * FROM archive_content_chunks WHERE unit_id=? ORDER BY chunk_no').all(donor.id!)
        .map(c => ({ chunkNo: Number(c.chunk_no), text: String(c.text), locator: String(c.locator), unit: 'paragraph',
          pageNo: c.page_no == null ? null : Number(c.page_no), posFrom: Number(c.pos_from), posTo: Number(c.pos_to) })) as ChunkDraft[];
      const reused = this.units.replaceUnit({ archiveId, fileId: file.id, versionId: current.versionId, versionNo: current.versionNo,
        storedName: current.storedName, sha256: actualHash, extension: file.extension, extractor: String(donor.extractor),
        status: 'indexed', message: '', truncated: !!donor.truncated, chunks });
      this.db.prepare('UPDATE archive_content_units SET pipeline_version=? WHERE id=?').run(CONTENT_PIPELINE_VERSION, reused.id);
      this.units.pruneUnitsExcept(file.id, current.storedName);
      return reused;
    }
    let result: ExtractResult;
    if (prepared) { result = prepared.result; } else if (!filePath) {
      result = {
        status: 'failed',
        message: '文件实体缺失，无法提取正文',
        extractor: '',
        blocks: [],
        truncated: false,
      };
    } else {
      try {
        result = extractFileContent(filePath, file.extension);
      } catch (err) {
        result = {
          status: 'failed',
          message: '正文提取异常，可重试或核对文件格式',
          extractor: '',
          blocks: [],
          truncated: false,
        };
      }
    }
    const chunks = result.status === 'indexed' ? chunkBlocks(result.blocks, result.extractor) : [];
    if (result.status === 'indexed' && !chunks.length) result = {...result,status:'no_text',message:'未提取到非空正文'};
    const unit = this.units.replaceUnit({
      archiveId,
      fileId: file.id,
      versionId: current.versionId,
      versionNo: current.versionNo,
      storedName: current.storedName,
      sha256: actualHash || current.sha256,
      extension: file.extension,
      extractor: result.extractor,
      status: result.status,
      message: result.message,
      truncated: result.truncated,
      chunks,
    });
    // 该文件的其他内容版本（旧上传件 / 旧在线版本）索引立即失效
    this.units.pruneUnitsExcept(file.id, current.storedName);
    this.db.prepare('UPDATE archive_content_units SET pipeline_version=? WHERE id=?').run(CONTENT_PIPELINE_VERSION, unit.id);
    return unit;
  }

  /**
   * 文件当前有效正文 = 当前版本指向的物理文件（无版本时为附件本身）。
   * 与检索侧 CURRENT_CONTENT_SQL 完全同口径，避免「下载到的」与「被检索的」不一致。
   */
  currentContentOf(file: FileRow): {
    storedName: string;
    sha256: string;
    versionId: number | null;
    versionNo: number | null;
  } {
    const archiveVersions = this.versions.listByArchiveId(file.archiveId);
    const byFile = archiveVersions
      .filter((candidate) => candidate.sourceFileId === file.id)
      .sort((a, b) => b.versionNo - a.versionNo || b.id - a.id);
    let version = byFile[0];
    if (!version && file.extension === 'docx') {
      const firstDocx = this.archives
        .listFiles(file.archiveId)
        .filter((candidate) => candidate.extension === 'docx')
        .sort((a, b) => a.id - b.id)[0];
      if (firstDocx?.id === file.id) {
        version = archiveVersions
          .filter((candidate) => candidate.sourceFileId == null)
          .sort((a, b) => b.versionNo - a.versionNo || b.id - a.id)[0];
      }
    }
    if (version && version.archiveId === file.archiveId) {
      return {
        storedName: version.storedName,
        sha256: version.sha256,
        versionId: version.id,
        versionNo: version.versionNo,
      };
    }
    return {
      storedName: file.storedName,
      sha256: file.sha256,
      versionId: null,
      versionNo: null,
    };
  }

  /** 档案下各附件的正文索引状态（真实读取，未处理过的文件标 pending）。 */
  isCurrentEvidence(fileId: number, unitId: number): boolean {
    const file = this.files.findById(fileId);
    if (!file) return false;
    const current = this.currentContentOf(file);
    const unit = this.units.findUnitByStored(current.storedName);
    return unit?.id === unitId && unit.sha256 === current.sha256;
  }

  describe(archiveId: number): FileContentStatus[] {
    const units = this.units.listUnitsByArchive(archiveId);
    const byStored = new Map<string, ContentUnitRow>();
    for (const u of units) byStored.set(u.storedName, u);
    return this.archives.listFiles(archiveId).map((file) => {
      const current = this.currentContentOf(file);
      const candidate = byStored.get(current.storedName);
      const unit = candidate?.sha256 === current.sha256 ? candidate : undefined;
      const job = this.db.prepare('SELECT * FROM knowledge_index_jobs WHERE file_id=? AND stored_name=?').get(file.id, current.storedName);
      const jobInfo = job ? { jobStatus: String(job.status), embeddingStatus: String(job.embedding_status), embeddingError: String(job.embedding_error), attempts: Number(job.attempts) } : {};
      if (!unit) {
        return {
          fileId: file.id,
          fileName: file.originalName,
          extension: file.extension,
          versionNo: current.versionNo,
          status: (job?.status === 'processing' ? 'processing' : job?.status === 'failed' ? 'failed' : job?.status === 'unsupported' ? 'unsupported' : 'pending') as FileContentStatus['status'],
          message: job?.message ? String(job.message) : '尚未提取正文',
          extractor: '',
          charCount: 0,
          chunkCount: 0,
          truncated: false,
          indexedAt: null,
          ...jobInfo,
        };
      }
      return {
        fileId: file.id,
        fileName: file.originalName,
        extension: file.extension,
        versionNo: unit.versionNo,
        status: job?.status === 'processing' ? 'processing' as const : job?.status === 'pending' ? 'pending' as const : job?.status === 'failed' ? 'failed' as const : unit.status,
        message: job?.status === 'failed' ? String(job.message || '索引失败，可重试') : unit.message,
        extractor: unit.extractor,
        charCount: unit.charCount,
        chunkCount: unit.chunkCount,
        truncated: unit.truncated,
        indexedAt: unit.indexedAt,
        ...jobInfo,
      };
    });
  }

  /** Read-only status discovery, with the same SQL visibility boundary as full-text search. */
  describeVisible(scope: ViewerScope, archiveIds?: number[], fileIds?: number[], extension?: string): Array<FileContentStatus & { archiveId: number; archiveTitle: string }> {
    if (archiveIds?.length === 0 || fileIds?.length === 0) return [];
    const where: string[] = [], args: Array<string | number> = [];
    if (!scope.admin) { where.push(ARCHIVE_VISIBILITY_SQL); args.push(scope.userId, scope.userId); }
    if (archiveIds) { where.push(`a.id IN (${archiveIds.map(() => '?').join(',')})`); args.push(...archiveIds); }
    if (fileIds) { where.push(`f.id IN (${fileIds.map(() => '?').join(',')})`); args.push(...fileIds); }
    if (extension) { where.push('f.extension=?'); args.push(extension); }
    const rows = this.db.prepare(`SELECT f.id, a.id AS archive_id, a.title FROM archive_files f
      JOIN archives a ON a.id=f.archive_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id,f.id`).all(...args);
    const cache = new Map<number, FileContentStatus[]>();
    return rows.flatMap(row => {
      const archiveId = Number(row.archive_id);
      if (!cache.has(archiveId)) cache.set(archiveId, this.describe(archiveId));
      const status = cache.get(archiveId)!.find(file => file.fileId === Number(row.id));
      return status ? [{ ...status, archiveId, archiveTitle: String(row.title) }] : [];
    });
  }

  /** 档案删除时清理（purge 已内置同样的删除；此方法供按需重建使用）。 */
  clearArchive(archiveId: number): number {
    const removed = this.tx.run(() => this.units.deleteByArchive(archiveId));
    this.graph.removeArchiveSafely(archiveId, '档案正文索引清理');
    return removed;
  }
}
