/**
 * 基础设施模块：数据库连接 + 数据访问实现。
 * 上层业务只依赖抽象 Token（UserRepository / SessionRepository），
 * 后续替换 PostgreSQL 实现只需改动本模块的 useClass 绑定。
 */
import { Module, Global } from '@nestjs/common';
import { DATABASE, DatabaseProvider } from './database';
import { SqliteTransaction } from './transaction';
import { UserRepository, SqliteUserRepository } from '../users/user.repository';
import { SessionRepository, SqliteSessionRepository } from '../auth/session.repository';
import {
  InvitationCodeRepository,
  SqliteInvitationCodeRepository,
} from '../auth/invitation-code.repository';
import {
  RegistrationDeviceRepository,
  SqliteRegistrationDeviceRepository,
} from '../auth/registration-device.repository';
import { GraphMaintenanceHooks } from '../graph/graph.hooks';

@Global()
@Module({
  providers: [
    DatabaseProvider,
    SqliteTransaction,
    { provide: UserRepository, useClass: SqliteUserRepository },
    { provide: SessionRepository, useClass: SqliteSessionRepository },
    { provide: InvitationCodeRepository, useClass: SqliteInvitationCodeRepository },
    { provide: RegistrationDeviceRepository, useClass: SqliteRegistrationDeviceRepository },
    // 图谱维护钩子（全局单例）：正文索引侧只依赖这个容器，图谱模块启动时注册委托，
    // 图谱未启用时全部为空操作，不影响既有业务写入。
    GraphMaintenanceHooks,
  ],
  exports: [
    DATABASE,
    SqliteTransaction,
    UserRepository,
    SessionRepository,
    InvitationCodeRepository,
    RegistrationDeviceRepository,
    GraphMaintenanceHooks,
  ],
})
export class DatabaseModule {}
