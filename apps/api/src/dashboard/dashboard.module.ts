/**
 * 数据大盘模块：只读统计接口 + 统计仓储实现（SQLite）。
 * 仓储以抽象类作为 DI Token，后续切换 PostgreSQL 时替换 useClass 即可。
 */
import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DashboardRepository, SqliteDashboardRepository } from './dashboard.repositories';

@Module({
  controllers: [DashboardController],
  providers: [
    DashboardService,
    { provide: DashboardRepository, useClass: SqliteDashboardRepository },
  ],
  exports: [DashboardService],
})
export class DashboardModule {}
