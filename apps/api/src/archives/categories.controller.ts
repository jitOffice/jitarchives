/**
 * 档案分类接口（阶段二第二批）。
 * 全部要求登录；读操作按 archiveView/categoryView 矩阵，写操作按 categoryManage 矩阵，
 * 由后端独立校验（不依赖前端按钮状态）。删除仅允许无子分类且无档案引用的分类，
 * 引用保护在服务层与外键双重强制。
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
import { ArchivesService, CategoryView } from './archives.service';

@UseGuards(SessionGuard, PermissionGuard)
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: ArchivesService) {}

  @Get()
  @Perm('categoryView')
  list(@CurrentUser() viewer: UserView): CategoryView[] {
    return this.service.listCategories(viewer);
  }

  @Post()
  @Perm('categoryManage')
  create(
    @Body()
    body: { name?: string; code?: string; description?: string; parentId?: number | null },
    @CurrentUser() operator: UserView,
  ): CategoryView {
    return this.service.createCategory(
      {
        name: body.name ?? '',
        code: body.code ?? '',
        description: body.description ?? '',
        parentId: body.parentId ?? null,
      },
      operator,
    );
  }

  /** 名称/编码/说明/父级均可调整；父级变更在服务层做循环引用与深度校验。 */
  @Put(':id')
  @Perm('categoryManage')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: { name?: string; code?: string; description?: string; parentId?: number | null },
    @CurrentUser() operator: UserView,
  ): CategoryView {
    return this.service.updateCategory(id, body, operator);
  }

  /** 删除分类：无子分类且无档案引用才允许，否则 400 并返回具体原因。 */
  @Delete(':id')
  @Perm('categoryManage')
  delete(@Param('id', ParseIntPipe) id: number, @CurrentUser() operator: UserView): { ok: true } {
    return this.service.deleteCategory(id, operator);
  }
}
