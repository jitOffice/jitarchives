/**
 * 登录状态校验守卫 + 角色守卫 + 参数装饰器。
 * 未登录（无有效会话 Cookie）不能访问任何受保护接口。
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SESSION_COOKIE } from '../config';
import { Role, UserView } from '../common/roles';
import { PermKey, hasPermission } from '../common/permissions';
import { AuthService } from './auth.service';

/** 标记接口所需角色（配合 RolesGuard 使用）。 */
export const ROLES_KEY = 'jit_roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** 标记接口所需档案业务权限点（配合 PermissionGuard，角色矩阵见 common/permissions.ts）。 */
export const PERM_KEY = 'jit_perm';
export const Perm = (perm: PermKey) => SetMetadata(PERM_KEY, perm);

/** 注入当前登录用户（UserView，不含密码/哈希）。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserView => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: UserView }>();
    return req.user as UserView;
  },
);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: UserView }>();
    const token = req.cookies?.[SESSION_COOKIE];
    const user = this.auth.resolveSessionUser(token);
    if (!user) {
      throw new UnauthorizedException('未登录或会话已失效');
    }
    req.user = user;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const req = context.switchToHttp().getRequest<Request & { user?: UserView }>();
    const user = req.user;
    if (!user) throw new UnauthorizedException('未登录或会话已失效');
    if (!required.includes(user.role)) {
      throw new ForbiddenException('无权访问该功能');
    }
    return true;
  }
}

/** 档案业务权限守卫：未登录 401，角色不在权限矩阵允许集合内一律 403（默认拒绝）。 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const perm = this.reflector.getAllAndOverride<PermKey | undefined>(PERM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!perm) return true;
    const req = context.switchToHttp().getRequest<Request & { user?: UserView }>();
    const user = req.user;
    if (!user) throw new UnauthorizedException('未登录或会话已失效');
    if (!hasPermission(user.role, perm)) {
      throw new ForbiddenException('当前角色无权执行该操作');
    }
    return true;
  }
}
