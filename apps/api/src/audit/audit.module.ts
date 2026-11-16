/**
 * 审计模块（@Global）：向全体业务模块提供统一 AuditService，避免每个模块重复 import。
 * 与 DatabaseModule（亦为 Global，导出 DATABASE 连接）配合，审计写入复用同一连接，
 * 从而在业务事务块内实现「业务写入 + 成功审计」同事务原子提交。
 */
import { Module, Global } from '@nestjs/common';
import { AuditRepository, SqliteAuditRepository } from './audit.repositories';
import { AuditPresenter } from './audit.presentation';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

@Global()
@Module({
  controllers: [AuditController],
  providers: [
    { provide: AuditRepository, useClass: SqliteAuditRepository },
    AuditPresenter,
    AuditService,
  ],
  exports: [AuditService],
})
export class AuditModule {}
