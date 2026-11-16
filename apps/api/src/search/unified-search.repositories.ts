/**
 * 统一检索仓储（第一批）：跨档案的附件检索。
 *
 * 沿用既有仓储模式：抽象类作为 DI Token，SQLite 实现绑定在 ArchivesModule。
 * 权限口径与目录检索/正文检索完全一致：非管理员一律叠加 ARCHIVE_VISIBILITY_SQL，
 * 无权访问的档案的附件根本不会进入结果集（服务层再用 ArchiveAccessService 复核一次）。
 * 所有 SQL 参数化，禁止拼接用户输入。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { ARCHIVE_VISIBILITY_SQL } from '../archives/archive.repositories';
import { FileSearchRow } from './unified-search.types';

export interface FileSearchParams {
  /** 命中标题或文件名（两者 OR）；空表示不限。 */
  term?: string;
  /** 仅按文件名匹配（命中「附件叫什么」这类明确意图时使用）。 */
  fileName?: string;
  /** 仅按档案标题匹配。 */
  archiveTitle?: string;
  /** 仅按档号匹配。 */
  archiveNo?: string;
  /** 扩展名（小写不带点），精确匹配。 */
  extension?: string;
  /** 限定档案范围（当前用户可见的 ID 集合）；空数组表示无匹配，undefined 表示不限。 */
  archiveIds?: number[];
  fileIds?: number[];
  /** 访问者（非管理员按可见性过滤）。 */
  viewer?: { id: number; role: string };
  limit: number;
  page?: number;
}

export abstract class UnifiedSearchRepository {
  abstract searchFiles(p: FileSearchParams): { items: FileSearchRow[]; total: number };
}

/**
 * 附件的「当前版本」口径与正文索引完全一致：
 * 优先取该文件自身最新的已入库版本，其次取绑定在该文件上的文档版本（在线编辑成果），
 * 都没有时为 null（即附件原件本身仍是有效正文）。
 */
const CURRENT_VERSION_SQL = `
  COALESCE((SELECT vv.version_no FROM archive_file_versions vv
    WHERE vv.archive_id = f.archive_id AND vv.source_file_id = f.id
    ORDER BY vv.version_no DESC, vv.id DESC LIMIT 1),
    (SELECT vv.version_no FROM archive_file_versions vv
    WHERE vv.archive_id = f.archive_id
        AND vv.source_file_id IS NULL AND f.extension = 'docx' AND f.id = (
          SELECT MIN(f2.id) FROM archive_files f2 WHERE f2.archive_id = f.archive_id AND f2.extension = 'docx'
        )
    ORDER BY vv.version_no DESC, vv.id DESC LIMIT 1))`;

const FILE_SEARCH_SELECT = `
  SELECT f.id             AS file_id,
         f.original_name  AS file_name,
         f.extension      AS extension,
         f.file_size      AS file_size,
         f.content_type   AS content_type,
         f.uploaded_by    AS uploaded_by,
         f.uploaded_at    AS uploaded_at,
         u.display_name   AS uploader_name,
         a.id             AS archive_id,
         a.title          AS archive_title,
         a.archive_no     AS archive_no,
         a.category_id    AS category_id,
         a.status         AS archive_status,
         ${CURRENT_VERSION_SQL} AS version_no,
         (SELECT COUNT(1) FROM archive_file_versions vv2 WHERE vv2.archive_id = f.archive_id) AS version_count`;

@Injectable()
export class SqliteUnifiedSearchRepository implements UnifiedSearchRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {
    this.db.function('agent_file_name', { deterministic: true }, value =>
      String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s_]+/gu, ''));
  }

  searchFiles(p: FileSearchParams): { items: FileSearchRow[]; total: number } {
    // An explicitly empty dependency scope must never become a global search.
    if (p.fileIds && !p.fileIds.length) return { items: [], total: 0 };
    if (p.archiveIds && !p.archiveIds.length) return { items: [], total: 0 };
    const where: string[] = [];
    const args: Array<string | number> = [];
    const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

    const term = String(p.term ?? '').trim();
    const fileName = String(p.fileName ?? '').trim();
    const archiveTitle = String(p.archiveTitle ?? '').trim();
    const archiveNo = String(p.archiveNo ?? '').trim();
    if (fileName) {
      // Full filenames are identities, not substring themes. Keep extensionless discovery.
      const normalized = fileName.normalize('NFKC').toLowerCase().replace(/[\s_]+/gu, '');
      if (/\.[a-z0-9]{1,8}$/u.test(normalized)) {
        where.push('agent_file_name(f.original_name) = ?');
        args.push(normalized);
      } else {
        where.push(`agent_file_name(f.original_name) LIKE ? ESCAPE '\\'`);
        args.push(like(normalized));
      }
    }
    if (archiveTitle) {
      where.push(`a.title LIKE ? ESCAPE '\\'`);
      args.push(like(archiveTitle));
    }
    if (archiveNo) {
      where.push(`a.archive_no LIKE ? ESCAPE '\\'`);
      args.push(like(archiveNo));
    }
    if (!fileName && !archiveTitle && !archiveNo && term) {
      where.push(`(f.original_name LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')`);
      args.push(like(term), like(term));
    }
    const extension = String(p.extension ?? '').trim().toLowerCase();
    if (extension) {
      where.push('f.extension = ?');
      args.push(extension);
    }
    if (p.archiveIds && p.archiveIds.length) {
      where.push(`a.id IN (${p.archiveIds.map(() => '?').join(',')})`);
      args.push(...p.archiveIds);
    }
    if (p.fileIds?.length) {
      where.push(`f.id IN (${p.fileIds.map(() => '?').join(',')})`);
      args.push(...p.fileIds);
    }
    if (p.viewer && p.viewer.role !== 'admin') {
      where.push(ARCHIVE_VISIBILITY_SQL);
      args.push(p.viewer.id, p.viewer.id);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const total = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(1) AS c FROM archive_files f
               JOIN archives a ON a.id = f.archive_id${clause}`,
          )
          .get(...args) as unknown as { c: number | bigint }
      ).c,
    );
    const rows = this.db
      .prepare(
        `${FILE_SEARCH_SELECT}
         FROM archive_files f
         JOIN archives a ON a.id = f.archive_id
         LEFT JOIN users u ON u.id = f.uploaded_by${clause}
         ORDER BY datetime(f.uploaded_at) DESC, f.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, p.limit, ((p.page ?? 1) - 1) * p.limit) as unknown as Array<Record<string, unknown>>;
    return { items: rows.map(toFileSearchRow), total };
  }
}

function toFileSearchRow(r: Record<string, unknown>): FileSearchRow {
  return {
    fileId: Number(r.file_id),
    fileName: String(r.file_name ?? ''),
    extension: String(r.extension ?? ''),
    fileSize: Number(r.file_size ?? 0),
    contentType: String(r.content_type ?? ''),
    uploadedBy: Number(r.uploaded_by ?? 0),
    uploadedAt: String(r.uploaded_at ?? ''),
    uploaderName: r.uploader_name == null ? '未知用户' : String(r.uploader_name),
    archiveId: Number(r.archive_id),
    archiveTitle: String(r.archive_title ?? ''),
    archiveNo: String(r.archive_no ?? ''),
    categoryId: Number(r.category_id),
    status: String(r.archive_status ?? 'draft') as 'draft' | 'archived',
    versionNo: r.version_no == null ? null : Number(r.version_no),
    versionCount: Number(r.version_count ?? 0),
  };
}
