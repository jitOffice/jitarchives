/**
 * 元数据模板管理服务（阶段二第四批 · 功能一）。
 * 职责：模板增删改查、字段配置、启停、分类绑定，以及模板变更保护（被历史档案引用的字段不可物理删除/改类型）。
 * 权限：控制器守卫按 templateManage（管理员）执行；本层负责字段定义与引用一致性复核（不信任前端）。
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SqliteTransaction } from '../db/transaction';
import {
  ArchiveFieldValueRepository,
  CategoryTemplateRepository,
  FIELD_TYPES,
  FieldType,
  TemplateFieldRepository,
  TemplateFieldRow,
  TemplateRepository,
  TemplateRow,
} from './template.repositories';
import { normalizeFieldDefinition } from './field.validation';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTION,
  AUDIT_OBJECT,
  AuditAction,
  AuditObjectType,
  AuditEvent,
} from '../audit/audit.types';
import { Role, UserView } from '../common/roles';

export interface FieldView {
  id: number;
  fieldKey: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  validation: Record<string, unknown>;
  sortNo: number;
  active: boolean;
  referenced: boolean;
}

export interface TemplateView {
  id: number;
  name: string;
  description: string;
  status: 'active' | 'disabled';
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 模板详情内联展示的分类绑定项（分类基本信息，供模板配置页直接管理绑定）。 */
export interface BoundCategoryView {
  id: number;
  name: string;
  code: string;
}

export interface TemplateDetailView extends TemplateView {
  fields: FieldView[];
  boundCategories: BoundCategoryView[];
}

const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function mapUnique(err: unknown, msg: string): never {
  const text = String((err as Error)?.message ?? err);
  if (/UNIQUE constraint failed/i.test(text)) throw new ConflictException(msg);
  if (/FOREIGN KEY constraint failed/i.test(text)) throw new BadRequestException('关联数据不存在或已失效，请刷新后重试');
  throw err;
}

@Injectable()
export class MetadataTemplatesService {
  constructor(
    @Inject(TemplateRepository) private readonly templates: TemplateRepository,
    @Inject(TemplateFieldRepository) private readonly fields: TemplateFieldRepository,
    @Inject(CategoryTemplateRepository) private readonly bindings: CategoryTemplateRepository,
    @Inject(ArchiveFieldValueRepository) private readonly values: ArchiveFieldValueRepository,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ==================== 模板 ====================

  listTemplates(): TemplateView[] {
    return this.templates.listAll().map((t) => this.toTemplateView(t));
  }

  getTemplate(id: number): TemplateDetailView {
    const t = this.requireTemplate(id);
    return {
      ...this.toTemplateView(t),
      fields: this.fields.listByTemplate(id, true).map((f) => this.toFieldView(f)),
      boundCategories: this.bindings.listByTemplate(id),
    };
  }

  createTemplate(
    input: {
      name?: string;
      description?: string;
      fields?: Array<{
        fieldKey?: string;
        label?: string;
        type?: string;
        required?: boolean;
        options?: unknown;
        validation?: unknown;
        sortNo?: number;
      }>;
    },
    operator: UserView,
  ): TemplateDetailView {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 50) throw new BadRequestException('模板名称需为 1-50 个字符');
    const description = String(input.description ?? '').trim();
    if (description.length > 200) throw new BadRequestException('模板描述不能超过 200 个字符');

    // 预校验字段定义（引用完整性/类型合法性），失败即整体拒绝，不落半成品模板。
    const prepared = (input.fields ?? []).map((f, i) => this.validateFieldInput(f, i));

    try {
      const template = this.tx.run(() => {
        const t = this.templates.insert({ name, description, createdBy: operator.id });
        for (const p of prepared) {
          this.fields.insert({
            templateId: t.id,
            fieldKey: p.fieldKey,
            label: p.label,
            type: p.type,
            required: p.required,
            optionsJson: p.optionsJson,
            validationJson: p.validationJson,
            sortNo: p.sortNo,
          });
        }
        this.audit.logTx(
          this.event(operator, AUDIT_ACTION.TEMPLATE_CREATE, AUDIT_OBJECT.TEMPLATE, t.id, {
            name,
            fieldCount: prepared.length,
          }),
        );
        return t;
      });
      return this.getTemplate(template.id);
    } catch (err) {
      mapUnique(err, '已存在同名模板');
    }
    throw new ConflictException('模板创建失败，请重试');
  }

  updateTemplateMeta(
    id: number,
    input: { name?: string; description?: string },
    operator: UserView,
  ): TemplateView {
    this.requireTemplate(id);
    const patch: { name?: string; description?: string } = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 50) throw new BadRequestException('模板名称需为 1-50 个字符');
      patch.name = name;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 200) throw new BadRequestException('模板描述不能超过 200 个字符');
      patch.description = description;
    }
    try {
      const updated = this.templates.update(id, patch);
      if (!updated) throw new NotFoundException('模板不存在');
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.TEMPLATE_UPDATE,
        AUDIT_OBJECT.TEMPLATE,
        id,
        { name: updated.name },
      );
      return this.toTemplateView(updated);
    } catch (err) {
      mapUnique(err, '已存在同名模板');
    }
    throw new ConflictException('模板更新失败');
  }

  setTemplateStatus(
    id: number,
    status: 'active' | 'disabled',
    operator: UserView,
  ): TemplateView {
    const t = this.requireTemplate(id);
    if (status !== 'active' && status !== 'disabled') throw new BadRequestException('状态不合法');
    // 停用前确保不影响已绑定分类的历史著录（值已入库，停用仅关闭后续入口）。
    const updated = this.templates.setStatus(t.id, status);
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.TEMPLATE_STATUS_CHANGE,
      AUDIT_OBJECT.TEMPLATE,
      t.id,
      { name: t.name, from: t.status, to: status },
    );
    return this.toTemplateView(updated!);
  }

  /**
   * 删除模板（引用保护）。
   * 模板与其信息项可物理删除，但一旦被分类绑定或已有历史著录值，就必须保留（改为停用），
   * 否则历史档案会失去字段定义与已填内容。
   */
  deleteTemplate(id: number, operator: UserView): { ok: true } {
    const t = this.requireTemplate(id);
    const boundCount = this.bindings.countByTemplate(id);
    if (boundCount > 0) {
      throw new BadRequestException(
        `该模板仍被 ${boundCount} 个分类绑定，请先解除绑定再删除（也可改为停用）`,
      );
    }
    // 不带任何可见性过滤：删除保护必须基于全量历史著录值，不能因受限档案而漏算。
    const valueCount = this.values.countByTemplate(id);
    if (valueCount > 0) {
      throw new BadRequestException(
        `该模板下已有 ${valueCount} 条历史著录值，删除会丢失这些档案的填写内容，请改为停用`,
      );
    }
    const fieldCount = this.fields.countByTemplate(id);
    return this.tx.run(() => {
      try {
        if (!this.templates.delete(id)) throw new NotFoundException('模板不存在');
      } catch (err) {
        if (err instanceof NotFoundException) throw err;
        const text = String((err as Error)?.message ?? err);
        if (/FOREIGN KEY constraint failed/i.test(text)) {
          throw new BadRequestException('该模板仍被其他数据引用，不可删除');
        }
        throw err;
      }
      this.audit.logTx(
        this.event(operator, AUDIT_ACTION.TEMPLATE_DELETE, AUDIT_OBJECT.TEMPLATE, id, {
          name: t.name,
          status: t.status,
          fieldCount,
        }),
      );
      return { ok: true as const };
    });
  }

  // ==================== 字段 ====================

  addField(
    templateId: number,
    input: {
      fieldKey?: string;
      label?: string;
      type?: string;
      required?: boolean;
      options?: unknown;
      validation?: unknown;
      sortNo?: number;
    },
    operator: UserView,
  ): FieldView {
    this.requireTemplate(templateId);
    const p = this.validateFieldInput(input, this.fields.countByTemplate(templateId));
    try {
      const row = this.fields.insert({
        templateId,
        fieldKey: p.fieldKey,
        label: p.label,
        type: p.type,
        required: p.required,
        optionsJson: p.optionsJson,
        validationJson: p.validationJson,
        sortNo: p.sortNo,
      });
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.TEMPLATE_FIELD_CHANGE,
        AUDIT_OBJECT.FIELD,
        row.id,
        { templateId, fieldKey: p.fieldKey, change: 'add' },
      );
      return this.toFieldView(row);
    } catch (err) {
      mapUnique(err, '该模板下已存在同名标识（field_key）的字段');
    }
    throw new ConflictException('字段新增失败');
  }

  updateField(
    templateId: number,
    fieldId: number,
    input: {
      label?: string;
      type?: string;
      required?: boolean;
      options?: unknown;
      validation?: unknown;
      sortNo?: number;
      active?: boolean;
    },
    operator: UserView,
  ): FieldView {
    const field = this.requireField(templateId, fieldId);
    const referenced = this.fields.countValues(fieldId) > 0;

    // 变更保护：字段已被历史档案引用时，禁止修改类型（会导致历史值语义错乱）。
    if (input.type !== undefined && referenced && input.type !== field.type) {
      throw new BadRequestException('该字段已被档案引用，不能修改类型；如需调整请停用旧字段并新建');
    }
    const nextType = (input.type ?? field.type) as FieldType;
    const merged = this.validateFieldInput(
      {
        fieldKey: field.fieldKey,
        label: input.label ?? field.label,
        type: nextType,
        required: input.required ?? field.required === 1,
        options: input.options ?? JSON.parse(field.optionsJson || '[]'),
        validation: input.validation ?? JSON.parse(field.validationJson || '{}'),
        sortNo: input.sortNo ?? field.sortNo,
      },
      field.sortNo,
      true,
    );

    this.fields.update(fieldId, {
      label: merged.label,
      type: merged.type,
      required: merged.required,
      optionsJson: merged.optionsJson,
      validationJson: merged.validationJson,
      sortNo: merged.sortNo,
    });
    if (input.active !== undefined) this.fields.setActive(fieldId, input.active ? 1 : 0);
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.TEMPLATE_FIELD_CHANGE,
      AUDIT_OBJECT.FIELD,
      fieldId,
      { templateId, fieldKey: field.fieldKey, change: 'update', active: input.active },
    );
    return this.toFieldView(this.fields.findById(fieldId)!);
  }

  /** 删除字段：被引用者仅软停用（保留历史值），未被引用者停用（本批统一软删，避免历史丢失）。 */
  deactivateField(templateId: number, fieldId: number, operator: UserView): FieldView {
    const field = this.requireField(templateId, fieldId);
    const updated = this.fields.setActive(field.id, 0);
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.TEMPLATE_FIELD_CHANGE,
      AUDIT_OBJECT.FIELD,
      field.id,
      { templateId, fieldKey: field.fieldKey, change: 'deactivate' },
    );
    return this.toFieldView(updated ?? field);
  }

  // ==================== 分类绑定 ====================

  bindCategory(
    categoryId: number,
    templateId: number | null,
    operator: UserView,
  ): { categoryId: number; templateId: number | null } {
    if (templateId === null) {
      this.bindings.removeBinding(categoryId);
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.TEMPLATE_BIND,
        AUDIT_OBJECT.CATEGORY,
        categoryId,
        { templateId: null },
      );
      return { categoryId, templateId: null };
    }
    const t = this.requireTemplate(templateId);
    if (t.status !== 'active') throw new BadRequestException('不能绑定已停用的模板');
    this.bindings.setBinding(categoryId, templateId);
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.TEMPLATE_BIND,
      AUDIT_OBJECT.CATEGORY,
      categoryId,
      { templateId, templateName: t.name },
    );
    return { categoryId, templateId };
  }

  getTemplateByCategory(categoryId: number): { template: TemplateView | null; fields: FieldView[] } {
    const templateId = this.bindings.getByCategory(categoryId);
    if (!templateId) return { template: null, fields: [] };
    const t = this.templates.findById(templateId);
    if (!t) return { template: null, fields: [] };
    return {
      template: this.toTemplateView(t),
      fields: this.fields.listByTemplate(templateId, false).map((f) => this.toFieldView(f)),
    };
  }

  // ==================== 供档案服务复用 ====================

  /** 取某分类绑定模板下的启用字段行（原始行，供校验与写值）。 */
  activeFieldRowsByCategory(categoryId: number): TemplateFieldRow[] {
    const templateId = this.bindings.getByCategory(categoryId);
    if (!templateId) return [];
    const t = this.templates.findById(templateId);
    if (!t) return [];
    return this.fields.listByTemplate(templateId, false);
  }

  findFieldById(id: number): TemplateFieldRow | undefined {
    return this.fields.findById(id);
  }

  // ==================== 内部 ====================

  private requireTemplate(id: number): TemplateRow {
    const t = this.templates.findById(id);
    if (!t) throw new NotFoundException('模板不存在');
    return t;
  }

  private requireField(templateId: number, fieldId: number): TemplateFieldRow {
    const f = this.fields.findById(fieldId);
    if (!f || f.templateId !== templateId) throw new NotFoundException('字段不存在');
    return f;
  }

  /** 构造审计事件（操作人一律来自已校验会话）。 */
  private event(
    actor: { id: number; role: Role },
    action: AuditAction,
    objectType: AuditObjectType,
    objectId: number | string | null,
    detail: Record<string, unknown>,
  ): AuditEvent {
    return {
      actorUserId: actor.id,
      actorRole: actor.role,
      action,
      objectType,
      objectId,
      result: 'success',
      detail,
      ip: null,
    };
  }

  private validateFieldInput(
    input: {
      fieldKey?: string;
      label?: string;
      type?: string;
      required?: boolean;
      options?: unknown;
      validation?: unknown;
      sortNo?: number;
    },
    defaultSort: number,
    allowExistingKey = false,
  ): {
    fieldKey: string;
    label: string;
    type: FieldType;
    required: number;
    optionsJson: string;
    validationJson: string;
    sortNo: number;
  } {
    const fieldKey = String(input.fieldKey ?? '').trim();
    if (!FIELD_KEY_RE.test(fieldKey)) {
      throw new BadRequestException('字段标识需为字母开头、由字母/数字/下划线组成、长度 1-40');
    }
    void allowExistingKey;
    const label = String(input.label ?? '').trim();
    if (!label || label.length > 50) throw new BadRequestException('字段名称需为 1-50 个字符');
    const type = String(input.type ?? '') as FieldType;
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException('字段类型不合法');
    }
    const { optionsJson, validationJson } = normalizeFieldDefinition({
      type,
      options: input.options,
      validation: input.validation,
    });
    const sortNo = Number.isInteger(input.sortNo) ? (input.sortNo as number) : defaultSort;
    return {
      fieldKey,
      label,
      type,
      required: input.required ? 1 : 0,
      optionsJson,
      validationJson,
      sortNo,
    };
  }

  private toTemplateView(t: TemplateRow): TemplateView {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      status: t.status,
      fieldCount: this.fields.countByTemplate(t.id),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private toFieldView(f: TemplateFieldRow): FieldView {
    let options: string[] = [];
    let validation: Record<string, unknown> = {};
    try {
      options = JSON.parse(f.optionsJson || '[]');
    } catch {
      options = [];
    }
    try {
      validation = JSON.parse(f.validationJson || '{}');
    } catch {
      validation = {};
    }
    return {
      id: f.id,
      fieldKey: f.fieldKey,
      label: f.label,
      type: f.type,
      required: f.required === 1,
      options,
      validation,
      sortNo: f.sortNo,
      active: f.active === 1,
      referenced: this.fields.countValues(f.id) > 0,
    };
  }
}
