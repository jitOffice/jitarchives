/**
 * 附件正文索引仓储（第二阶段）。
 *
 * 沿用既有仓储模式：抽象类作为 DI Token，SQLite 实现绑定在 ArchivesModule。
 * 检索一律带档案可见性条件（复用 ARCHIVE_VISIBILITY_SQL），仓储层就是「无权访问的正文
 * 不会被查出来」的最后一道闸；上层再按 ArchiveAccessService 复核一次。
 *
 * 「当前内容」定义（决定旧索引是否失效）：
 *   文件的有效正文 = 该文件当前版本指向的物理文件；无版本时 = 附件本身的物理文件。
 *   索引单元只有 stored_name 与该有效正文一致时才可被检索命中，因此
 *   文件更新 / 在线编辑入库新版本后，旧版本索引立即不再参与回答。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, hasContentBigramFts } from '../../db/database';
import { buildBigramMatchExpression, buildCjkBigramTerms, extractLexicalTokens } from '../../search/cjk-bigram';
import { SqliteTransaction } from '../../db/transaction';
import { ARCHIVE_VISIBILITY_SQL } from '../archive.repositories';
import { ChunkDraft } from './content.chunk';
import { ExtractStatus } from './content.types';

export interface ContentUnitRow {
  id: number;
  archiveId: number;
  fileId: number;
  versionId: number | null;
  versionNo: number | null;
  storedName: string;
  sha256: string;
  extension: string;
  extractor: string;
  status: ExtractStatus;
  message: string;
  charCount: number;
  chunkCount: number;
  truncated: boolean;
  indexedAt: string;
}

/** 检索命中的正文片段（已带来源档案/附件/版本等可引用字段）。 */
export interface EvidenceRow {
  searchSource?: string;
  hitType?: string;
  chunkId: number;
  pageNo?: number | null;
  versionId?:number|null;
  posFrom?: number;
  posTo?: number;
  unitId: number;
  archiveId: number;
  fileId: number;
  archiveTitle: string;
  archiveNo: string;
  fileName: string;
  extension: string;
  versionNo: number | null;
  locator: string;
  text: string;
  /** 相关度（越大越相关；FTS 用 bm25，LIKE 兜底用词频） */
  score: number;
}

export interface ViewerScope {
  userId: number;
  /** 管理员可见全部档案正文（与既有目录检索口径一致） */
  admin: boolean;
}

export abstract class ContentIndexRepository {
  abstract ftsAvailable(): boolean;
  abstract findUnitByStored(storedName: string): ContentUnitRow | undefined;
  abstract listUnitsByArchive(archiveId: number): ContentUnitRow[];
  abstract listUnitsOfFile(fileId: number): ContentUnitRow[];
  /** 写入（或整体替换）某物理文件的索引单元与其片段；同事务同步 FTS。 */
  abstract replaceUnit(input: {
    archiveId: number;
    fileId: number;
    versionId: number | null;
    versionNo: number | null;
    storedName: string;
    sha256: string;
    extension: string;
    extractor: string;
    status: ExtractStatus;
    message: string;
    truncated: boolean;
    chunks: ChunkDraft[];
  }): ContentUnitRow;
  /** 使某文件除 keepStoredName 之外的历史索引失效（文件更新/新版本入库后）。 */
  abstract pruneUnitsExcept(fileId: number, keepStoredName: string): number;
  abstract deleteByArchive(archiveId: number): number;
  /** 按关键词检索有权访问的正文片段（FTS 优先，短词/无 FTS 时 LIKE 兜底），支持按档号/标题/档案范围筛选。 */
  abstract searchChunks(
    term: string,
    scope: ViewerScope,
    limit: number,
    archiveIds?: number[],
    archiveNo?: string,
    archiveTitle?: string,
    fileIds?: number[],
  ): EvidenceRow[];
  /** 限定档案内取正文片段（无有效关键词时按档案取头部片段，仍带权限过滤）。 */
  abstract listChunksOfArchives(
    archiveIds: number[],
    scope: ViewerScope,
    limit: number,
    fileIds?: number[],
    offset?: number,
  ): EvidenceRow[];
}

/** 文件有效正文（当前版本优先）视图，供三条检索路径共用。 */
export const CURRENT_CONTENT_SQL = `
  SELECT f.id AS file_id,
         COALESCE(v.stored_name, f.stored_name) AS stored_name,
         COALESCE(v.sha256, f.sha256) AS sha256,
         v.version_no AS version_no
    FROM archive_files f
    LEFT JOIN archive_file_versions v ON v.id = COALESCE((
      SELECT vv.id FROM archive_file_versions vv
       WHERE vv.archive_id = f.archive_id AND vv.source_file_id = f.id
       ORDER BY vv.version_no DESC, vv.id DESC
       LIMIT 1
    ), (
      SELECT vv.id FROM archive_file_versions vv
       WHERE vv.archive_id = f.archive_id AND vv.source_file_id IS NULL
         AND f.extension = 'docx' AND f.id = (
           SELECT MIN(f2.id) FROM archive_files f2 WHERE f2.archive_id = f.archive_id AND f2.extension = 'docx'
         )
       ORDER BY vv.version_no DESC, vv.id DESC LIMIT 1
    ))`;

/** 证据列（只含列名与别名，拼接时由调用方补 SELECT 关键字）。 */
export const EVIDENCE_SELECT = `
  c.id                AS chunk_id,
  c.unit_id           AS unit_id,
  c.archive_id        AS archive_id,
  c.file_id           AS file_id,
  a.title             AS archive_title,
  a.archive_no        AS archive_no,
  f.original_name     AS file_name,
  f.extension         AS extension,
  u.version_no        AS version_no,
  u.version_id        AS version_id,
  c.locator           AS locator,
  c.page_no           AS page_no,
  c.pos_from          AS pos_from,
  c.pos_to            AS pos_to,
  c.text              AS text`;

@Injectable()
export class SqliteContentIndexRepository implements ContentIndexRepository {
  private fts: boolean;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
  ) {
    this.fts = hasContentBigramFts(db);
  }

  ftsAvailable(): boolean {
    return this.fts;
  }

  findUnitByStored(storedName: string): ContentUnitRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM archive_content_units WHERE stored_name = ?')
      .get(storedName) as Record<string, unknown> | undefined;
    return row ? toUnitRow(row) : undefined;
  }

  listUnitsByArchive(archiveId: number): ContentUnitRow[] {
    const rows = this.db
      .prepare('SELECT * FROM archive_content_units WHERE archive_id = ? ORDER BY file_id, id')
      .all(archiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toUnitRow);
  }

  listUnitsOfFile(fileId: number): ContentUnitRow[] {
    const rows = this.db
      .prepare('SELECT * FROM archive_content_units WHERE file_id = ? ORDER BY id')
      .all(fileId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toUnitRow);
  }

  replaceUnit(input: {
    archiveId: number;
    fileId: number;
    versionId: number | null;
    versionNo: number | null;
    storedName: string;
    sha256: string;
    extension: string;
    extractor: string;
    status: ExtractStatus;
    message: string;
    truncated: boolean;
    chunks: ChunkDraft[];
  }): ContentUnitRow {
    return this.tx.run(() => {
      const now = new Date().toISOString();
      // 同一物理文件重复提取（重试、并发改档）→ 先整体删除旧单元，避免同一版本重复入索引
      this.dropUnitByStored(input.storedName);
      const info = this.db
        .prepare(
          `INSERT INTO archive_content_units
           (archive_id, file_id, version_id, version_no, stored_name, sha256, extension,
            extractor, status, message, char_count, chunk_count, truncated, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.archiveId,
          input.fileId,
          input.versionId,
          input.versionNo,
          input.storedName,
          input.sha256,
          input.extension,
          input.extractor,
          input.status,
          input.message.slice(0, 300),
          input.chunks.reduce((sum, c) => sum + c.text.length, 0),
          input.chunks.length,
          input.truncated ? 1 : 0,
          now,
        );
      const unitId = Number(info.lastInsertRowid);
      const insertChunk = this.db.prepare(
        `INSERT INTO archive_content_chunks
         (unit_id, archive_id, file_id, chunk_no, locator, page_no, pos_from, pos_to, text, search_terms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of input.chunks) {
        insertChunk.run(
          unitId,
          input.archiveId,
          input.fileId,
          chunk.chunkNo,
          chunk.locator,
          chunk.pageNo,
          chunk.posFrom,
          chunk.posTo,
          chunk.text,
          buildCjkBigramTerms(chunk.text),
        );
        // Database triggers synchronize FTS for every writer, including cascades.
      }
      const row = this.db
        .prepare('SELECT * FROM archive_content_units WHERE id = ?')
        .get(unitId) as Record<string, unknown>;
      return toUnitRow(row);
    });
  }

  pruneUnitsExcept(fileId: number, keepStoredName: string): number {
    return this.tx.run(() => {
      const rows = this.db
        .prepare(
          'SELECT id, stored_name FROM archive_content_units WHERE file_id = ? AND stored_name <> ?',
        )
        .all(fileId, keepStoredName) as unknown as Array<{ id: number; stored_name: string }>;
      for (const row of rows) this.dropUnitById(Number(row.id));
      return rows.length;
    });
  }

  deleteByArchive(archiveId: number): number {
    return this.tx.run(() => {
      const rows = this.db
        .prepare('SELECT id FROM archive_content_units WHERE archive_id = ?')
        .all(archiveId) as unknown as Array<{ id: number }>;
      for (const row of rows) this.dropUnitById(Number(row.id));
      return rows.length;
    });
  }

  /** 删除索引单元：先同步 FTS rowid，再删片段（级联）与单元本体。 */
  private dropUnitById(unitId: number): void {
    if (this.fts) {
      this.db
        .prepare(
          `DELETE FROM archive_content_fts_bigram
            WHERE rowid IN (SELECT id FROM archive_content_chunks WHERE unit_id = ?)`,
        )
        .run(unitId);
    }
    this.db.prepare('DELETE FROM archive_content_chunks WHERE unit_id = ?').run(unitId);
    this.db.prepare('DELETE FROM archive_content_units WHERE id = ?').run(unitId);
  }

  private dropUnitByStored(storedName: string): void {
    const row = this.db
      .prepare('SELECT id FROM archive_content_units WHERE stored_name = ?')
      .get(storedName) as { id: number } | undefined;
    if (row) this.dropUnitById(Number(row.id));
  }

  searchChunks(term: string, scope: ViewerScope, limit: number, archiveIds?: number[], archiveNo?: string, archiveTitle?: string, fileIds?: number[]): EvidenceRow[] {
    if ((archiveIds && !archiveIds.length) || (fileIds && !fileIds.length)) return [];
    const keyword = String(term ?? '').trim();
    if (!keyword) return [];
    const scopeSql = scope.admin ? '' : ` AND ${ARCHIVE_VISIBILITY_SQL}`;
    const scopeArgs: number[] = scope.admin ? [] : [scope.userId, scope.userId];
    let idFilter = '';
    const idArgs: number[] = [];
    if (archiveIds && archiveIds.length) {
      idFilter = ` AND c.archive_id IN (${archiveIds.map(() => '?').join(',')})`;
      idArgs.push(...archiveIds);
    }
    if (fileIds?.length) {
      idFilter += ` AND c.file_id IN (${fileIds.map(() => '?').join(',')})`;
      idArgs.push(...fileIds);
    }
    const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    let archiveNoFilter = '';
    const archiveNoArgs: string[] = [];
    if (archiveNo) {
      archiveNoFilter = ` AND a.archive_no LIKE ? ESCAPE '\\'`;
      archiveNoArgs.push(like(archiveNo));
    }
    let archiveTitleFilter = '';
    const archiveTitleArgs: string[] = [];
    if (archiveTitle) {
      archiveTitleFilter = ` AND a.title LIKE ? ESCAPE '\\'`;
      archiveTitleArgs.push(like(archiveTitle));
    }
    // The primary index stores normalized CJK bigrams and whole Latin tokens.
    // Query terms are normalized by the same tokenizer; short Chinese terms (2 chars)
    // are first-class FTS tokens rather than a LIKE-only fallback.
    const queryTokens = extractLexicalTokens(keyword, 48);
    if (this.fts && queryTokens.length) {
      try {
      const match = buildBigramMatchExpression(queryTokens, 'OR');
      const rows = this.db
        .prepare(
          `SELECT ${EVIDENCE_SELECT}, -bm25(archive_content_fts_bigram) AS score
             FROM archive_content_fts_bigram
             JOIN archive_content_chunks c ON c.id = archive_content_fts_bigram.rowid
             JOIN archive_content_units   u ON u.id = c.unit_id
             JOIN archives                a ON a.id = c.archive_id
             JOIN archive_files           f ON f.id = c.file_id
             JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id = f.id AND cur.stored_name = u.stored_name AND cur.sha256 = u.sha256
            WHERE archive_content_fts_bigram MATCH ? AND u.status = 'indexed'${idFilter}${archiveNoFilter}${archiveTitleFilter}${scopeSql}
            ORDER BY score DESC
            LIMIT ?`,
        )
        .all(match, ...idArgs, ...archiveNoArgs, ...archiveTitleArgs, ...scopeArgs, limit) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => toEvidence(r, Number(r.score ?? 0)));
      } catch {
        // FTS may become unavailable after startup. The same authorized SQL
        // constraints below still apply; a failing LIKE query propagates normally.
        this.fts = false;
      }
    }
    const likeKeyword = `%${escapeLike(keyword)}%`;
    const visibility = scope.admin ? '' : ` AND ${ARCHIVE_VISIBILITY_SQL}`;
    const visibilityArgs: number[] = scope.admin ? [] : [scope.userId, scope.userId];
    const rows = this.db
      .prepare(
        `SELECT ${EVIDENCE_SELECT},
                1.0 * (LENGTH(c.text) - LENGTH(REPLACE(c.text, ?, ''))) / MAX(LENGTH(?), 1) AS hit_rate
           FROM archive_content_chunks c
           JOIN archive_content_units   u ON u.id = c.unit_id
           JOIN archives                a ON a.id = c.archive_id
           JOIN archive_files           f ON f.id = c.file_id
           JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id = f.id AND cur.stored_name = u.stored_name AND cur.sha256 = u.sha256
          WHERE u.status = 'indexed' AND c.text LIKE ? ESCAPE '\\'${idFilter}${archiveNoFilter}${archiveTitleFilter}${visibility}
          ORDER BY hit_rate DESC, c.id ASC
          LIMIT ?`,
      )
      .all(
        keyword,
        keyword,
        likeKeyword,
        ...idArgs,
        ...archiveNoArgs,
        ...archiveTitleArgs,
        ...visibilityArgs,
        limit,
      ) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => toEvidence(r, Number(r.hit_rate ?? 1)));
  }

  listChunksOfArchives(archiveIds: number[], scope: ViewerScope, limit: number, fileIds?: number[], offset = 0): EvidenceRow[] {
    if (fileIds && !fileIds.length) return [];
    const files = fileIds?.length ? ` AND c.file_id IN (${fileIds.map(() => '?').join(',')})` : '';
    if (!archiveIds.length) return [];
    const placeholders = archiveIds.map(() => '?').join(',');
    const visibility = scope.admin ? '' : ` AND ${ARCHIVE_VISIBILITY_SQL}`;
    const visibilityArgs: number[] = scope.admin ? [] : [scope.userId, scope.userId];
    const rows = this.db
      .prepare(
        `SELECT ${EVIDENCE_SELECT}, c.chunk_no AS order_no
           FROM archive_content_chunks c
           JOIN archive_content_units   u ON u.id = c.unit_id
           JOIN archives                a ON a.id = c.archive_id
           JOIN archive_files           f ON f.id = c.file_id
           JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id = f.id AND cur.stored_name = u.stored_name AND cur.sha256 = u.sha256
          WHERE c.archive_id IN (${placeholders}) AND u.status = 'indexed'${files}${visibility}
          ORDER BY c.archive_id, c.file_id, c.chunk_no
          LIMIT ? OFFSET ?`,
      )
      .all(...archiveIds, ...(fileIds ?? []), ...visibilityArgs, limit, offset) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => toEvidence(r, 1000 - Number(r.order_no ?? 1)));
  }
}

export function toEvidence(r: Record<string, unknown>, score: number): EvidenceRow {
  return {
    chunkId: Number(r.chunk_id),
    pageNo: r.page_no == null ? null : Number(r.page_no),
    versionId:r.version_id==null?null:Number(r.version_id),
    posFrom: Number(r.pos_from ?? 0),
    posTo: Number(r.pos_to ?? 0),
    unitId: Number(r.unit_id),
    archiveId: Number(r.archive_id),
    fileId: Number(r.file_id),
    archiveTitle: String(r.archive_title ?? ''),
    archiveNo: String(r.archive_no ?? ''),
    fileName: String(r.file_name ?? ''),
    extension: String(r.extension ?? ''),
    versionNo: r.version_no == null ? null : Number(r.version_no),
    locator: String(r.locator ?? ''),
    text: String(r.text ?? ''),
    score,
  };
}

function toUnitRow(r: Record<string, unknown>): ContentUnitRow {
  return {
    id: Number(r.id),
    archiveId: Number(r.archive_id),
    fileId: Number(r.file_id),
    versionId: r.version_id == null ? null : Number(r.version_id),
    versionNo: r.version_no == null ? null : Number(r.version_no),
    storedName: String(r.stored_name),
    sha256: String(r.sha256 ?? ''),
    extension: String(r.extension ?? ''),
    extractor: String(r.extractor ?? ''),
    status: String(r.status) as ExtractStatus,
    message: String(r.message ?? ''),
    charCount: Number(r.char_count ?? 0),
    chunkCount: Number(r.chunk_count ?? 0),
    truncated: Number(r.truncated ?? 0) === 1,
    indexedAt: String(r.indexed_at ?? ''),
  };
}

/** LIKE 通配符转义（与既有档案检索一致）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
