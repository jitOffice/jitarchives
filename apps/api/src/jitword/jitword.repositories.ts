/**
 * 档案文档关联与文件版本仓储（阶段二第三批）。
 * 沿用既有仓储模式：抽象类作为 DI Token，SQLite 实现绑定集中在模块，SQL 一律参数化。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { SqliteTransaction } from '../db/transaction';

export type DocumentEditState = 'linked' | 'editing' | 'saved' | 'unsupported';
export type VersionOrigin = 'upload' | 'jitword_export_reupload' | 'jitword_auto_export';

export interface DocumentRow {
  id: number;
  archiveId: number;
  docId: string;
  docName: string;
  externalSubject: string;
  creatorUserId: number;
  editState: DocumentEditState;
  sourceFileId: number | null;
  createdAt: string;
  lastSavedAt: string | null;
  /** 附件正文导入远端文档的时间；NULL 表示从未导入过。 */
  seededAt: string | null;
  creatorName?: string;
  creatorRole?: string;
}

export interface VersionRow {
  id: number;
  archiveId: number;
  documentId: number | null;
  sourceFileId: number | null;
  storedName: string;
  versionNo: number;
  sha256: string;
  fileSize: number;
  origin: VersionOrigin;
  createdBy: number;
  createdAt: string;
  creatorName?: string;
}

// ---------- 文档关联仓储 ----------

export abstract class DocumentRepository {
  abstract findByArchiveId(archiveId: number): DocumentRow | undefined;
  /** 按「档案 + 源附件」精确定位在线文档关联（同档案不同附件可各有一条）。 */
  abstract findBySourceFileId(archiveId: number, sourceFileId: number): DocumentRow | undefined;
  /** 该档案的全部在线文档关联，按创建顺序返回。 */
  abstract listByArchiveId(archiveId: number): DocumentRow[];
  abstract insert(input: {
    archiveId: number;
    docId: string;
    docName: string;
    externalSubject: string;
    creatorUserId: number;
    editState: DocumentEditState;
    sourceFileId: number | null;
  }): DocumentRow;
  abstract updateState(
    id: number,
    patch: { editState?: DocumentEditState; lastSavedAt?: string | null; seededAt?: string | null },
  ): DocumentRow | undefined;
}

const DOC_COLUMNS = `
  d.id, d.archive_id, d.doc_id, d.doc_name, d.external_subject, d.creator_user_id,
  d.edit_state, d.source_file_id, d.created_at, d.last_saved_at, d.seeded_at,
  u.display_name AS creator_name, u.role AS creator_role`;

function toDocumentRow(r: Record<string, unknown>): DocumentRow {
  return {
    id: Number(r.id),
    archiveId: Number(r.archive_id),
    docId: String(r.doc_id),
    docName: String(r.doc_name),
    externalSubject: String(r.external_subject),
    creatorUserId: Number(r.creator_user_id),
    editState: String(r.edit_state) as DocumentEditState,
    sourceFileId: r.source_file_id == null ? null : Number(r.source_file_id),
    createdAt: String(r.created_at),
    lastSavedAt: r.last_saved_at == null ? null : String(r.last_saved_at),
    seededAt: r.seeded_at == null ? null : String(r.seeded_at),
    creatorName: r.creator_name == null ? undefined : String(r.creator_name),
    creatorRole: r.creator_role == null ? undefined : String(r.creator_role),
  };
}

@Injectable()
export class SqliteDocumentRepository implements DocumentRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  findByArchiveId(archiveId: number): DocumentRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${DOC_COLUMNS} FROM archive_documents d
         LEFT JOIN users u ON u.id = d.creator_user_id
         WHERE d.archive_id = ? ORDER BY d.id ASC LIMIT 1`,
      )
      .get(archiveId);
    return row ? toDocumentRow(row as unknown as Record<string, unknown>) : undefined;
  }

  findBySourceFileId(archiveId: number, sourceFileId: number): DocumentRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${DOC_COLUMNS} FROM archive_documents d
         LEFT JOIN users u ON u.id = d.creator_user_id
         WHERE d.archive_id = ? AND d.source_file_id = ? LIMIT 1`,
      )
      .get(archiveId, sourceFileId);
    return row ? toDocumentRow(row as unknown as Record<string, unknown>) : undefined;
  }

  listByArchiveId(archiveId: number): DocumentRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${DOC_COLUMNS} FROM archive_documents d
         LEFT JOIN users u ON u.id = d.creator_user_id
         WHERE d.archive_id = ? ORDER BY d.id ASC`,
      )
      .all(archiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toDocumentRow);
  }

  insert(input: {
    archiveId: number;
    docId: string;
    docName: string;
    externalSubject: string;
    creatorUserId: number;
    editState: DocumentEditState;
    sourceFileId: number | null;
  }): DocumentRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO archive_documents
         (archive_id, doc_id, doc_name, external_subject, creator_user_id, edit_state, source_file_id, created_at, last_saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.archiveId,
        input.docId,
        input.docName,
        input.externalSubject,
        input.creatorUserId,
        input.editState,
        input.sourceFileId,
        now,
      );
    return this.findById(Number(info.lastInsertRowid))!;
  }

  private findById(id: number): DocumentRow | undefined {
    const row = this.db
      .prepare(`SELECT ${DOC_COLUMNS} FROM archive_documents d LEFT JOIN users u ON u.id = d.creator_user_id WHERE d.id = ?`)
      .get(id);
    return row ? toDocumentRow(row as unknown as Record<string, unknown>) : undefined;
  }

  updateState(
    id: number,
    patch: { editState?: DocumentEditState; lastSavedAt?: string | null; seededAt?: string | null },
  ): DocumentRow | undefined {
    const current = this.findById(id);
    if (!current) return undefined;
    this.db
      .prepare('UPDATE archive_documents SET edit_state = ?, last_saved_at = ?, seeded_at = ? WHERE id = ?')
      .run(
        patch.editState ?? current.editState,
        patch.lastSavedAt !== undefined ? patch.lastSavedAt : current.lastSavedAt,
        patch.seededAt !== undefined ? patch.seededAt : current.seededAt,
        id,
      );
    return this.findById(id);
  }
}

// ---------- 文件版本仓储 ----------

export abstract class VersionRepository {
  abstract listByArchiveId(archiveId: number): VersionRow[];
  abstract nextVersionNo(archiveId: number): number;
  abstract findById(id: number): VersionRow | undefined;
  abstract insert(input: {
    archiveId: number;
    documentId: number | null;
    sourceFileId: number | null;
    storedName: string;
    versionNo: number;
    sha256: string;
    fileSize: number;
    origin: VersionOrigin;
    createdBy: number;
  }): VersionRow;
  /** 事务内部使用：原子分配版本号并插入，防并发重复。 */
  abstract insertInTx(input: {
    archiveId: number;
    documentId: number | null;
    sourceFileId: number | null;
    storedName: string;
    sha256: string;
    fileSize: number;
    origin: VersionOrigin;
    createdBy: number;
  }): VersionRow;
  abstract countByArchiveId(archiveId: number): number;
}

const VERSION_COLUMNS = `
  v.id, v.archive_id, v.document_id, v.source_file_id, v.stored_name, v.version_no,
  v.sha256, v.file_size, v.origin, v.created_by, v.created_at,
  u.display_name AS creator_name`;

function toVersionRow(r: Record<string, unknown>): VersionRow {
  return {
    id: Number(r.id),
    archiveId: Number(r.archive_id),
    documentId: r.document_id == null ? null : Number(r.document_id),
    sourceFileId: r.source_file_id == null ? null : Number(r.source_file_id),
    storedName: String(r.stored_name),
    versionNo: Number(r.version_no),
    sha256: String(r.sha256),
    fileSize: Number(r.file_size),
    origin: String(r.origin) as VersionOrigin,
    createdBy: Number(r.created_by),
    createdAt: String(r.created_at),
    creatorName: r.creator_name == null ? undefined : String(r.creator_name),
  };
}

@Injectable()
export class SqliteVersionRepository implements VersionRepository {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
  ) {}

  listByArchiveId(archiveId: number): VersionRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM archive_file_versions v
         LEFT JOIN users u ON u.id = v.created_by
         WHERE v.archive_id = ? ORDER BY v.version_no DESC, v.id DESC`,
      )
      .all(archiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toVersionRow);
  }

  findById(id: number): VersionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM archive_file_versions v
         LEFT JOIN users u ON u.id = v.created_by WHERE v.id = ?`,
      )
      .get(id);
    return row ? toVersionRow(row as unknown as Record<string, unknown>) : undefined;
  }

  nextVersionNo(archiveId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM archive_file_versions WHERE archive_id = ?')
      .get(archiveId) as unknown as { m: number | bigint };
    return Number(row.m) + 1;
  }

  countByArchiveId(archiveId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM archive_file_versions WHERE archive_id = ?')
      .get(archiveId) as unknown as { c: number | bigint };
    return Number(row.c);
  }

  insert(input: {
    archiveId: number;
    documentId: number | null;
    sourceFileId: number | null;
    storedName: string;
    versionNo: number;
    sha256: string;
    fileSize: number;
    origin: VersionOrigin;
    createdBy: number;
  }): VersionRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO archive_file_versions
         (archive_id, document_id, source_file_id, stored_name, version_no, sha256, file_size, origin, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.archiveId,
        input.documentId,
        input.sourceFileId,
        input.storedName,
        input.versionNo,
        input.sha256,
        input.fileSize,
        input.origin,
        input.createdBy,
        now,
      );
    return this.findById(Number(info.lastInsertRowid))!;
  }

  insertInTx(input: {
    archiveId: number;
    documentId: number | null;
    sourceFileId: number | null;
    storedName: string;
    sha256: string;
    fileSize: number;
    origin: VersionOrigin;
    createdBy: number;
  }): VersionRow {
    return this.tx.run(() => {
      const versionNo = this.nextVersionNo(input.archiveId);
      return this.insert({ ...input, versionNo });
    });
  }
}
