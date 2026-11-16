/**
 * 档案核心业务服务（阶段二第二批）。
 * 职责：字段校验、分类层级与循环引用校验、档号自动生成、状态约束、附件元数据一致性。
 * 权限边界：角色矩阵在控制器守卫上落实，本层对状态与归属做二次复核（不信任前端）。
 * 档号规则（补充工程设计，PRD 5.2 仅要求「自动生成档号」未定义具体格式）：
 *   分类编码链-年度-全局流水号，如 WS-2026-000007；分类变更时自动重生成，保证唯一。
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  ArchiveRow,
  ArchiveSearchParams,
  ArchiveStatus,
  CategoryRow,
  CategoryRepository,
  ArchiveRepository,
  FileRow,
  FileRepository,
} from './archive.repositories';
import { ALLOWED_EXTENSIONS, FileStorage, FileStoreError } from './file.storage';
import { ArchiveContentStatus, ContentIndexService } from './content/content-index.service';
import { PreviewFileType, detectPreviewFileType } from './preview.file';
import { ArchiveAccessService } from './archive-access.service';
import { Role, UserView, roleLabel } from '../common/roles';
import { DocumentRepository, VersionRepository } from '../jitword/jitword.repositories';
import { MetadataTemplatesService } from '../templates/metadata-templates.service';
import { ArchiveFieldValueRepository, FieldType } from '../templates/template.repositories';

import { normalizeArchiveValue } from '../templates/field.validation';
import { SqliteTransaction } from '../db/transaction';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTION,
  AUDIT_OBJECT,
  AuditAction,
  AuditObjectType,
  AuditEvent,
} from '../audit/audit.types';
import { GraphMaintenanceHooks } from '../graph/graph.hooks';

// ---------- 对外视图 ----------

export interface CategoryView {
  id: number;
  name: string;
  code: string;
  description: string;
  parentId: number | null;
  parentName: string | null;
  pathCode: string;
  depth: number;
  archiveCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveFileView {
  id: number;
  originalName: string;
  extension: string;
  fileSize: number;
  contentType: string;
  uploadedByName: string;
  uploadedAt: string;
}

export interface ArchiveView {
  id: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  categoryPath: string;
  archiveType: string;
  keywords: string;
  formationDate: string | null;
  responsible: string;
  remarks: string;
  status: ArchiveStatus;
  statusLabel: string;
  accessLevel: 'public' | 'restricted';
  createdByName: string;
  createdByRoleLabel: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 当前登录用户对该档案的附件操作授权（服务端真实判定结果，前端仅用于显隐按钮）。
 * 在线预览与下载共用同源授权（预览向浏览器传输完整字节，门槛不得弱于下载），
 * 因此不再单独暴露 canPreview：受限档案借阅授权、归还/到期失效均在此一处体现。
 */
export interface ArchivePermissionsView {
  canDownload: boolean;
}

/** 档案动态著录值视图（阶段二第四批）：按模板字段定义回显。 */
export interface ArchiveFieldValueView {
  fieldKey: string;
  label: string;
  type: FieldType;
  value: string;
}

export interface ArchiveListView {
  items: ArchiveView[];
  total: number;
  page: number;
  pageSize: number;
}

export const ARCHIVE_TYPES = [
  '文书档案',
  '科技档案',
  '会计档案',
  '人事档案',
  '业务档案',
  '其他',
] as const;

export const STATUS_LABELS: Record<ArchiveStatus, string> = {
  draft: '草稿（可著录）',
  archived: '已归档（只读）',
};

const MAX_CATEGORY_DEPTH = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 包装仓储唯一约束冲突为可读业务错误。 */
function mapUniqueError(err: unknown, conflictMessage: string): never {
  const text = String((err as Error)?.message ?? err);
  if (/UNIQUE constraint failed/i.test(text)) {
    throw new ConflictException(conflictMessage);
  }
  if (/FOREIGN KEY constraint failed/i.test(text)) {
    throw new BadRequestException('关联数据不存在或已失效，请刷新后重试');
  }
  throw err;
}

@Injectable()
export class ArchivesService {
  constructor(
    @Inject(CategoryRepository) private readonly categories: CategoryRepository,
    @Inject(ArchiveRepository) private readonly archives: ArchiveRepository,
    @Inject(FileRepository) private readonly files: FileRepository,
    @Inject(FileStorage) private readonly storage: FileStorage,
    @Inject(DocumentRepository) private readonly documents: DocumentRepository,
    @Inject(VersionRepository) private readonly versions: VersionRepository,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(MetadataTemplatesService) private readonly templates: MetadataTemplatesService,
    @Inject(ArchiveFieldValueRepository) private readonly fieldValues: ArchiveFieldValueRepository,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ContentIndexService) private readonly content: ContentIndexService,
    @Inject(GraphMaintenanceHooks) private readonly graph: GraphMaintenanceHooks,
  ) {}

  // ==================== 分类 ====================

  listCategories(viewer?: { id: number; role: Role }): CategoryView[] {
    const rows = this.categories.listAll();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const counts = this.categories.archiveCountByCategory(viewer);
    return rows.map((r) => {
      const segments: string[] = [];
      let depth = 0;
      let cursor: CategoryRow | undefined = r;
      const seen = new Set<number>();
      while (cursor && !seen.has(cursor.id) && depth < 10) {
        seen.add(cursor.id);
        segments.unshift(cursor.code);
        depth += 1;
        cursor = cursor.parentId == null ? undefined : byId.get(cursor.parentId);
      }
      const parent = r.parentId == null ? undefined : byId.get(r.parentId);
      return {
        id: r.id,
        name: r.name,
        code: r.code,
        description: r.description,
        parentId: r.parentId,
        parentName: parent?.name ?? null,
        pathCode: segments.join('-'),
        depth: depth - 1,
        archiveCount: counts.get(r.id) ?? 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  createCategory(
    input: { name: string; code: string; description?: string; parentId?: number | null },
    operator: UserView,
  ): CategoryView {
    const { name, code, description } = this.validateCategoryFields(input);
    const parentId = this.validateCategoryParent(input.parentId ?? null, null);
    return this.tx.run(() => {
      try {
        this.categories.insert({ name, code, description, parentId, createdBy: operator.id });
      } catch (err) {
        mapUniqueError(err, '同级分类下已存在相同名称或编码');
      }
      const created = this.requireCategoryByNameCode(name, code, parentId);
      this.audit.logTx(
        this.event(operator, AUDIT_ACTION.CATEGORY_CREATE, AUDIT_OBJECT.CATEGORY, created.id, {
          name,
          code,
        }),
      );
      return created;
    });
  }

  updateCategory(
    id: number,
    input: { name?: string; code?: string; description?: string; parentId?: number | null },
    operator: UserView,
  ): CategoryView {
    const current = this.categories.findById(id);
    if (!current) throw new NotFoundException('分类不存在');
    const merged = {
      name: input.name !== undefined ? input.name : current.name,
      code: input.code !== undefined ? input.code : current.code,
      description: input.description !== undefined ? input.description : current.description,
    };
    const { name, code, description } = this.validateCategoryFields(merged);
    const parentId =
      input.parentId !== undefined
        ? this.validateCategoryParent(input.parentId, id)
        : current.parentId;
    return this.tx.run(() => {
      try {
        this.categories.update(id, { name, code, description, parentId });
      } catch (err) {
        mapUniqueError(err, '同级分类下已存在相同名称或编码');
      }
      const updated = this.requireCategoryById(id);
      this.audit.logTx(
        this.event(operator, AUDIT_ACTION.CATEGORY_UPDATE, AUDIT_OBJECT.CATEGORY, id, {
          name,
          code,
        }),
      );
      return updated;
    });
  }

  /**
   * 删除分类（补充实现）：仅允许删除「无子分类且无档案引用」的分类。
   * - 有子分类 → 拒绝，要求先删除或移动子级，避免整棵子树被误删；
   * - 有档案引用 → 拒绝（archives.category_id 外键同样强制），历史档案需保留类目归属；
   * - 删除成功在同一事务内写审计，detail 保留删除前的名称/编码/路径供事后追溯。
   */
  deleteCategory(id: number, operator: UserView): { ok: true } {
    const current = this.categories.findById(id);
    if (!current) throw new NotFoundException('分类不存在');
    const childCount = this.categories.listAll().filter((c) => c.parentId === id).length;
    if (childCount > 0) {
      throw new BadRequestException(`该分类下仍有 ${childCount} 个子分类，请先删除或移走子分类`);
    }
    // 不带 viewer 的统计：删除保护必须基于全量引用，不能因可见性过滤而漏算受限档案。
    const archiveCount = this.categories.archiveCountByCategory().get(id) ?? 0;
    if (archiveCount > 0) {
      throw new BadRequestException(
        `该分类仍被 ${archiveCount} 个档案引用，不可删除（历史档案需保留类目归属）`,
      );
    }
    const snapshot = this.listCategories().find((c) => c.id === id);
    return this.tx.run(() => {
      try {
        this.categories.deleteById(id);
      } catch (err) {
        const text = String((err as Error)?.message ?? err);
        if (/FOREIGN KEY constraint failed/i.test(text)) {
          throw new BadRequestException('该分类仍被其他数据引用，不可删除');
        }
        throw err;
      }
      this.audit.logTx(
        this.event(operator, AUDIT_ACTION.CATEGORY_DELETE, AUDIT_OBJECT.CATEGORY, id, {
          name: current.name,
          code: current.code,
          pathCode: snapshot?.pathCode ?? current.code,
        }),
      );
      return { ok: true as const };
    });
  }

  private validateCategoryFields(input: {
    name?: string;
    code?: string;
    description?: string;
  }): { name: string; code: string; description: string } {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 50) throw new BadRequestException('分类名称需为 1-50 个字符');
    const code = String(input.code ?? '').trim();
    if (!code) throw new BadRequestException('分类编码不能为空');
    if (!/^[0-9A-Za-z\u4e00-\u9fa5]{1,20}$/.test(code)) {
      throw new BadRequestException('分类编码需为 1-20 位字母、数字或汉字');
    }
    const description = String(input.description ?? '').trim();
    if (description.length > 200) throw new BadRequestException('分类说明不能超过 200 个字符');
    return { name, code, description };
  }

  /** 父级合法性：存在、非自身、不构成循环引用、不超深度上限。 */
  private validateCategoryParent(parentId: number | null, selfId: number | null): number | null {
    if (parentId === null || parentId === undefined) return null;
    const rows = this.categories.listAll();
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (selfId !== null && parentId === selfId) {
      throw new BadRequestException('分类不能将自己设置为父级');
    }
    // 沿父链上溯：遇到自身即循环引用；同时得到新父级深度（顶层=1）
    let depth = 0;
    let cursor: CategoryRow | undefined = byId.get(parentId);
    if (!cursor) throw new BadRequestException('父级分类不存在');
    const seen = new Set<number>();
    while (cursor && !seen.has(cursor.id)) {
      if (selfId !== null && cursor.id === selfId) {
        throw new BadRequestException('不能将分类挂到自身的下级，分类层级不能形成循环');
      }
      seen.add(cursor.id);
      depth += 1;
      cursor = cursor.parentId == null ? undefined : byId.get(cursor.parentId);
    }
    const childDepth = selfId === null ? 0 : this.maxSubtreeDepth(selfId, byId);
    // 新父级深度（顶层=1）+ 自身子树最大层数 不得超过上限
    if (depth + childDepth + 1 > MAX_CATEGORY_DEPTH) {
      throw new BadRequestException(`分类层级最多支持 ${MAX_CATEGORY_DEPTH} 级`);
    }
    return parentId;
  }

  private maxSubtreeDepth(id: number, byId: Map<number, CategoryRow>): number {
    let max = 0;
    for (const r of byId.values()) {
      if (r.parentId === id) max = Math.max(max, 1 + this.maxSubtreeDepth(r.id, byId));
    }
    return max;
  }

  private requireCategoryById(id: number): CategoryView {
    const view = this.listCategories().find((c) => c.id === id);
    if (!view) throw new NotFoundException('分类不存在');
    return view;
  }

  private requireCategoryByNameCode(
    name: string,
    code: string,
    parentId: number | null,
  ): CategoryView {
    const found = this.listCategories().find(
      (c) => c.name === name && c.code === code && c.parentId === parentId,
    );
    if (!found) throw new InternalServerErrorException('分类创建失败，请重试');
    return found;
  }

  // ==================== 档案 ====================

  searchArchives(raw: {
    dateField?: 'formationDate' | 'createdAt' | 'updatedAt';
    dateFrom?: string;
    dateTo?: string;
    metadataConditions?: Array<{ field: string; value: string }>;
    metadataOnly?: boolean;
    archiveNoExact?: boolean;
    q?: string;
    /** 仅按标题匹配（Agent 助理「按标题检索」）。 */
    title?: string;
    /** 仅按档号匹配（Agent 助理「按档号检索」）。 */
    archiveNo?: string;
    categoryId?: string;
    includeSub?: string;
    status?: string;
    matchDynamic?: string;
    knowledgeMetadata?: boolean;
    archiveIds?: number[];
    page?: string;
    pageSize?: string;
  }, viewer: { id: number; role: Role }): ArchiveListView {
    const keyword = String(raw.q ?? '').trim();
    if (keyword.length > 100) throw new BadRequestException('检索关键词不能超过 100 个字符');
    const title = String(raw.title ?? '').trim();
    if (title.length > 100) throw new BadRequestException('标题检索条件不能超过 100 个字符');
    const archiveNo = String(raw.archiveNo ?? '').trim();
    if (archiveNo.length > 100) throw new BadRequestException('档号检索条件不能超过 100 个字符');
    const page = this.positiveInt(raw.page, 1, '页码');
    const pageSize = Math.min(this.positiveInt(raw.pageSize, 20, '每页数量'), 100);
    let status: ArchiveStatus | '' = '';
    if (raw.status !== undefined && raw.status !== '') {
      if (raw.status !== 'draft' && raw.status !== 'archived') {
        throw new BadRequestException('档案状态筛选不合法');
      }
      status = raw.status;
    }
    let categoryIds: number[] | null = null;
    if (raw.categoryId !== undefined && raw.categoryId !== '') {
      const cid = Number(raw.categoryId);
      if (!Number.isInteger(cid) || cid <= 0) throw new BadRequestException('分类筛选参数不合法');
      if (!this.categories.findById(cid)) throw new BadRequestException('分类不存在');
      const includeSub = raw.includeSub !== '0' && raw.includeSub !== 'false';
      categoryIds = includeSub ? this.categorySubtreeIds(cid) : [cid];
    }
    const params: ArchiveSearchParams = {
      dateField: raw.dateField, dateFrom: raw.dateFrom, dateTo: raw.dateTo,
      metadataConditions: raw.metadataConditions, metadataOnly: raw.metadataOnly, archiveNoExact: raw.archiveNoExact,
      keyword,
      title,
      archiveNo,
      categoryId: null,
      includeSub: true,
      status,
      categoryIds,
      // Agent 检索默认同时匹配动态元数据著录值；显式传 0/false 可关闭。
      matchDynamic: raw.matchDynamic !== '0' && raw.matchDynamic !== 'false',
      archiveIds: raw.archiveIds,
      ...(raw.knowledgeMetadata ? { knowledgeMetadata: true } : {}),
      page,
      pageSize,
      viewer,
    };
    const result = this.archives.search(params);
    return {
      items: result.items.map((row) => this.toArchiveView(row)),
      total: result.total,
      page,
      pageSize,
    };
  }

  getArchiveDetail(
    id: number,
    viewer: UserView,
  ): ArchiveView & {
    files: ArchiveFileView[];
    dynamicFields: ArchiveFieldValueView[];
    permissions: ArchivePermissionsView;
  } {
    const row = this.requireArchive(id);
    this.access.assertView(viewer, row);
    return {
      ...this.toArchiveView(row),
      files: this.archives.listFiles(id).map((f) => this.toFileView(f)),
      dynamicFields: this.getDynamicFields(id),
      // 附件授权由访问控制服务给出（角色矩阵 + 受限档案借阅授权），
      // 前端据此决定是否展示预览/下载入口，不按前端角色单独推断。
      permissions: { canDownload: this.access.canDownload(viewer, row) },
    };
  }

  createArchive(
    input: {
      title?: string;
      categoryId?: number;
      archiveType?: string;
      keywords?: string;
      formationDate?: string | null;
      responsible?: string;
      remarks?: string;
      accessLevel?: string;
      fieldValues?: Record<string, unknown>;
    },
    operator: { id: number; role: Role },
  ): ArchiveView {
    const fields = this.validateArchiveFields(input, false);
    const category = this.requireCategory(fields.categoryId);
    const accessLevel = this.validateAccessLevel(input.accessLevel);
    // 动态字段先校验后写入：任一项不合法即整体拒绝，不产生半成品档案。
    const dynamic = this.validateDynamicValues(fields.categoryId, input.fieldValues);
    const year = (fields.formationDate ?? '').slice(0, 4) || String(new Date().getFullYear());
    try {
      const row = this.tx.run(() => {
        const created = this.archives.createWithSeqNo(
          {
            title: fields.title,
            archiveNo: '', // 事务内由全局自增 id 生成，天然唯一
            categoryId: category.id,
            archiveType: fields.archiveType,
            keywords: fields.keywords,
            formationDate: fields.formationDate,
            responsible: fields.responsible,
            remarks: fields.remarks,
            status: 'draft',
            accessLevel,
            createdBy: operator.id,
          },
          (seq) => this.buildArchiveNo(category, year, seq),
        );
        if (dynamic.length > 0) this.fieldValues.replaceAll(created.id, dynamic);
        this.audit.logTx(
          this.event(operator, AUDIT_ACTION.ARCHIVE_CREATE, AUDIT_OBJECT.ARCHIVE, created.id, {
            archiveNo: created.archiveNo,
            title: fields.title,
            categoryId: category.id,
            accessLevel,
          }),
        );
        return created;
      });
      return this.toArchiveView(this.requireArchive(row.id));
    } catch (err) {
      if (err instanceof ConflictException || err instanceof BadRequestException) throw err;
      mapUniqueError(err, '档号冲突，请重试');
    }
    throw new InternalServerErrorException('档案创建失败，请重试');
  }

  updateArchive(
    id: number,
    input: {
      title?: string;
      categoryId?: number;
      archiveType?: string;
      keywords?: string;
      formationDate?: string | null;
      responsible?: string;
      remarks?: string;
      accessLevel?: string;
      fieldValues?: Record<string, unknown>;
    },
    operator: UserView,
  ): ArchiveView {
    const current = this.requireArchive(id);
    // 档案级权限：受限档案非创建者/管理员不能编辑（先过查看，再校角色与归属）。
    if (!this.access.canEdit(operator, current, 'archiveManage')) {
      throw new ForbiddenException('无权编辑该档案（仅管理员或创建者本人可编辑）');
    }
    if (current.status === 'archived') {
      throw new BadRequestException('档案已归档，著录信息不可修改');
    }
    const fields = this.validateArchiveFields(input, false);
    const category = this.requireCategory(fields.categoryId);
    const accessLevel =
      input.accessLevel !== undefined ? this.validateAccessLevel(input.accessLevel) : current.accessLevel;
    // 动态字段按目标分类模板校验（分类变更则按新模板）；仅在传入 fieldValues 时重写。
    const dynamic =
      input.fieldValues !== undefined
        ? this.validateDynamicValues(fields.categoryId, input.fieldValues)
        : null;
    // 分类或形成年度变化时重生成档号（保持编码链与年度一致，规则见文件头注释）
    const oldYear = (current.formationDate ?? '').slice(0, 4);
    const nextYear = (fields.formationDate ?? '').slice(0, 4) || String(new Date().getFullYear());
    const needRenumber =
      category.id !== current.categoryId || nextYear !== (oldYear || nextYear);
    const patch: Partial<ArchiveRow> = {
      title: fields.title,
      categoryId: category.id,
      archiveType: fields.archiveType,
      keywords: fields.keywords,
      formationDate: fields.formationDate,
      responsible: fields.responsible,
      remarks: fields.remarks,
      accessLevel,
      updatedBy: operator.id,
    };
    if (needRenumber) {
      patch.archiveNo = this.buildArchiveNo(category, nextYear, current.id);
    }
    const accessChanged = input.accessLevel !== undefined && accessLevel !== current.accessLevel;
    try {
      this.tx.run(() => {
        this.archives.applyUpdate(id, patch);
        if (dynamic !== null) this.fieldValues.replaceAll(id, dynamic);
        this.audit.logTx(
          this.event(operator, AUDIT_ACTION.ARCHIVE_UPDATE, AUDIT_OBJECT.ARCHIVE, id, {
            title: fields.title,
            categoryId: category.id,
            renumbered: needRenumber,
          }),
        );
        // 访问级别变更属关键状态变更：与写入同事务单独留痕，便于追溯授权收敛/放开。
        if (accessChanged) {
          this.audit.logTx(
            this.event(
              operator,
              AUDIT_ACTION.ARCHIVE_ACCESS_CHANGE,
              AUDIT_OBJECT.ARCHIVE,
              id,
              { from: current.accessLevel, to: accessLevel },
            ),
          );
        }
      });
    } catch (err) {
      mapUniqueError(err, '档号冲突，请重试');
    }
    // 元数据/分类变更后尽力刷新图谱（影响确定性关联与节点展示名）；失败只记告警，不影响业务
    this.graph.refreshArchiveSafely(id, '档案元数据变更');
    return this.toArchiveView(this.requireArchive(id));
  }

  /** 归档流转：仅 draft → archived，单向；由控制器限制管理员/审核员角色。 */
  transitionToArchived(
    id: number,
    operator: UserView,
  ): ArchiveView {
    const current = this.requireArchive(id);
    // 受限档案未授权者不得归档（先过查看权限）。
    this.access.assertView(operator, current);
    if (current.status === 'archived') {
      // 重复点击归档：直接拒绝（不重复流转、不产生重复版本）——与第二批回归保持一致
      throw new BadRequestException('该档案已处于归档状态');
    }
    // 第三批：接入在线编辑的档案，归档前必须已成功入库至少一个文件版本，
    // 防止「数据库显示已归档但文件实际缺失」。未接入在线编辑的档案沿用第二批逻辑。
    if (this.documents.findByArchiveId(id) && this.versions.countByArchiveId(id) === 0) {
      throw new BadRequestException(
        '该档案已接入在线编辑，归档前请先将编辑成果回传入库形成文件版本',
      );
    }
    this.tx.run(() => {
      this.archives.applyUpdate(id, { status: 'archived', updatedBy: operator.id });
      this.audit.logTx(
        this.event(operator, AUDIT_ACTION.ARCHIVE_ARCHIVE, AUDIT_OBJECT.ARCHIVE, id, {
          archiveNo: current.archiveNo,
          title: current.title,
        }),
      );
    });
    return this.toArchiveView(this.requireArchive(id));
  }

  /**
   * 删除草稿档案（方案 A：仅草稿可物理删除）。
   * - 仅 draft 可删：已归档档案承载归档事实，永久保留（不需清理时走 V1.5 保留期策略）；
   * - 归属复核与编辑一致：管理员或创建者本人，其余角色/他人一律 403；
   * - 同一事务内按外键顺序清理文件版本/在线文档关联/附件/动态著录值/借阅记录与档案本体，
   *   并写 archive.delete 审计（detail 保留删除前题名/档号与清理数量）；
   * - 物理文件在事务提交后清理：文件系统不参与数据库事务，删除失败仅遗留孤儿文件，
   *   不会导致「库中还有记录但文件已被删」。
   */
  deleteArchive(id: number, operator: UserView): { ok: true } {
    const current = this.requireArchive(id);
    if (!this.access.canEdit(operator, current, 'archiveManage')) {
      throw new ForbiddenException('无权删除该档案（仅管理员或创建者本人可删除）');
    }
    if (current.status !== 'draft') {
      throw new BadRequestException('档案已归档，不可删除（归档档案需长期保留）');
    }
    const purged = this.tx.run(() => {
      const result = this.archives.purge(id);
      this.audit.logTx(
        this.event(operator, AUDIT_ACTION.ARCHIVE_DELETE, AUDIT_OBJECT.ARCHIVE, id, {
          title: current.title,
          archiveNo: current.archiveNo,
          categoryId: current.categoryId,
          fileCount: result.fileCount,
          versionCount: result.versionCount,
        }),
      );
      return result;
    });
    for (const storedName of purged.fileStoredNames) this.storage.deleteStored(storedName);
    return { ok: true as const };
  }

  /**
   * 删除单个附件（仅未归档草稿）。
   * - 归属复核与上传同口径：管理员或档案创建者本人（canEdit + fileUpload），其余角色/他人一律 403；
   * - 仅 draft 档案可删附件：已归档档案承载归档事实，附件不得删除；
   * - 事务内经 deleteDetached 先解除在线文档/文件版本的 source_file_id 引用再删本体，
   *   正文索引单元/片段、FTS 倒排、知识库任务与向量随之由触发器/级联自动清理，不留幽灵命中；
   *   并写 file.delete 审计（detail 保留所属档案 id、删除前文件名与大小）；
   * - 物理文件在事务提交后删除：文件系统不参与数据库事务，删除失败仅遗留孤儿文件，
   *   不会导致「库中还有记录但文件已被删」。
   */
  deleteFile(fileId: number, operator: UserView): { ok: true } {
    const row = this.files.findById(fileId);
    if (!row) throw new NotFoundException('附件不存在或已被清理');
    const archive = this.requireArchive(row.archiveId);
    if (!this.access.canEdit(operator, archive, 'fileUpload')) {
      throw new ForbiddenException('无权删除该附件（仅管理员或档案创建者本人可删除）');
    }
    if (archive.status !== 'draft') {
      throw new BadRequestException('档案已归档，不可删除附件（归档档案需长期保留）');
    }
    this.tx.run(() => {
      this.files.deleteDetached(fileId);
      this.audit.logTx(
        this.event(operator, AUDIT_ACTION.FILE_DELETE, AUDIT_OBJECT.FILE, fileId, {
          archiveId: row.archiveId,
          name: row.originalName,
          size: row.fileSize,
        }),
      );
    });
    this.storage.deleteStored(row.storedName);
    return { ok: true as const };
  }

  private validateArchiveFields(
    input: {
      title?: string;
      categoryId?: number;
      archiveType?: string;
      keywords?: string;
      formationDate?: string | null;
      responsible?: string;
      remarks?: string;
    },
    _partial: boolean,
  ): {
    title: string;
    categoryId: number;
    archiveType: string;
    keywords: string;
    formationDate: string | null;
    responsible: string;
    remarks: string;
  } {
    const title = String(input.title ?? '').trim();
    if (!title || title.length > 200) throw new BadRequestException('档案标题需为 1-200 个字符');
    const categoryId = Number(input.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      throw new BadRequestException('请选择所属分类');
    }
    const archiveType = String(input.archiveType ?? '').trim() || '文书档案';
    if (!(ARCHIVE_TYPES as readonly string[]).includes(archiveType)) {
      throw new BadRequestException('档案类型不合法');
    }
    const keywords = String(input.keywords ?? '').trim();
    if (keywords.length > 200) throw new BadRequestException('关键词不能超过 200 个字符');
    const rawDate = input.formationDate === undefined ? null : input.formationDate;
    let formationDate: string | null = null;
    if (rawDate !== null && String(rawDate) !== '') {
      const s = String(rawDate).slice(0, 10);
      if (!DATE_RE.test(s) || Number(s.slice(0, 4)) < 1900 || Number(s.slice(5, 7)) > 12) {
        throw new BadRequestException('形成时间格式需为 YYYY-MM-DD');
      }
      formationDate = s;
    }
    const responsible = String(input.responsible ?? '').trim();
    if (responsible.length > 100) throw new BadRequestException('责任者不能超过 100 个字符');
    const remarks = String(input.remarks ?? '').trim();
    if (remarks.length > 500) throw new BadRequestException('备注说明不能超过 500 个字符');
    return { title, categoryId, archiveType, keywords, formationDate, responsible, remarks };
  }

  /** 档号 = 分类编码链-年度-全局流水（6 位补零）。 */
  private buildArchiveNo(category: CategoryView, year: string, seq: number): string {
    let prefix = category.pathCode;
    if (prefix.length > 64) prefix = prefix.slice(0, 64);
    return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
  }

  private requireArchive(id: number): ArchiveRow {
    const row = this.archives.findById(id);
    if (!row) throw new NotFoundException('档案不存在');
    return row;
  }

  // 档案著录上下文中的分类校验：不存在归为入参非法（400），而非资源缺失（404）
  private requireCategory(id: number): CategoryView {
    const view = this.listCategories().find((c) => c.id === id);
    if (!view) throw new BadRequestException('分类不存在');
    return view;
  }

  /** 访问级别合法性（仅 public / restricted，默认 public）。 */
  private validateAccessLevel(raw: unknown): 'public' | 'restricted' {
    if (raw === undefined || raw === null || raw === '') return 'public';
    const s = String(raw);
    if (s !== 'public' && s !== 'restricted') throw new BadRequestException('档案访问级别不合法');
    return s;
  }

  /**
   * 按目标分类绑定模板的启用字段，逐项校验并归一化动态著录值。
   * 未绑定模板时返回空数组（固定著录字段链路不受影响，保持向后兼容）。
   */
  private validateDynamicValues(
    categoryId: number,
    raw: Record<string, unknown> | undefined,
  ): Array<{ fieldId: number; fieldKey: string; value: string }> {
    const activeFields = this.templates.activeFieldRowsByCategory(categoryId);
    if (activeFields.length === 0) return [];
    const input = raw ?? {};
    const out: Array<{ fieldId: number; fieldKey: string; value: string }> = [];
    for (const field of activeFields) {
      const value = normalizeArchiveValue(field, input[field.fieldKey]);
      out.push({ fieldId: field.id, fieldKey: field.fieldKey, value });
    }
    return out;
  }

  /** 读取档案已存的动态著录值，按字段定义回显（含已停用字段的历史值）。 */
  private getDynamicFields(archiveId: number): ArchiveFieldValueView[] {
    return this.fieldValues.listByArchive(archiveId).map((v) => {
      const field = this.templates.findFieldById(v.fieldId);
      return {
        fieldKey: v.fieldKey,
        label: field?.label ?? v.fieldKey,
        type: (field?.type ?? 'text') as FieldType,
        value: v.valueText,
      };
    });
  }

  private categorySubtreeIds(rootId: number): number[] {
    const rows = this.categories.listAll();
    const childrenOf = new Map<number, number[]>();
    for (const r of rows) {
      if (r.parentId == null) continue;
      const list = childrenOf.get(r.parentId) ?? [];
      list.push(r.id);
      childrenOf.set(r.parentId, list);
    }
    const out: number[] = [];
    const queue = [rootId];
    const seen = new Set<number>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
    return out;
  }

  private toArchiveView(row: ArchiveRow): ArchiveView {
    const catView = this.requireCategoryById(row.categoryId);
    const pathMap = new Map(this.listCategories().map((c) => [c.id, c]));
    return {
      id: row.id,
      title: row.title,
      archiveNo: row.archiveNo,
      categoryId: row.categoryId,
      categoryName: catView.name,
      categoryPath: this.categoryPathName(catView, pathMap),
      archiveType: row.archiveType,
      keywords: row.keywords,
      formationDate: row.formationDate,
      responsible: row.responsible,
      remarks: row.remarks,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] ?? row.status,
      accessLevel: row.accessLevel,
      createdByName: row.creatorName ?? '未知用户',
      createdByRoleLabel: roleLabel(row.creatorRole ?? ''),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private categoryPathName(
    view: CategoryView,
    byId: Map<number, CategoryView>,
  ): string {
    const names: string[] = [view.name];
    let cursor = view.parentId == null ? undefined : byId.get(view.parentId);
    let guard = 0;
    while (cursor && guard < 10) {
      names.unshift(cursor.name);
      cursor = cursor.parentId == null ? undefined : byId.get(cursor.parentId);
      guard += 1;
    }
    return names.join(' / ');
  }

  // ==================== 附件 ====================

  listFiles(archiveId: number, viewer: UserView): ArchiveFileView[] {
    const row = this.requireArchive(archiveId);
    this.access.assertView(viewer, row);
    return this.archives.listFiles(archiveId).map((f) => this.toFileView(f));
  }

  /**
   * 附件正文索引状态（第二阶段）：只返回当前用户有权查看的档案的附件状态。
   * 用途：让详情页如实展示「哪些附件已可被检索、哪些不能以及真实原因」，
   * 不返回任何正文内容本身。
   */
  getContentStatus(archiveId: number, viewer: UserView): ArchiveContentStatus {
    const row = this.requireArchive(archiveId);
    this.access.assertView(viewer, row);
    return { archiveId, synced: 0, files: this.content.describe(archiveId) };
  }

  /**
   * 手动重建正文索引：只对索引表做幂等重写，不改动档案/附件/版本的任何业务字段。
   * 已索引当前内容的文件会直接跳过，因此重复调用不会产生重复索引。
   */
  reindexContent(archiveId: number, viewer: UserView): ArchiveContentStatus {
    const row = this.requireArchive(archiveId);
    this.access.assertView(viewer, row);
    const status = this.content.syncArchive(archiveId, true);
    this.audit.record(
      { id: viewer.id, role: viewer.role, ip: null },
      AUDIT_ACTION.ARCHIVE_UPDATE,
      AUDIT_OBJECT.ARCHIVE,
      archiveId,
      { contentReindex: true, synced: status.synced },
    );
    return status;
  }

  /** 附件正文索引钩子：提取失败不得阻断业务写入，仅记告警（正文缺失时问答会如实说明证据不足）。 */
  private contentIndexSafely(fileId: number, scene: string): void {
    try {
      this.content.ensureJob(fileId);
    } catch (err) {
      console.warn(`[content] ${scene} 正文索引失败（不影响业务）：${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * 保存上传文件并登记元数据：
   * - 扩展名白名单 + 大小上限（流式实时中断）+ 文件名净化；
   * - 数据库写入失败时删除已落盘文件，保证元数据与物理文件一致；
   * - 已归档档案禁止再挂接附件（归档只读约束）。
   */
  async uploadFile(
    archiveId: number,
    source: ReadableStream<Uint8Array>,
    rawName: string,
    contentType: string,
    operator: UserView,
  ): Promise<ArchiveFileView> {
    const archive = this.requireArchive(archiveId);
    // 受限档案未授权者不得上传（先过查看权限）。
    this.access.assertView(operator, archive);
    if (archive.status === 'archived') {
      throw new BadRequestException('档案已归档，不可再上传附件');
    }
    const safeName = this.sanitizeDisplayName(rawName);
    const extension = (path.extname(safeName).replace(/^\./, '') || '').toLowerCase();
    if (!this.storage.isAllowedExtension(extension)) {
      throw new BadRequestException(
        `暂不支持 .${extension || '未知'} 格式，仅支持：${ALLOWED_EXTENSIONS.join('、')}`,
      );
    }
    let stored;
    try {
      stored = await this.storage.saveStream(source, extension);
    } catch (err) {
      if (err instanceof FileStoreError) throw new BadRequestException(err.message);
      throw err;
    }
    const displayName = this.deduplicateName(archiveId, safeName);
    try {
      const row = this.files.insert({
        archiveId,
        originalName: displayName,
        storedName: stored.storedName,
        extension,
        fileSize: stored.size,
        contentType: String(contentType || '').slice(0, 100),
        sha256: stored.sha256,
        uploadedBy: operator.id,
      });
      // 上传为「响应已成事实」的非关键事件：成功落库后尽力留痕（不含文件正文）。
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.FILE_UPLOAD,
        AUDIT_OBJECT.FILE,
        row.id,
        { archiveId, name: displayName, size: stored.size },
      );
      // 第二阶段：新上传件持久化索引任务，由后台提取正文（失败不影响上传，仅该附件暂无正文可检索）
      this.contentIndexSafely(row.id, '附件上传');
      return this.toFileView(row);
    } catch (err) {
      this.storage.tryDelete(path.join(this.storage.root, stored.storedName)); // 元数据写入失败即回滚物理文件
      mapUniqueError(err, '附件登记失败，请重试');
    }
    throw new InternalServerErrorException('附件登记失败，请重试');
  }

  /** 下载授权复核 + 物理文件定位；调用前控制器已完成角色守卫。 */
  resolveForDownload(fileId: number, viewer: UserView): { view: ArchiveFileView; filePath: string; row: FileRow } {
    const row = this.files.findById(fileId);
    if (!row) throw new NotFoundException('附件不存在或已被清理');
    const archive = this.requireArchive(row.archiveId); // 归属档案必须存在（默认拒绝）
    try {
      this.access.assertDownload(viewer, archive); // 档案级下载权限
    } catch (err) {
      // 越权下载尝试明确记 failure（不混淆为成功），随后抛出交由守卫返回 403。
      this.audit.record(
        { id: viewer.id, role: viewer.role, ip: null },
        AUDIT_ACTION.FILE_DOWNLOAD,
        AUDIT_OBJECT.FILE,
        row.id,
        { archiveId: row.archiveId, denied: true },
        'failure',
      );
      throw err;
    }
    const filePath = this.storage.resolveStored(row.storedName);
    if (!filePath) {
      throw new NotFoundException('文件实体缺失，请联系管理员核查存储目录');
    }
    this.audit.record(
      { id: viewer.id, role: viewer.role, ip: null },
      AUDIT_ACTION.FILE_DOWNLOAD,
      AUDIT_OBJECT.FILE,
      row.id,
      { archiveId: row.archiveId, name: row.originalName },
    );
    return { view: this.toFileView(row), filePath, row };
  }

  /**
   * 在线预览授权复核 + 物理文件定位 + 真实格式判定（V1.0 多格式预览）。
   * 权限关系：预览同样向浏览器传输完整文件字节，门槛与下载严格同级
   * （复用 ArchiveAccessService.canDownload：角色矩阵 + 受限档案借阅授权 can_download），
   * 因此预览不可能以较弱的目录查看权限绕过下载限制；借阅归还/到期后授权失效，预览立即 403。
   */
  resolveForPreview(
    fileId: number,
    viewer: UserView,
  ): { view: ArchiveFileView; filePath: string; type: PreviewFileType; size: number } {
    const row = this.files.findById(fileId);
    if (!row) throw new NotFoundException('附件不存在或已被清理');
    const archive = this.requireArchive(row.archiveId); // 归属档案必须存在（默认拒绝）
    try {
      this.access.assertDownload(viewer, archive); // 预览与下载同级授权
    } catch (err) {
      // 越权预览尝试记 failure 后抛出，交由守卫返回 403（不泄露任何文件字节）。
      this.audit.record(
        { id: viewer.id, role: viewer.role, ip: null },
        AUDIT_ACTION.FILE_PREVIEW_DENIED,
        AUDIT_OBJECT.FILE,
        row.id,
        { archiveId: row.archiveId, denied: true },
        'failure',
      );
      throw err;
    }
    const filePath = this.storage.resolveStored(row.storedName);
    if (!filePath) {
      throw new NotFoundException('文件实体缺失，请联系管理员核查存储目录');
    }
    const type = detectPreviewFileType(filePath);
    if (!type) {
      throw new NotFoundException('文件实体不可读，请稍后重试');
    }
    const size = fs.statSync(filePath).size;
    this.audit.record(
      { id: viewer.id, role: viewer.role, ip: null },
      AUDIT_ACTION.FILE_PREVIEW,
      AUDIT_OBJECT.FILE,
      row.id,
      { archiveId: row.archiveId, name: row.originalName, kind: type.kind },
    );
    return { view: this.toFileView(row), filePath, type, size };
  }

  private toFileView(row: FileRow): ArchiveFileView {
    return {
      id: row.id,
      originalName: row.originalName,
      extension: row.extension,
      fileSize: row.fileSize,
      contentType: row.contentType,
      uploadedByName: row.uploaderName ?? '未知用户',
      uploadedAt: row.uploadedAt,
    };
  }

  /** 文件名净化：去掉路径与危险字符，仅用于展示；物理存储名由服务端生成。 */
  private sanitizeDisplayName(raw: string): string {
    const base = path.basename(String(raw || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')).trim();
    const name = base || '未命名文件';
    return name.length > 120 ? `${name.slice(0, 100)}${path.extname(name)}`.slice(0, 120) : name;
  }

  /** 同一档案下重名附件自动追加序号，显示名不覆盖既有记录。 */
  private deduplicateName(archiveId: number, displayName: string): string {
    const existing = this.files.countSameName(archiveId, displayName);
    if (existing === 0) return displayName;
    const ext = path.extname(displayName);
    const stem = displayName.slice(0, displayName.length - ext.length);
    let candidate = `${stem}(${existing + 1})${ext}`;
    let n = existing + 1;
    while (this.files.countSameName(archiveId, candidate) > 0) {
      n += 1;
      candidate = `${stem}(${n})${ext}`;
    }
    return candidate;
  }

  private positiveInt(raw: string | undefined, fallback: number, label: string): number {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${label}参数不合法`);
    return n;
  }

  /** 构造审计事件（操作人一律来自已校验会话；ip 服务层无上下文时留空）。 */
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
}
