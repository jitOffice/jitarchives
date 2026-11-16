/**
 * 知识图谱模块（第一阶段底层建设 + 第二阶段查询 API）。
 *
 * 依赖方向：GraphModule → ArchivesModule（读取档案 / 附件 / 正文索引，并驱动既有索引流水线）。
 * 反向通知（正文索引完成后刷新图谱）通过全局的 GraphMaintenanceHooks 委托完成，
 * 因此两个模块之间不存在 Nest 循环依赖，ArchivesModule 在图谱未启用时行为完全不变。
 *
 * 第二阶段新增只读查询链路（仓储 / 服务 / controller），与第一阶段的写入链路共用同一套表
 * 与 ArchivesModule 导出的权限服务、统一检索服务，不新建任何存储或检索实现。
 */
import { Module } from '@nestjs/common';
import { ArchivesModule } from '../archives/archives.module';
import { GraphRepository, SqliteGraphRepository } from './graph.repositories';
import { GraphBuildService } from './graph.service';
import { GraphQueryRepository, SqliteGraphQueryRepository } from './graph.query.repositories';
import { GraphQueryService } from './graph.query.service';
import { KnowledgeGraphController } from './graph.controller';

@Module({
  imports: [ArchivesModule],
  controllers: [KnowledgeGraphController],
  providers: [
    { provide: GraphRepository, useClass: SqliteGraphRepository },
    GraphBuildService,
    { provide: GraphQueryRepository, useClass: SqliteGraphQueryRepository },
    GraphQueryService,
  ],
  exports: [GraphRepository, GraphBuildService, GraphQueryRepository, GraphQueryService],
})
export class GraphModule {}
