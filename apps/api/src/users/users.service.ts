/**
 * 用户管理服务（仅管理员可调用，角色在 controller 守卫上落实）。
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserView, isValidRole } from '../common/roles';
import { UpdateUserInput, UserRepository } from './user.repository';
import { AuthService, toUserView } from '../auth/auth.service';
import { hashPassword } from '../auth/password';
import { SqliteTransaction } from '../db/transaction';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, AUDIT_OBJECT, AuditEvent } from '../audit/audit.types';

@Injectable()
export class UsersService {
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  listUsers(): UserView[] {
    return this.users.listUsers().map(toUserView);
  }

  createUser(
    input: {
      username: string;
      displayName?: string;
      password: string;
      role: string;
    },
    operator: UserView,
  ): UserView {
    const username = this.auth.validateUsername(input.username);
    this.auth.validatePassword(input.password);
    if (!isValidRole(input.role)) {
      throw new BadRequestException('角色不合法，必须是系统预设五类角色之一');
    }
    const role = input.role;
    if (this.users.findByUsername(username)) {
      throw new ConflictException(`账号 ${username} 已存在`);
    }
    // 用户创建与成功审计同事务提交（create 为普通写入，可安全纳入外层写事务）
    const user = this.tx.run(() => {
      const created = this.users.create({
        username,
        displayName: (input.displayName || '').trim() || username,
        passwordHash: hashPassword(input.password),
        role,
      });
      this.audit.logTx(this.event(operator, AUDIT_ACTION.USER_CREATE, created.id, {
        username: created.username,
        role: created.role,
      }));
      return created;
    });
    return toUserView(user);
  }

  updateUser(
    id: number,
    input: { displayName?: string; role?: string; status?: string; password?: string },
    operator: UserView,
  ): UserView {
    const target = this.users.findById(id);
    if (!target) throw new NotFoundException('用户不存在');

    const patch: UpdateUserInput = {};
    if (input.displayName !== undefined) {
      const name = String(input.displayName).trim();
      if (!name || name.length > 32) throw new BadRequestException('显示名长度需为 1-32 位');
      patch.displayName = name;
    }
    if (input.role !== undefined) {
      if (!isValidRole(input.role)) throw new BadRequestException('角色不合法');
      patch.role = input.role;
    }
    if (input.status !== undefined) {
      if (input.status !== 'active' && input.status !== 'disabled') {
        throw new BadRequestException('状态只能为 active 或 disabled');
      }
      if (target.id === operator.id && input.status === 'disabled') {
        throw new BadRequestException('不能禁用当前登录的自己');
      }
      patch.status = input.status;
    }
    if (input.password !== undefined) {
      this.auth.validatePassword(input.password);
      patch.passwordHash = hashPassword(input.password);
    }
    if (Object.keys(patch).length === 0) throw new BadRequestException('没有需要修改的内容');

    // 预构造成功审计（按实际变更类型）；与角色/启停写入在同一事务内提交。
    // 注意：绝不将密码写入审计，仅记变更种类。
    const pendingEvents: AuditEvent[] = [];
    if (patch.role !== undefined && patch.role !== target.role) {
      pendingEvents.push(
        this.event(operator, AUDIT_ACTION.USER_ROLE_CHANGE, id, {
          username: target.username,
          from: target.role,
          to: patch.role,
        }),
      );
    }
    if (patch.status !== undefined && patch.status !== target.status) {
      pendingEvents.push(
        this.event(operator, AUDIT_ACTION.USER_STATUS_CHANGE, id, {
          username: target.username,
          from: target.status,
          to: patch.status,
        }),
      );
    }
    if (patch.passwordHash) {
      pendingEvents.push(
        this.event(operator, AUDIT_ACTION.USER_PASSWORD_RESET, id, { username: target.username }),
      );
    }
    if (
      patch.displayName !== undefined &&
      pendingEvents.length === 0 // 仅显示名变更时记为资料更新，避免与角色/状态/改密重复
    ) {
      pendingEvents.push(
        this.event(operator, AUDIT_ACTION.USER_PROFILE_UPDATE, id, { username: target.username }),
      );
    }

    // 检查“至少保留一名启用管理员”与写入在仓储层的同一事务内完成，避免并发绕过；
    // onSuccess 在该事务内落成功审计（若审计抛错则业务一并回滚）。
    const result = this.users.updateWithActiveAdminGuard(id, patch, () => {
      for (const e of pendingEvents) this.audit.logTx(e);
    });
    if (!result.ok) {
      if (result.reason === 'not-found') throw new NotFoundException('用户不存在');
      throw new BadRequestException('至少需要保留一名启用的管理员');
    }
    if (patch.status === 'disabled') {
      this.auth.revokeUserSessions(id); // 禁用即刻踢出该用户在线会话
    }
    if (patch.passwordHash) {
      this.auth.revokeUserSessions(id); // 改密后旧会话失效，需重新登录
    }
    return toUserView(result.user);
  }

  /** 构造审计事件（操作人一律来自已校验的 operator，ip 由服务层无上下文时留空）。 */
  private event(
    operator: UserView,
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
    targetUserId: number,
    detail: Record<string, unknown>,
  ): AuditEvent {
    return {
      actorUserId: operator.id,
      actorRole: operator.role,
      action,
      objectType: AUDIT_OBJECT.USER,
      objectId: targetUserId,
      result: 'success',
      detail,
      ip: null,
    };
  }
}
