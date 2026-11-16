/**
 * 元数据模板管理接口（阶段二第四批 · 功能一）。
 * 模板本身的增删改查与启停 = templateManage（管理员）；
 * 删除按引用保护开放（未被绑定、无历史著录值才可删），引用保护在服务层与外键双重强制。
 * 供档案著录表单拉取动态字段 = templateView（管理员/著录员）。
 * 全部经 SessionGuard + PermissionGuard，服务端独立校验。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, PermissionGuard, CurrentUser, Perm } from '../auth/guards';
import { UserView } from '../common/roles';
import {
  FieldView,
  MetadataTemplatesService,
  TemplateDetailView,
  TemplateView,
} from './metadata-templates.service';

type FieldInput = {
  fieldKey?: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: unknown;
  validation?: unknown;
  sortNo?: number;
};

@UseGuards(SessionGuard, PermissionGuard)
@Controller('templates')
export class MetadataTemplatesController {
  constructor(private readonly service: MetadataTemplatesService) {}

  @Get()
  @Perm('templateView')
  list(): TemplateView[] {
    return this.service.listTemplates();
  }

  @Get(':id')
  @Perm('templateView')
  detail(@Param('id', ParseIntPipe) id: number): TemplateDetailView {
    return this.service.getTemplate(id);
  }

  @Post()
  @Perm('templateManage')
  create(
    @Body()
    body: { name?: string; description?: string; fields?: FieldInput[] },
    @CurrentUser() operator: UserView,
  ): TemplateDetailView {
    return this.service.createTemplate(body, operator);
  }

  @Put(':id')
  @Perm('templateManage')
  updateMeta(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; description?: string },
    @CurrentUser() operator: UserView,
  ): TemplateView {
    return this.service.updateTemplateMeta(id, body, operator);
  }

  @Post(':id/status')
  @Perm('templateManage')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status?: string },
    @CurrentUser() operator: UserView,
  ): TemplateView {
    const status = String(body?.status) === 'disabled' ? 'disabled' : 'active';
    return this.service.setTemplateStatus(id, status, operator);
  }

  /** 删除模板：仅未被分类绑定且无历史著录值的模板可删，否则 400 并提示改为停用。 */
  @Delete(':id')
  @Perm('templateManage')
  delete(@Param('id', ParseIntPipe) id: number, @CurrentUser() operator: UserView): { ok: true } {
    return this.service.deleteTemplate(id, operator);
  }

  @Post(':id/fields')
  @Perm('templateManage')
  addField(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: FieldInput,
    @CurrentUser() operator: UserView,
  ): FieldView {
    return this.service.addField(id, body, operator);
  }

  @Put(':id/fields/:fieldId')
  @Perm('templateManage')
  updateField(
    @Param('id', ParseIntPipe) id: number,
    @Param('fieldId', ParseIntPipe) fieldId: number,
    @Body() body: Partial<FieldInput> & { active?: boolean },
    @CurrentUser() operator: UserView,
  ): FieldView {
    return this.service.updateField(id, fieldId, body, operator);
  }

  @Delete(':id/fields/:fieldId')
  @Perm('templateManage')
  deactivateField(
    @Param('id', ParseIntPipe) id: number,
    @Param('fieldId', ParseIntPipe) fieldId: number,
    @CurrentUser() operator: UserView,
  ): FieldView {
    return this.service.deactivateField(id, fieldId, operator);
  }
}

/**
 * 分类 ↔ 模板绑定与著录表单字段拉取（挂在 /categories 下，与既有分类接口同前缀）。
 * 绑定=categoryManage（管理员/著录员/审核员）；表单字段=templateView。
 */
@UseGuards(SessionGuard, PermissionGuard)
@Controller('categories')
export class CategoryTemplateController {
  constructor(private readonly service: MetadataTemplatesService) {}

  @Put(':id/template')
  @Perm('categoryManage')
  bind(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { templateId?: number | null },
    @CurrentUser() operator: UserView,
  ): { categoryId: number; templateId: number | null } {
    const templateId =
      body?.templateId === undefined || body?.templateId === null ? null : Number(body.templateId);
    return this.service.bindCategory(id, templateId, operator);
  }

  /** 著录表单按分类拉取模板与启用字段（无绑定返回空字段）。 */
  @Get(':id/template-fields')
  @Perm('templateView')
  fields(@Param('id', ParseIntPipe) id: number): {
    template: TemplateView | null;
    fields: FieldView[];
  } {
    return this.service.getTemplateByCategory(id);
  }
}
