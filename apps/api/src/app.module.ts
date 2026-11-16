/**
 * 模块装配：
 * - DatabaseModule（全局）：SQLite 连接与仓储实现；
 * - AuthModule：登录/会话；
 * - UsersModule：用户管理（依赖 AuthService 的校验逻辑）；
 * - ArchivesModule：档案分类/著录/附件/检索（阶段二第二批）；
 * - SystemModule：系统信息；
 * - DashboardModule：工作台数据大盘（只读统计）。
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ArchivesModule } from './archives/archives.module';
import { JitWordModule } from './jitword/jitword.module';
import { SystemModule } from './system/system.module';
import { AuditModule } from './audit/audit.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { AgentModule } from './agent/agent.module';
import { GraphModule } from './graph/graph.module';

@Module({
  imports: [DatabaseModule, AuthModule, UsersModule, ArchivesModule, JitWordModule, SystemModule, AuditModule, DashboardModule, HealthModule, AgentModule, GraphModule],
})
export class AppModule {}
