/**
 * 档案核心业务仓储：分类 / 档案 / 附件（阶段二第二批）。
 * 沿用第一批模式：抽象类作为 DI Token，SQLite 实现在此绑定，
 * 切换 PostgreSQL 时新增实现类并替换 DatabaseModule 的 useClass 即可。
 * 所有 SQL 一律参数化，禁止字符串拼接用户输入。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, hasContentFts } from '../db/database';
import { SqliteTransaction } from '../db/transaction';
import { roleLabel, Role } from '../common/roles';

// ---------- 行结构 ----------

export interface CategoryRow {
  id: number;
  name: string;
  code: string;
  description: string;
  parentId: number | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export type ArchiveStatus = 'draft' | 'archived';
export type ArchiveAccessLevel = 'public' | 'restricted';

export interface ArchiveRow {
  id: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  archiveType: string;
  keywords: string;
  formationDate: string | null;
  responsible: string;
  remarks: string;
  status: ArchiveStatus;
  /** 档案级访问级别（阶段二第四批）：public 沿用角色矩阵，restricted 需借阅授权。 */
  accessLevel: ArchiveAccessLevel;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
  /** JOIN users 带来的创建人姓名（展示用途） */
  creatorName?: string;
  /** JOIN users 带来的创建人角色（展示用途） */
  creatorRole?: string;
}


export interface FileRow {
  id: number;
  archiveId: number;
  originalName: string;
  storedName: string;
  extension: string;
  fileSize: number;
  contentType: string;
  sha256: string;
  uploadedBy: number;
  uploadedAt: string;
  uploaderName?: string;
  /** 电子文件角色（一体化优化）：主文档/普通附件/正式签署文件/原始文件。 */
  /** 该文件当前最新已入库版本 id（archive_file_versions.id）；无版本时为 null。 */
}

export interface CreateArchiveInput {
  title: string;
  archiveNo: string;
  categoryId: number;
  archiveType: string;
  keywords: string;
  formationDate: string | null;
  responsible: string;
  remarks: string;
  status: ArchiveStatus;
  accessLevel: ArchiveAccessLevel;
  createdBy: number;
}

export interface ArchiveSearchParams {
  dateField?: 'formationDate' | 'createdAt' | 'updatedAt';
  dateFrom?: string;
  dateTo?: string;
  metadataConditions?: Array<{ field: string; value: string }>;
  metadataOnly?: boolean;
  archiveNoExact?: boolean;
  keyword: string;
  /**
   * 仅按标题匹配（Agent 助理「按标题检索」意图使用）。
   * 与 keyword 互斥优先：传入 title 时不再叠加 keyword 的 OR 命中，避免标题检索被档号/关键词干扰。
   */
  title?: string;
  /** 仅按档号匹配（前缀/包含，Agent 助理「按档号检索」意图使用）。 */
  archiveNo?: string;
  categoryId: number | null;
  /** 是否连同子分类一起检索 */
  includeSub: boolean;
  status: ArchiveStatus | '';
  /** 命中分类集合（null = 不限） */
  categoryIds: number[] | null;
  /** 是否同时匹配动态元数据著录值（一体化优化 · 检索扩展，默认开启）。 */
  matchDynamic?: boolean;
  /** Knowledge metadata reads extend the existing query without changing ordinary catalog search. */
  knowledgeMetadata?: boolean;
  archiveIds?: number[];
  page: number;
  pageSize: number;
  /** 访问者（阶段二第四批）：用于检索结果按可见权限过滤（受限档案仅授权可见）。 */
  viewer?: { id: number; role: Role };
}

export interface ArchiveSearchResult {
  items: ArchiveRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** 物理删除返回的清理结果：物理文件名供服务层在事务提交后清理 file-store。 */
export interface ArchivePurgeResult {
  fileStoredNames: string[];
  fileCount: number;
  versionCount: number;
}

/** 借阅目录项（阶段二第四批）：仅目录级字段，供无权用户发现并发起借阅申请。 */
export interface BorrowCatalogItem {
  id: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  archiveType: string;
  accessLevel: ArchiveAccessLevel;
}

// ---------- 分类仓储 ----------

export abstract class CategoryRepository {
  abstract listAll(): CategoryRow[];
  abstract findById(id: number): CategoryRow | undefined;
  abstract insert(input: {
    name: string;
    code: string;
    description: string;
    parentId: number | null;
    createdBy: number | null;
  }): CategoryRow;
  abstract update(
    id: number,
    patch: { name?: string; code?: string; description?: string; parentId?: number | null },
  ): CategoryRow | undefined;
  /** 各分类下档案数量（真实统计，用于目录展示与引用保护）。 */
  abstract archiveCountByCategory(viewer?: { id: number; role: Role }): Map<number, number>;
  /** 物理删除分类；子分类与档案引用的前置校验由服务层负责（本层只执行删除）。 */
  abstract deleteById(id: number): void;
}

const CATEGORY_COLUMNS = `
  id, name, code, description, parent_id, created_by, created_at, updated_at`;

function toCategoryRow(r: Record<string, unknown>): CategoryRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    code: String(r.code),
    description: String(r.description ?? ''),
    parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    createdBy: r.created_by === null || r.created_by === undefined ? null : Number(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class SqliteCategoryRepository implements CategoryRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  listAll(): CategoryRow[] {
    const rows = this.db
      .prepare(`SELECT ${CATEGORY_COLUMNS} FROM archive_categories ORDER BY id ASC`)
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map(toCategoryRow);
  }

  findById(id: number): CategoryRow | undefined {
    const row = this.db
      .prepare(`SELECT ${CATEGORY_COLUMNS} FROM archive_categories WHERE id = ?`)
      .get(id);
    return row ? toCategoryRow(row as unknown as Record<string, unknown>) : undefined;
  }

  insert(input: {
    name: string;
    code: string;
    description: string;
    parentId: number | null;
    createdBy: number | null;
  }): CategoryRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO archive_categories (name, code, description, parent_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.code, input.description, input.parentId, input.createdBy, now, now);
    return this.findById(Number(info.lastInsertRowid))!;
  }

  update(
    id: number,
    patch: { name?: string; code?: string; description?: string; parentId?: number | null },
  ): CategoryRow | undefined {
    const current = this.findById(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE archive_categories SET name = ?, code = ?, description = ?, parent_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.code ?? current.code,
        patch.description ?? current.description,
        patch.parentId !== undefined ? patch.parentId : current.parentId,
        new Date().toISOString(),
        id,
      );
    return this.findById(id);
  }

  archiveCountByCategory(viewer?: { id: number; role: Role }): Map<number, number> {
    // 非管理员的分类数量按可见权限过滤，避免通过分类统计窥探到受限档案的存在。
    let sql = 'SELECT category_id, COUNT(*) AS c FROM archives';
    const args: Array<string | number> = [];
    if (viewer && viewer.role !== 'admin') {
      sql += ` WHERE access_level = 'public' OR created_by = ? OR EXISTS (
        SELECT 1 FROM borrow_grants g
        WHERE g.archive_id = archives.id AND g.user_id = ?
          AND g.status = 'active' AND datetime(g.expires_at) > datetime('now')
      )`;
      args.push(viewer.id, viewer.id);
    }
    sql += ' GROUP BY category_id';
    const rows = this.db
      .prepare(sql)
      .all(...args) as unknown as Array<{ category_id: number | bigint; c: number | bigint }>;
    const map = new Map<number, number>();
    for (const r of rows) map.set(Number(r.category_id), Number(r.c));
    return map;
  }

  deleteById(id: number): void {
    // 分类↔模板绑定为 ON DELETE CASCADE；档案与子分类无级联，删除前由服务层拦截。
    this.db.prepare('DELETE FROM archive_categories WHERE id = ?').run(id);
  }
}

// ---------- 档案仓储 ----------

export abstract class ArchiveRepository {
  abstract findById(id: number): ArchiveRow | undefined;
  abstract search(p: ArchiveSearchParams): ArchiveSearchResult;
  /** 新增档案：同一事务内插入并用全局自增 id 生成唯一档号回写。 */
  abstract createWithSeqNo(input: CreateArchiveInput, buildNo: (seq: number) => string): ArchiveRow;
  /** 仅事务内部使用：整字段补丁更新，返回最新行。 */
  abstract applyUpdate(id: number, patch: Partial<ArchiveRow>): ArchiveRow | undefined;
  /**
   * 物理删除档案及其从属数据（服务层已完成状态/归属校验，本层只执行删除）。
   * 删除顺序按外键依赖排列，避免级联过程中互相阻碍；返回物理文件名清单。
   */
  abstract purge(id: number): ArchivePurgeResult;
  abstract listFiles(archiveId: number): FileRow[];
  /**
   * 借阅目录（阶段二第四批）：列出受限且当前用户尚未持有有效授权的档案，
   * 仅返回目录级字段（无备注/附件/动态值），供发现与发起申请。
   */
  abstract listBorrowCatalog(userId: number): BorrowCatalogItem[];
}

const ARCHIVE_SELECT = `
  SELECT a.*, u.display_name AS creator_name, u.role AS creator_role
  FROM archives a LEFT JOIN users u ON u.id = a.created_by`;

/**
 * 非管理员的检索可见范围（参数化：user_id 两次）：
 * public 档案、自建档案、或存在未过期且 active 的借阅授权（已归还未过期）的受限档案。
 * 第二阶段附件正文检索复用同一条件，保证「目录可见」与「正文可见」口径完全一致。
 */
export const ARCHIVE_VISIBILITY_SQL = `(
  a.access_level = 'public'
  OR a.created_by = ?
  OR EXISTS (
    SELECT 1 FROM borrow_grants g
    WHERE g.archive_id = a.id AND g.user_id = ?
      AND g.can_view = 1 AND g.status = 'active' AND datetime(g.expires_at) > datetime('now')
  )
)`;

function toArchiveRow(r: Record<string, unknown>): ArchiveRow {
  return {
    id: Number(r.id),
    title: String(r.title),
    archiveNo: String(r.archive_no),
    categoryId: Number(r.category_id),
    archiveType: String(r.archive_type),
    keywords: String(r.keywords ?? ''),
    formationDate: r.formation_date == null ? null : String(r.formation_date),
    responsible: String(r.responsible ?? ''),
    remarks: String(r.remarks ?? ''),
    status: String(r.status) as ArchiveStatus,
    accessLevel: String(r.access_level ?? 'public') as ArchiveAccessLevel,
    createdBy: Number(r.created_by),
    updatedBy: Number(r.updated_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    creatorName: r.creator_name == null ? undefined : String(r.creator_name),
    creatorRole: r.creator_role == null ? undefined : String(r.creator_role),
  };
}

/** 全部可写字段与列名的映射（补丁更新用）。 */
const ARCHIVE_FIELD_COLUMNS: Partial<Record<keyof ArchiveRow, string>> = {
  title: 'title',
  categoryId: 'category_id',
  archiveType: 'archive_type',
  keywords: 'keywords',
  formationDate: 'formation_date',
  responsible: 'responsible',
  remarks: 'remarks',
  status: 'status',
  accessLevel: 'access_level',
  updatedBy: 'updated_by',
  archiveNo: 'archive_no',
};

@Injectable()
export class SqliteArchiveRepository implements ArchiveRepository {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
  ) {}

  findById(id: number): ArchiveRow | undefined {
    const row = this.db.prepare(`${ARCHIVE_SELECT} WHERE a.id = ?`).get(id);
    return row ? toArchiveRow(row as unknown as Record<string, unknown>) : undefined;
  }

  search(p: ArchiveSearchParams): ArchiveSearchResult {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    if (p.archiveNo) {
      // 档号检索：只命中 archive_no（可见性过滤与分页规则与其他检索完全一致）
      where.push(p.archiveNoExact ? 'a.archive_no = ?' : `a.archive_no LIKE ? ESCAPE '\\'`);
      args.push(p.archiveNoExact ? p.archiveNo : like(p.archiveNo));
    } else if (p.title) {
      // 标题检索：只命中 title
      where.push(`a.title LIKE ? ESCAPE '\\'`);
      args.push(like(p.title));
    } else if (p.keyword) {
      // 参数化 LIKE，转义 LIKE 元字符；不区分大小写沿用 SQLite 默认 ASCII 行为，中文按包含匹配
      const escapedKeyword = like(p.keyword);
      const keywordClauses = p.metadataOnly ? [
        `a.responsible LIKE ? ESCAPE '\\'`, `a.remarks LIKE ? ESCAPE '\\'`, `a.keywords LIKE ? ESCAPE '\\'`,
      ] : [
        `a.title LIKE ? ESCAPE '\\'`,
        `a.archive_no LIKE ? ESCAPE '\\'`,
        `a.keywords LIKE ? ESCAPE '\\'`,
      ];
      const keywordArgs: string[] = [escapedKeyword, escapedKeyword, escapedKeyword];
      if (p.knowledgeMetadata) {
        for (const column of ['remarks', 'responsible', 'formation_date', 'created_at', 'updated_at', 'archive_type', 'status']) {
          keywordClauses.push(`a.${column} LIKE ? ESCAPE '\\'`);
          keywordArgs.push(escapedKeyword);
        }
        keywordClauses.push(`EXISTS (SELECT 1 FROM archive_categories kc WHERE kc.id=a.category_id AND (kc.name LIKE ? ESCAPE '\\' OR kc.code LIKE ? ESCAPE '\\'))`);
        keywordArgs.push(escapedKeyword, escapedKeyword);
      }
      // 一体化优化：命中动态元数据著录值（value_text），默认开启，保持可见性过滤不变。
      if (p.matchDynamic !== false) {
        keywordClauses.push(
          `EXISTS (SELECT 1 FROM archive_field_values v WHERE v.archive_id = a.id AND v.value_text LIKE ? ESCAPE '\\')`,
        );
        keywordArgs.push(escapedKeyword);
      }
      where.push(`(${keywordClauses.join(' OR ')})`);
      args.push(...keywordArgs);
    }
    if (p.categoryIds) {
      where.push(`a.category_id IN (${p.categoryIds.map(() => '?').join(',')})`);
      args.push(...p.categoryIds);
    }
    if (p.archiveIds) {
      where.push(p.archiveIds.length ? `a.id IN (${p.archiveIds.map(() => '?').join(',')})` : '0=1');
      args.push(...p.archiveIds);
    }
    if (p.status) {
      where.push('a.status = ?');
      args.push(p.status);
    }
    const dateColumns = { formationDate: 'formation_date', createdAt: 'created_at', updatedAt: 'updated_at' };
    const dateColumn = dateColumns[p.dateField ?? 'formationDate'];
    if (p.dateFrom) { where.push(`substr(a.${dateColumn},1,10) >= ?`); args.push(p.dateFrom); }
    if (p.dateTo) { where.push(`substr(a.${dateColumn},1,10) <= ?`); args.push(p.dateTo); }
    const fixedFields: Record<string, string> = { responsible: 'responsible', '责任者': 'responsible', keywords: 'keywords', '关键词': 'keywords', remarks: 'remarks', '备注': 'remarks', archiveType: 'archive_type', '档案类型': 'archive_type' };
    for (const condition of p.metadataConditions ?? []) {
      const column = fixedFields[condition.field];
      if (column) { where.push(`a.${column} LIKE ? ESCAPE '\\'`); args.push(like(condition.value)); }
      else {
        where.push(`EXISTS (SELECT 1 FROM archive_field_values mv JOIN template_fields mf ON mf.id=mv.field_id WHERE mv.archive_id=a.id AND (mf.field_key=? OR mf.label=?) AND mv.value_text LIKE ? ESCAPE '\\')`);
        args.push(condition.field, condition.field, like(condition.value));
      }
    }
    // 可见权限过滤（阶段二第四批）：非管理员仅可见 public 档案、自建档案、已授权（active 未过期）的受限档案。
    if (p.viewer && p.viewer.role !== 'admin') {
      where.push(ARCHIVE_VISIBILITY_SQL);
      args.push(p.viewer.id, p.viewer.id);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS c FROM archives a${clause}`)
          .get(...args) as unknown as { c: number | bigint }
      ).c,
    );
    const rows = this.db
      .prepare(
        `${ARCHIVE_SELECT}${clause}
         ORDER BY ${p.title ? "CASE WHEN a.title=? THEN 0 WHEN substr(a.title,1,length(?))=? THEN 1 ELSE 2 END," : ''} datetime(a.created_at) DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, ...(p.title ? [p.title, p.title, p.title] : []), p.pageSize, (p.page - 1) * p.pageSize) as unknown as Array<
        Record<string, unknown>
      >;
    return { items: rows.map(toArchiveRow), total, page: p.page, pageSize: p.pageSize };
  }

  createWithSeqNo(input: CreateArchiveInput, buildNo: (seq: number) => string): ArchiveRow {
    return this.tx.run(() => {
      const now = new Date().toISOString();
      const info = this.db
        .prepare(
          `INSERT INTO archives
           (title, archive_no, category_id, archive_type, keywords, formation_date, responsible,
            remarks, status, access_level, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title,
          '', // 占位，随后用自增 id 生成的唯一档号覆盖
          input.categoryId,
          input.archiveType,
          input.keywords,
          input.formationDate,
          input.responsible,
          input.remarks,
          input.status,
          input.accessLevel,
          input.createdBy,
          input.createdBy,
          now,
          now,
        );
      const id = Number(info.lastInsertRowid);
      const no = buildNo(id);
      this.db.prepare('UPDATE archives SET archive_no = ? WHERE id = ?').run(no, id);
      return this.findById(id)!;
    });
  }

  applyUpdate(id: number, patch: Partial<ArchiveRow>): ArchiveRow | undefined {
    return this.tx.run(() => {
      const sets: string[] = [];
      const args: Array<string | number | null> = [];
      for (const [key, col] of Object.entries(ARCHIVE_FIELD_COLUMNS) as Array<
        [keyof ArchiveRow, string]
      >) {
        if (patch[key] !== undefined) {
          sets.push(`${col} = ?`);
          args.push(patch[key] as string | number | null);
        }
      }
      if (sets.length === 0) return this.findById(id);
      sets.push('updated_at = ?');
      args.push(new Date().toISOString(), id);
      this.db.prepare(`UPDATE archives SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      return this.findById(id);
    });
  }

  purge(id: number): ArchivePurgeResult {
    return this.tx.run(() => {
      // 先取出物理文件名：删除元数据后无法再反查，需交给服务层在提交后清理磁盘。
      const fileStoredNames = this.storedNamesOf('archive_files', id);
      const versionStoredNames = this.storedNamesOf('archive_file_versions', id);
      // 先删引用方再删被引用方：archive_documents.source_file_id / archive_file_versions
      // 引用附件时无级联规则，顺序错误会触发外键失败。
      const hasLegacyGeneratedDocs = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generated_document_records'").get();
      if (hasLegacyGeneratedDocs) this.db.prepare('DELETE FROM generated_document_records WHERE archive_id = ?').run(id);
      // 第二阶段：附件正文索引随档案一并失效（先清 FTS rowid，再清片段与单元）；
      // 否则档案删除后会留下无法回溯来源的幽灵命中。FTS5 不可用时跳过倒排表清理。
      if (hasContentFts(this.db)) {
        this.db
          .prepare(
            `DELETE FROM archive_content_fts
              WHERE rowid IN (SELECT id FROM archive_content_chunks WHERE archive_id = ?)`,
          )
          .run(id);
      }
      this.db.prepare('DELETE FROM archive_content_chunks WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM archive_content_units WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM archive_file_versions WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM archive_documents WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM archive_files WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM archive_field_values WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM borrow_grants WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM borrow_requests WHERE archive_id = ?').run(id);
      this.db.prepare('DELETE FROM archives WHERE id = ?').run(id);
      return {
        fileStoredNames: [...fileStoredNames, ...versionStoredNames],
        fileCount: fileStoredNames.length,
        versionCount: versionStoredNames.length,
      };
    });
  }

  /** 取某档案下指定表的物理文件名（表名内部常量，不接受外部输入）。 */
  private storedNamesOf(table: 'archive_files' | 'archive_file_versions', archiveId: number): string[] {
    const rows = this.db
      .prepare(`SELECT stored_name FROM ${table} WHERE archive_id = ?`)
      .all(archiveId) as unknown as Array<{ stored_name: string }>;
    return rows.map((r) => String(r.stored_name));
  }

  listFiles(archiveId: number): FileRow[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, u.display_name AS uploader_name
         FROM archive_files f LEFT JOIN users u ON u.id = f.uploaded_by
         WHERE f.archive_id = ? ORDER BY f.id ASC`,
      )
      .all(archiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      archiveId: Number(r.archive_id),
      originalName: String(r.original_name),
      storedName: String(r.stored_name),
      extension: String(r.extension),
      fileSize: Number(r.file_size),
      contentType: String(r.content_type ?? ''),
      sha256: String(r.sha256 ?? ''),
      uploadedBy: Number(r.uploaded_by),
      uploadedAt: String(r.uploaded_at),
      uploaderName: r.uploader_name == null ? undefined : String(r.uploader_name),
    }));
  }

  listBorrowCatalog(userId: number): BorrowCatalogItem[] {
    // 仅受限档案，且排除当前用户已持有未过期 active 授权的（已可读无需再借）。
    const rows = this.db
      .prepare(
        `SELECT a.id, a.title, a.archive_no, a.category_id, c.name AS category_name,
                a.archive_type, a.access_level
         FROM archives a LEFT JOIN archive_categories c ON c.id = a.category_id
         WHERE a.access_level = 'restricted'
           AND NOT EXISTS (
             SELECT 1 FROM borrow_grants g
             WHERE g.archive_id = a.id AND g.user_id = ?
               AND g.status = 'active' AND datetime(g.expires_at) > datetime('now')
           )
         ORDER BY datetime(a.created_at) DESC, a.id DESC`,
      )
      .all(userId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      archiveNo: String(r.archive_no),
      categoryId: Number(r.category_id),
      categoryName: r.category_name == null ? '未分类' : String(r.category_name),
      archiveType: String(r.archive_type ?? ''),
      accessLevel: String(r.access_level) as ArchiveAccessLevel,
    }));
  }
}

// ---------- 附件仓储 ----------

export abstract class FileRepository {
  abstract insert(input: {
    archiveId: number;
    originalName: string;
    storedName: string;
    extension: string;
    fileSize: number;
    contentType: string;
    sha256: string;
    uploadedBy: number;
  }): FileRow;
  abstract findById(id: number): FileRow | undefined;
  abstract delete(id: number): void;
  /**
   * 删除单个附件并解除引用：先把在线文档 / 文件版本指向该附件的 source_file_id 置空
   * （该列无 ON DELETE 级联，不置空会触发外键约束阻止删除），再删本体。
   * 正文索引单元/片段、FTS 倒排、知识库任务与向量由 knowledge_file_cleanup 触发器
   * 与 archive_files 上的 ON DELETE CASCADE 自动清理，调用方无需关心。
   */
  abstract deleteDetached(id: number): void;
  /** 目录名唯一性辅助：某档案下同名附件计数（用于同名加序号）。 */
  abstract countSameName(archiveId: number, originalName: string): number;
  /** 回写某文件的当前版本指针（生成/入库新版本时）。 */
}

@Injectable()
export class SqliteFileRepository implements FileRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  insert(input: {
    archiveId: number;
    originalName: string;
    storedName: string;
    extension: string;
    fileSize: number;
    contentType: string;
    sha256: string;
    uploadedBy: number;
  }): FileRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO archive_files
         (archive_id, original_name, stored_name, extension, file_size, content_type, sha256, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.archiveId,
        input.originalName,
        input.storedName,
        input.extension,
        input.fileSize,
        input.contentType,
        input.sha256,
        input.uploadedBy,
        now,
      );
    return this.findById(Number(info.lastInsertRowid))!;
  }

  findById(id: number): FileRow | undefined {
    const row = this.db
      .prepare(
        `SELECT f.*, u.display_name AS uploader_name
         FROM archive_files f LEFT JOIN users u ON u.id = f.uploaded_by
         WHERE f.id = ?`,
      )
      .get(id);
    if (!row) return undefined;
    const r = row as unknown as Record<string, unknown>;
    return {
      id: Number(r.id),
      archiveId: Number(r.archive_id),
      originalName: String(r.original_name),
      storedName: String(r.stored_name),
      extension: String(r.extension),
      fileSize: Number(r.file_size),
      contentType: String(r.content_type ?? ''),
      sha256: String(r.sha256 ?? ''),
      uploadedBy: Number(r.uploaded_by),
      uploadedAt: String(r.uploaded_at),
      uploaderName: r.uploader_name == null ? undefined : String(r.uploader_name),
    };
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM archive_files WHERE id = ?').run(id);
  }

  deleteDetached(id: number): void {
    // 先解除无级联规则的引用方，再删本体；同一调用内顺序固定，避免外键失败。
    this.db.prepare('UPDATE archive_documents SET source_file_id = NULL WHERE source_file_id = ?').run(id);
    this.db.prepare('UPDATE archive_file_versions SET source_file_id = NULL WHERE source_file_id = ?').run(id);
    this.db.prepare('DELETE FROM archive_files WHERE id = ?').run(id);
  }

  countSameName(archiveId: number, originalName: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM archive_files WHERE archive_id = ? AND original_name = ?')
      .get(archiveId, originalName) as unknown as { c: number | bigint };
    return Number(row.c);
  }

}

/** 供视图映射使用：创建人角色标签（JOIN 后处理）。 */
export function creatorRoleLabel(label: string | null | undefined): string {
  return roleLabel(String(label ?? ''));
}
