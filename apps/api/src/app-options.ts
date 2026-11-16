/**
 * 运行时可覆盖的应用选项（由 bootstrap / 测试注入，DI Provider 初始化时读取）。
 * 默认值来自 config.ts。
 */
import * as config from './config';
import type { JitWordClient } from './jitword/jitword.client';
import type { AiModelClient } from './agent/ai-model.client';
import type { EmbeddingClient } from './knowledge/embedding.client';

export interface AppOptions {
  /** SQLite 数据库文件路径。 */
  dbFile: string;
  /** 是否托管前端构建产物（测试时关闭）。 */
  serveWeb: boolean;
  /** 档案附件受控存储目录（测试时指向独立隔离目录）。 */
  fileStoreDir: string;
  /**
   * JitWord 客户端覆盖：测试注入桩实现以避免真实触网；
   * 为 undefined 时由 JitWordModule 按配置构建真实客户端（未配置密钥则不可用）。
   */
  jitwordClient?: JitWordClient | null;
  /**
   * AI 模型客户端覆盖：测试注入桩实现以避免真实触网；
   * 为 undefined 时由 AgentModule 按环境变量构建真实客户端（未配置即不可用，不伪造 AI 回复）。
   */
  aiModelClient?: AiModelClient | null;
  embeddingClient?: EmbeddingClient | null;
  knowledgeWorker?: boolean;
}

export const appOptions: AppOptions = {
  dbFile: config.DB_FILE,
  serveWeb: true,
  fileStoreDir: config.FILE_STORE_DIR,
  jitwordClient: null,
  aiModelClient: null,
};
