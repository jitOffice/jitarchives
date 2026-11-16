/**
 * 档案 Agent 助理模块
 * （第一阶段：对话式查档；第二阶段：附件全文检索与内容问答；第三阶段：智能档案业务办理）。
 * 复用 ArchivesModule 导出的检索/访问控制/正文索引/借阅/模板能力；个人 AI 配置仅提供按用户隔离的模型适配，不改变业务权限链路；
 * 第三阶段的受控工具（AgentToolService）只是现有业务的薄封装，确认草稿走 AgentPendingActionRepository。
 * 模型客户端以 AI_MODEL_CLIENT Token 绑定，测试可通过 appOptions.aiModelClient 注入桩实现（不触网）。
 */
import { Module } from '@nestjs/common';
import { ArchivesModule } from '../archives/archives.module';
import { AuditModule } from '../audit/audit.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { GraphModule } from '../graph/graph.module';
import { AgentRepository, SqliteAgentRepository } from './agent.repositories';
import { AgentPendingActionRepository, SqliteAgentPendingActionRepository } from './agent.pending';
import { AgentToolService } from './agent.tools';
import { AgentToolRegistry } from './tool.registry';
import { AgentToolDispatcher } from './tool.dispatcher';
import { AgentContextService } from './agent.context';
import { AgentService } from './agent.service';
import { AgentRetrievalService } from './retrieval.service';
import { AgentController } from './agent.controller';
import { AgentProgressService } from './agent.progress';
import { AgentUnifiedBusinessSearchService } from './unified-business-search.service';
import { AI_MODEL_CLIENT, AiModelClient, RealAiModelClient } from './ai-model.client';
import { PersonalAiSettingsService } from './ai-settings.service';
import { appOptions } from '../app-options';
import { KnowledgeController } from '../knowledge/knowledge.controller';

/**
 * 模型客户端工厂：测试注入 appOptions.aiModelClient（桩，不触网）；
 * 否则构造读取环境变量的真实客户端（未配置即 available=false，走确定性规则，不伪造 AI 回复）。
 * 在 DI 初始化时求值（bootstrap 已写入 appOptions），而非模块 import 时。
 */
function buildAiModelClient(): AiModelClient {
  if (appOptions.aiModelClient !== null && appOptions.aiModelClient !== undefined) {
    return appOptions.aiModelClient;
  }
  return new RealAiModelClient();
}

@Module({
  // 第三阶段：GraphModule 只提供第二阶段已有的只读图谱查询服务（自身已按权限过滤），依赖方向 Agent→Graph→Archives，无循环依赖。
  imports: [ArchivesModule, AuditModule, DashboardModule, GraphModule],
  controllers: [AgentController, KnowledgeController],
  providers: [
    AgentService,
    AgentProgressService,
    AgentRetrievalService,
    AgentContextService,
    AgentToolRegistry,
    AgentToolDispatcher,
    AgentUnifiedBusinessSearchService,
    PersonalAiSettingsService,
    // 第三阶段：受控工具与待确认草稿仓储（不引入任何新的业务系统）
    AgentToolService,
    { provide: AgentRepository, useClass: SqliteAgentRepository },
    { provide: AgentPendingActionRepository, useClass: SqliteAgentPendingActionRepository },
    { provide: AI_MODEL_CLIENT, useFactory: buildAiModelClient },
  ],
})
export class AgentModule {}
