/**
 * 元数据模板 / 模板字段 / 分类绑定 / 档案动态著录值仓储（阶段二第四批 · 功能一）。
 * 沿用既有仓储模式：抽象类作为 DI Token，SQLite 实现绑定集中在模块，SQL 一律参数化。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { SqliteTransaction } from '../db/transaction';

export type TemplateStatus = 'active' | 'disabled';
export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'bool' | 'tags';

export const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'bool',
  'tags',
];

export interface TemplateRow {
  id: number;
  name: string;
  description: string;
  status: TemplateStatus;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateFieldRow {
  id: number;
  templateId: number;
  fieldKey: string;
  label: string;
  type: FieldType;
  required: number; // 0/1
  optionsJson: string;
  validationJson: string;
  sortNo: number;
  active: number; // 0/1
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveFieldValueRow {
  id: number;
  archiveId: number;
  fieldId: number;
  fieldKey: string;
  valueText: string;
  updatedAt: string;
}

// ---------- 模板仓储 ----------

export abstract class TemplateRepository {
  abstract listAll(): TemplateRow[];
  abstract findById(id: number): TemplateRow | undefined;
  abstract insert(input: {
    name: string;
    description: string;
    createdBy: number;
  }): TemplateRow;
  abstract update(id: number, patch: { name?: string; description?: string }): TemplateRow | undefined;
  abstract setStatus(id: number, status: TemplateStatus): TemplateRow | undefined;
  /** 物理删除模板（字段随模板级联）；分类绑定与历史著录值的引用保护由服务层提前拦截。 */
  abstract delete(id: number): boolean;
}

const TEMPLATE_COLUMNS = `id, name, description, status, created_by, created_at, updated_at`;

function toTemplateRow(r: Record<string, unknown>): TemplateRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    description: String(r.description ?? ''),
    status: String(r.status) as TemplateStatus,
    createdBy: Number(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class SqliteTemplateRepository implements TemplateRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  listAll(): TemplateRow[] {
    const rows = this.db
      .prepare(`SELECT ${TEMPLATE_COLUMNS} FROM metadata_templates ORDER BY id ASC`)
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map(toTemplateRow);
  }

  findById(id: number): TemplateRow | undefined {
    const row = this.db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM metadata_templates WHERE id = ?`).get(id);
    return row ? toTemplateRow(row as unknown as Record<string, unknown>) : undefined;
  }

  insert(input: { name: string; description: string; createdBy: number }): TemplateRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO metadata_templates (name, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .run(input.name, input.description, input.createdBy, now, now);
    return this.findById(Number(info.lastInsertRowid))!;
  }

  update(id: number, patch: { name?: string; description?: string }): TemplateRow | undefined {
    const current = this.findById(id);
    if (!current) return undefined;
    this.db
      .prepare('UPDATE metadata_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name ?? current.name,
        patch.description ?? current.description,
        new Date().toISOString(),
        id,
      );
    return this.findById(id);
  }

  setStatus(id: number, status: TemplateStatus): TemplateRow | undefined {
    this.db
      .prepare('UPDATE metadata_templates SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    return this.findById(id);
  }

  delete(id: number): boolean {
    // template_fields 对模板为 ON DELETE CASCADE，字段随模板一并清理；
    // archive_category_templates / archive_field_values 无级联，由服务层在删除前拦截。
    const info = this.db.prepare('DELETE FROM metadata_templates WHERE id = ?').run(id);
    return Number(info.changes) > 0;
  }
}

// ---------- 模板字段仓储 ----------

export abstract class TemplateFieldRepository {
  abstract listByTemplate(templateId: number, includeInactive?: boolean): TemplateFieldRow[];
  abstract findById(id: number): TemplateFieldRow | undefined;
  abstract findByKey(templateId: number, fieldKey: string): TemplateFieldRow | undefined;
  abstract insert(input: {
    templateId: number;
    fieldKey: string;
    label: string;
    type: FieldType;
    required: number;
    optionsJson: string;
    validationJson: string;
    sortNo: number;
  }): TemplateFieldRow;
  abstract update(
    id: number,
    patch: {
      label?: string;
      type?: FieldType;
      required?: number;
      optionsJson?: string;
      validationJson?: string;
      sortNo?: number;
    },
  ): TemplateFieldRow | undefined;
  abstract setActive(id: number, active: number): TemplateFieldRow | undefined;
  /** 该字段是否已被历史档案著录值引用（变更保护：被引用不可物理删除 / 不可改类型）。 */
  abstract countValues(fieldId: number): number;
  abstract countByTemplate(templateId: number): number;
}

const FIELD_COLUMNS = `
  id, template_id, field_key, label, type, required, options_json, validation_json,
  sort_no, active, created_at, updated_at`;

function toFieldRow(r: Record<string, unknown>): TemplateFieldRow {
  return {
    id: Number(r.id),
    templateId: Number(r.template_id),
    fieldKey: String(r.field_key),
    label: String(r.label),
    type: String(r.type) as FieldType,
    required: Number(r.required),
    optionsJson: String(r.options_json ?? '[]'),
    validationJson: String(r.validation_json ?? '{}'),
    sortNo: Number(r.sort_no),
    active: Number(r.active),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class SqliteTemplateFieldRepository implements TemplateFieldRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  listByTemplate(templateId: number, includeInactive = false): TemplateFieldRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${FIELD_COLUMNS} FROM template_fields
         WHERE template_id = ? ${includeInactive ? '' : 'AND active = 1'}
         ORDER BY sort_no ASC, id ASC`,
      )
      .all(templateId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toFieldRow);
  }

  findById(id: number): TemplateFieldRow | undefined {
    const row = this.db.prepare(`SELECT ${FIELD_COLUMNS} FROM template_fields WHERE id = ?`).get(id);
    return row ? toFieldRow(row as unknown as Record<string, unknown>) : undefined;
  }

  findByKey(templateId: number, fieldKey: string): TemplateFieldRow | undefined {
    const row = this.db
      .prepare(`SELECT ${FIELD_COLUMNS} FROM template_fields WHERE template_id = ? AND field_key = ?`)
      .get(templateId, fieldKey);
    return row ? toFieldRow(row as unknown as Record<string, unknown>) : undefined;
  }

  insert(input: {
    templateId: number;
    fieldKey: string;
    label: string;
    type: FieldType;
    required: number;
    optionsJson: string;
    validationJson: string;
    sortNo: number;
  }): TemplateFieldRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO template_fields
         (template_id, field_key, label, type, required, options_json, validation_json, sort_no, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.templateId,
        input.fieldKey,
        input.label,
        input.type,
        input.required,
        input.optionsJson,
        input.validationJson,
        input.sortNo,
        now,
        now,
      );
    return this.findById(Number(info.lastInsertRowid))!;
  }

  update(
    id: number,
    patch: {
      label?: string;
      type?: FieldType;
      required?: number;
      optionsJson?: string;
      validationJson?: string;
      sortNo?: number;
    },
  ): TemplateFieldRow | undefined {
    const current = this.findById(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE template_fields
         SET label = ?, type = ?, required = ?, options_json = ?, validation_json = ?, sort_no = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.label ?? current.label,
        patch.type ?? current.type,
        patch.required ?? current.required,
        patch.optionsJson ?? current.optionsJson,
        patch.validationJson ?? current.validationJson,
        patch.sortNo ?? current.sortNo,
        new Date().toISOString(),
        id,
      );
    return this.findById(id);
  }

  setActive(id: number, active: number): TemplateFieldRow | undefined {
    this.db
      .prepare('UPDATE template_fields SET active = ?, updated_at = ? WHERE id = ?')
      .run(active, new Date().toISOString(), id);
    return this.findById(id);
  }

  countValues(fieldId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM archive_field_values WHERE field_id = ?')
      .get(fieldId) as unknown as { c: number | bigint };
    return Number(row.c);
  }

  countByTemplate(templateId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM template_fields WHERE template_id = ?')
      .get(templateId) as unknown as { c: number | bigint };
    return Number(row.c);
  }
}

// ---------- 分类 ↔ 模板绑定仓储 ----------

export abstract class CategoryTemplateRepository {
  abstract getByCategory(categoryId: number): number | undefined;
  abstract setBinding(categoryId: number, templateId: number): void;
  abstract removeBinding(categoryId: number): boolean;
  abstract countByTemplate(templateId: number): number;
  abstract listByTemplate(templateId: number): { id: number; name: string; code: string }[];
}

@Injectable()
export class SqliteCategoryTemplateRepository implements CategoryTemplateRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  getByCategory(categoryId: number): number | undefined {
    const row = this.db
      .prepare('SELECT template_id FROM archive_category_templates WHERE category_id = ?')
      .get(categoryId) as unknown as { template_id: number | bigint } | undefined;
    return row ? Number(row.template_id) : undefined;
  }

  setBinding(categoryId: number, templateId: number): void {
    this.db
      .prepare(
        `INSERT INTO archive_category_templates (category_id, template_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(category_id) DO UPDATE SET template_id = excluded.template_id, updated_at = excluded.updated_at`,
      )
      .run(categoryId, templateId, new Date().toISOString());
  }

  removeBinding(categoryId: number): boolean {
    const info = this.db
      .prepare('DELETE FROM archive_category_templates WHERE category_id = ?')
      .run(categoryId);
    return Number(info.changes) > 0;
  }

  countByTemplate(templateId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM archive_category_templates WHERE template_id = ?')
      .get(templateId) as unknown as { c: number | bigint };
    return Number(row.c);
  }

  listByTemplate(templateId: number): { id: number; name: string; code: string }[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.name AS name, c.code AS code
         FROM archive_category_templates t
         JOIN archive_categories c ON c.id = t.category_id
         WHERE t.template_id = ?
         ORDER BY c.id ASC`,
      )
      .all(templateId) as unknown as { id: number | bigint; name: string; code: string }[];
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name), code: String(r.code) }));
  }
}

// ---------- 档案动态著录值仓储 ----------

export abstract class ArchiveFieldValueRepository {
  abstract listByArchive(archiveId: number): ArchiveFieldValueRow[];
  /** 事务内整体替换某档案的动态值（先删后写，保证与模板一致且原子）。 */
  abstract replaceAll(archiveId: number, values: Array<{ fieldId: number; fieldKey: string; value: string }>): void;
  abstract countByArchive(archiveId: number): number;
  /** 该模板下全部字段被历史档案著录值引用的记录数（模板删除前的引用保护）。 */
  abstract countByTemplate(templateId: number): number;
}

function toValueRow(r: Record<string, unknown>): ArchiveFieldValueRow {
  return {
    id: Number(r.id),
    archiveId: Number(r.archive_id),
    fieldId: Number(r.field_id),
    fieldKey: String(r.field_key),
    valueText: String(r.value_text ?? ''),
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class SqliteArchiveFieldValueRepository implements ArchiveFieldValueRepository {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
  ) {}

  listByArchive(archiveId: number): ArchiveFieldValueRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, archive_id, field_id, field_key, value_text, updated_at
         FROM archive_field_values WHERE archive_id = ? ORDER BY id ASC`,
      )
      .all(archiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toValueRow);
  }

  replaceAll(
    archiveId: number,
    values: Array<{ fieldId: number; fieldKey: string; value: string }>,
  ): void {
    this.tx.run(() => {
      this.db.prepare('DELETE FROM archive_field_values WHERE archive_id = ?').run(archiveId);
      const now = new Date().toISOString();
      const stmt = this.db.prepare(
        `INSERT INTO archive_field_values (archive_id, field_id, field_key, value_text, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const v of values) {
        stmt.run(archiveId, v.fieldId, v.fieldKey, v.value, now);
      }
    });
  }

  countByArchive(archiveId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM archive_field_values WHERE archive_id = ?')
      .get(archiveId) as unknown as { c: number | bigint };
    return Number(row.c);
  }

  countByTemplate(templateId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM archive_field_values v
         JOIN template_fields f ON f.id = v.field_id
         WHERE f.template_id = ?`,
      )
      .get(templateId) as unknown as { c: number | bigint };
    return Number(row.c);
  }
}
