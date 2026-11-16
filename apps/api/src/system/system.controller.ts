/**
 * 系统信息接口（需登录）：工作台展示真实用户与系统信息，不使用虚构业务统计。
 * 用户概况（按角色统计）仅对管理员返回。
 */
import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { SYSTEM_INFO } from '../config';
import { ROLE_ADMIN, ROLE_LABELS, UserView } from '../common/roles';
import { UserRepository } from '../users/user.repository';
import { CurrentUser, SessionGuard } from '../auth/guards';

@Controller('system')
@UseGuards(SessionGuard)
export class SystemController {
  constructor(@Inject(UserRepository) private readonly users: UserRepository) {}

  @Get('info')
  info(@CurrentUser() user: UserView) {
    const base = {
      ...SYSTEM_INFO,
      runtime: {
        node: process.version,
        database: 'SQLite',
        apiPort: Number(process.env.JIT_PORT || 5006),
        startedAt: STARTED_AT,
      },
      currentUser: user,
    };
    if (user.role === ROLE_ADMIN) {
      const counts = this.users.countByRole();
      return {
        ...base,
        userOverview: {
          total: this.users.countUsers(),
          byRole: counts.map((c) => ({ role: c.role, roleLabel: ROLE_LABELS[c.role], count: c.count })),
        },
      };
    }
    return base;
  }
}

const STARTED_AT = new Date().toISOString();
