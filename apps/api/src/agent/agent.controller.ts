/**
 * 档案 Agent 助理接口
 * （第一阶段：对话式检索；第二阶段：附件全文检索与内容问答；第三阶段：智能业务办理）。
 * 路由与守卫沿用既有风格：SessionGuard（未登录 401）+ PermissionGuard（角色矩阵默认拒绝）。
 * 会话归属一律以服务端已校验会话用户为准：所有读写都带 user_id 条件，越权访问返回「会话不存在」。
 * 第三阶段新增 POST /api/agent/action：只接受「确认 / 取消 + 可编辑字段值」，凭 token 定位服务端草稿；
 * 审批/归档/删除等高风险操作仍不代理执行，工具内部仍会逐次跑后端权限校验。
 */
import { Body, BadRequestException, Controller, Delete, Get, HttpException, Inject, NotFoundException, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, PermissionGuard, Perm, SessionGuard } from '../auth/guards';
import { UserView } from '../common/roles';
import { AgentMessageView, AgentService, AgentAskResult, AgentConversationView } from './agent.service';
import { AI_MODEL_CLIENT, AiModelClient } from './ai-model.client';
import { PersonalAiSettingsService, SaveAiProviderInput, TestAiProviderInput } from './ai-settings.service';
import { ContentIndexRepository } from '../archives/content/content-index.repositories';
import { AgentProgressService } from './agent.progress';
import { isAgentCancelled } from './agent.cancellation';
import type { AgentTraceStep } from './agent.trace';

/** 状态视图：前端据此如实标注「模型服务是否已配置」，不展示密钥或地址细节以外的信息。 */
export interface AgentStatusView {
  aiConfigured: boolean;
  model: string | null;
  provider: string | null;
  providerLabel: string | null;
  personalAiConfigured: boolean;
  /** 模型服务在本进程是否真的可调用（桩实现/未配置时为 false）。 */
  aiAvailable: boolean;
  /** 档案检索接口是否可用（Agent 的检索始终复用既有档案服务）。 */
  archiveSearchReady: true;
  /** 附件正文索引是否可用（不可用时内容问答会如实降级，不会伪装成 AI 回答）。 */
  contentIndexReady: boolean;
  /** 全文检索是否走 SQLite FTS5；false 表示当前构建未启用 FTS5，已降级为 LIKE 匹配。 */
  contentFts: boolean;
  /** 能力边界说明（前端欢迎区与提示复用，避免把未实现能力展示为已开放）。 */
  capabilities: {
    conversationSearch: boolean;
    archiveDetailLink: boolean;
    attachmentContentQa: boolean;
    /** 第三阶段：智能借阅申请（需用户确认后提交）。 */
    borrowApply: boolean;
    /** 第三阶段：借阅进度查询（按现有角色权限隔离）。 */
    borrowProgress: boolean;
    /** 第三阶段：智能辅助著录（预览 + 确认后写入）。 */
    catalogAssist: boolean;
    /** 第一批：全系统统一智能检索（跨档案/附件/正文/分类联合查询）。 */
    unifiedSearch: boolean;
    ocr: boolean;
    /** AI 自动审批永久关闭（审批仍由审核员/管理员在现有页面完成）。 */
    autoApproval: boolean;
    /** AI 自动归档/删除永久关闭。 */
    autoArchive: boolean;
  };
}

@UseGuards(SessionGuard, PermissionGuard)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly service: AgentService,
    @Inject(AI_MODEL_CLIENT) private readonly model: AiModelClient,
    @Inject(ContentIndexRepository) private readonly contentIndex: ContentIndexRepository,
    private readonly personalAiSettings: PersonalAiSettingsService,
    private readonly progress: AgentProgressService,
  ) {}

  @Get('status')
  @Perm('archiveView')
  status(@CurrentUser() operator: UserView): AgentStatusView {
    const personal = this.personalAiSettings.activeModelInfo(operator.id);
    const model = this.personalAiSettings.clientForUser(operator.id, this.model);
    return {
      aiConfigured: model.available,
      model: personal.model ?? model.model,
      provider: personal.provider,
      providerLabel: personal.providerLabel ?? (model.available ? '系统默认模型' : null),
      personalAiConfigured: personal.configured,
      aiAvailable: model.available,
      archiveSearchReady: true,
      contentIndexReady: true,
      contentFts: this.contentIndex.ftsAvailable(),
      capabilities: {
        conversationSearch: true,
        archiveDetailLink: true,
        // 第二阶段：已打通「附件正文提取 → 权限过滤检索 → 基于证据回答 + 真实来源」
        // 仅限 DOCX / PDF / TXT；扫描件与不支持的格式会如实返回取证失败原因。
        attachmentContentQa: true,
        // 第三阶段：借阅申请 / 借阅进度 / 辅助著录均需用户确认，且每次调用重跑后端权限校验
        borrowApply: true,
        borrowProgress: true,
        catalogAssist: true,
        // 第一批：统一检索已接入对话入口，仅返回当前用户有权访问的档案与附件
        unifiedSearch: true,
        ocr: false,
        // 高风险操作不由 AI 执行：审批与归档/删除一律保持 false
        autoApproval: false,
        autoArchive: false,
      },
    };
  }

  /** 个人 AI 配置：所有可进入 Agent 的登录角色都可读取自己的配置。 */
  @Get('ai-settings')
  @Perm('archiveView')
  aiSettings(@CurrentUser() operator: UserView) {
    return this.personalAiSettings.getSettings(operator.id);
  }

  /** 保存当前账号某个服务商的配置；enable=true 时同时切换为当前模型。 */
  @Put('ai-settings/:provider')
  @Perm('archiveView')
  saveAiProvider(
    @Param('provider') provider: string,
    @Body() body: SaveAiProviderInput,
    @CurrentUser() operator: UserView,
  ) {
    return this.personalAiSettings.saveProvider(operator.id, provider, body ?? {});
  }

  /** 连接测试使用临时配置，不保存 API Key，也不发送任何档案内容。 */
  @Post('ai-settings/:provider/test')
  @Perm('archiveView')
  testAiProvider(
    @Param('provider') provider: string,
    @Body() body: TestAiProviderInput,
    @CurrentUser() operator: UserView,
  ) {
    return this.personalAiSettings.testConnection(operator.id, provider, body ?? {});
  }

  @Post('ai-settings/:provider/activate')
  @Perm('archiveView')
  activateAiProvider(@Param('provider') provider: string, @CurrentUser() operator: UserView) {
    return this.personalAiSettings.activateProvider(operator.id, provider);
  }

  @Post('ai-settings/disable')
  @Perm('archiveView')
  disableAiProvider(@CurrentUser() operator: UserView) {
    return this.personalAiSettings.disable(operator.id);
  }

  @Delete('ai-settings/:provider')
  @Perm('archiveView')
  removeAiProvider(@Param('provider') provider: string, @CurrentUser() operator: UserView) {
    return this.personalAiSettings.removeProvider(operator.id, provider);
  }

  /** 会话列表：仅返回当前用户自己的会话。 */
  @Get('conversations')
  @Perm('archiveView')
  listConversations(@CurrentUser() operator: UserView): { items: AgentConversationView[] } {
    return { items: this.service.listConversations(operator) };
  }

  @Post('conversations')
  @Perm('archiveView')
  createConversation(@CurrentUser() operator: UserView): AgentConversationView {
    return this.service.createConversation(operator);
  }

  /** 指定会话的历史消息（含结构化载荷，前端据此恢复档案卡片）。 */
  @Get('conversations/:id')
  @Perm('archiveView')
  conversation(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operator: UserView,
  ): { conversation: AgentConversationView; messages: AgentMessageView[] } {
    return this.service.getConversation(id, operator);
  }

  /** 授权诊断接口：仅审计/管理角色可读原始诊断，普通聊天接口不返回这些内容。 */
  @Get('conversations/:id/diagnostics')
  @Perm('auditView')
  diagnostics(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operator: UserView,
  ) {
    return this.service.diagnostics(id, operator);
  }

  @Delete('conversations/:id')
  @Perm('archiveView')
  deleteConversation(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operator: UserView,
  ): { ok: true } {
    return this.service.deleteConversation(id, operator);
  }

  /**
   * 发送消息并获取 Agent 回复。
   * conversationId 为空时自动为当前用户新建会话（前端「新建对话」后可直接提问）。
   * clientRequestId 为幂等键：同会话内重复提交返回既有回复，不产生重复消息。
   * 第三阶段：context 只允许携带图谱页面选中节点/关系的提示（类型 + ID），服务层一律后端重新验证
   * 真实性与访问权限后才进入会话槽位；客户端传入的档案列表/正文/权限字段—律拒绝（fail-closed）。
   */
  @Post('ask')
  @Perm('archiveView')
  async ask(
    @Body() body: { conversationId?: number | string; question?: string; clientRequestId?: string; context?: unknown },
    @CurrentUser() operator: UserView,
  ): Promise<AgentAskResult & { conversationId: number }> {
    const asked = body?.conversationId;
    // 未传或非法会话 id：为当前用户新建会话；传了但不属于当前用户：服务层一律 404
    const targetId = this.resolveConversationId(asked) ?? this.service.createConversation(operator).id;
    const requestId = this.resolveProgressRequestId(body?.clientRequestId);
    if (requestId) this.progress.start(operator.id, requestId);
    try {
      const result = await this.service.ask(targetId, body ?? {}, operator,
        requestId ? (steps) => this.progress.update(operator.id, requestId, steps) : undefined,
        requestId ? this.progress.signal(operator.id, requestId) : undefined);
      if (requestId) {
        if (result.cancelled) this.progress.fail(operator.id, requestId);
        else this.progress.complete(operator.id, requestId);
      }
      return { ...result, conversationId: targetId };
    } catch (error) {
      if (requestId) this.progress.fail(operator.id, requestId);
      if (isAgentCancelled(error)) throw new HttpException('已终止本次回答', 499);
      throw error;
    }
  }

  /** 用户点击「停止生成」：只中止当前用户自己的这次请求，不删除会话与历史消息。 */
  @Post('cancel')
  @Perm('archiveView')
  cancel(
    @Body() body: { clientRequestId?: string },
    @CurrentUser() operator: UserView,
  ): { ok: true } {
    const requestId = this.resolveProgressRequestId(body?.clientRequestId);
    if (requestId) this.progress.cancel(operator.id, requestId);
    return { ok: true };
  }

  /** 当前用户本次提问的简化进度；不返回内部工具、检索计划、诊断或证据细节。 */
  @Get('progress/:requestId')
  @Perm('archiveView')
  progressView(@Param('requestId') rawRequestId: string, @CurrentUser() operator: UserView) {
    const requestId = this.resolveProgressRequestId(rawRequestId);
    if (!requestId) throw new NotFoundException('查询进度不存在');
    const progress = this.progress.get(operator.id, requestId);
    if (!progress) throw new NotFoundException('查询进度不存在');
    return progress;
  }

  /**
   * 重新生成最后一条回复：不追加新的用户消息，原地替换该条回复。
   * 只接受当前会话的最后一条 assistant 消息，历史回复不可改写。
   */
  @Post('regenerate')
  @Perm('archiveView')
  async regenerate(
    @Body() body: { conversationId?: number | string; messageId?: number | string; clientRequestId?: string },
    @CurrentUser() operator: UserView,
  ): Promise<{ conversation: AgentConversationView; reply: AgentMessageView }> {
    const targetId = this.resolveConversationId(body?.conversationId);
    if (!targetId) throw new BadRequestException('会话参数不合法');
    const messageId = Number(body?.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new BadRequestException('消息参数不合法');
    }
    const requestId = this.resolveProgressRequestId(body?.clientRequestId);
    if (requestId) this.progress.start(operator.id, requestId);
    try {
      const result = await this.service.regenerate(targetId, messageId, operator,
        requestId ? (steps) => this.progress.update(operator.id, requestId, steps) : undefined,
        requestId ? this.progress.signal(operator.id, requestId) : undefined);
      if (requestId) this.progress.complete(operator.id, requestId);
      return result;
    } catch (error) {
      if (requestId) this.progress.fail(operator.id, requestId);
      if (isAgentCancelled(error)) throw new HttpException('已终止本次回答', 499);
      throw error;
    }
  }

  /** 进度请求标识只接受短字符集，且进度查询始终绑定当前登录用户。 */
  private resolveProgressRequestId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    return value.length <= 64 && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
  }

  /** 会话 id 解析：只接受正整数，其他一律视为未提供（不信任客户端拼接）。 */
  private resolveConversationId(raw: unknown): number | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  /**
   * 确认提交 / 取消待执行业务草稿。
   * 入参只有 token + 动作 + 用户可改字段：档案 ID、分类 ID、申请内容全部取自服务端保存的草稿，
   * 绝不信任大模型或前端回传的业务参数；重复确认不会重复提交（服务层条件抢占 + 回显既有结果）。
   */
  @Post('action')
  @Perm('archiveView')
  act(
    @Body() body: { conversationId?: number | string; token?: string; action?: string; values?: Record<string, string> },
    @CurrentUser() operator: UserView,
  ): { conversation: AgentConversationView; reply: AgentMessageView } {
    const targetId = this.resolveConversationId(body?.conversationId);
    if (!targetId) throw new BadRequestException('会话参数不合法');
    return this.service.act(targetId, body ?? {}, operator);
  }
}
