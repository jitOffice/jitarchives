/**
 * 用户管理接口：全部要求登录，且仅管理员角色可访问（PRD 5.4 基础授权）。
 * 普通用户直接请求这些接口会收到 403。
 */
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ROLE_ADMIN, UserView } from '../common/roles';
import { UsersService } from './users.service';
import { CurrentUser, Roles, RolesGuard, SessionGuard } from '../auth/guards';

@UseGuards(SessionGuard, RolesGuard)
@Roles(ROLE_ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): UserView[] {
    return this.users.listUsers();
  }

  @Post()
  create(
    @Body() body: { username?: string; displayName?: string; password?: string; role?: string },
    @CurrentUser() operator: UserView,
  ): UserView {
    return this.users.createUser(
      {
        username: body.username ?? '',
        displayName: body.displayName,
        password: body.password ?? '',
        role: body.role ?? '',
      },
      operator,
    );
  }

  /** 修改角色 / 启用禁用 / 显示名 / 重置密码（仅管理员）。 */
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { displayName?: string; role?: string; status?: string; password?: string },
    @CurrentUser() operator: UserView,
  ): UserView {
    return this.users.updateUser(id, body, operator);
  }
}
