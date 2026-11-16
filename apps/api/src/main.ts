/**
 * 正式系统入口：
 * - API 统一挂载在 /api 前缀；
 * - 若前端已构建（apps/web/dist 存在），同端口托管正式系统页面（含 SPA 回退）；
 * - 端口默认 5006，与阶段一接入验证页（3000）明确区分。
 */
import 'reflect-metadata';
import * as os from 'os';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { appOptions } from './app-options';
import { HOST, PORT, WEB_DIST, LEGACY_DEMO_URL, SESSION_COOKIE } from './config';
import { extraAllowedOrigins, isStrictOriginMode } from './jitword/jitword.config';
import type { JitWordClient } from './jitword/jitword.client';
import type { AiModelClient } from './agent/ai-model.client';
import type { EmbeddingClient } from './knowledge/embedding.client';

/** 通配监听地址：表示接受任意网卡接入（局域网部署用）。 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/** 本机非回环 IPv4，仅用于打印局域网访问地址（不参与监听决策）。 */
function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item && item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

export interface BootstrapOptions {
  port?: number;
  host?: string;
  dbFile?: string;
  serveWeb?: boolean;
  /** 档案附件受控存储目录（测试时隔离）。 */
  fileStoreDir?: string;
  /** JitWord 客户端覆盖（测试注入桩实现，不触网）。 */
  jitwordClient?: JitWordClient | null;
  /** AI 模型客户端覆盖（测试注入桩实现，不触网）。 */
  aiModelClient?: AiModelClient | null;
  embeddingClient?: EmbeddingClient | null;
  knowledgeWorker?: boolean;
}

export interface BootstrapResult {
  app: NestExpressApplication;
  port: number;
  baseUrl: string;
}

/** 启动预检：目录存在（不存在则创建）且可写；否则抛出带用途的清晰错误。 */
function precheckWritable(dir: string, label: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.precheck-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    throw new Error(`启动预检失败：${label}不可写或无法创建（${dir}）：${(err as Error)?.message ?? err}`);
  }
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  if (options.dbFile) appOptions.dbFile = options.dbFile;
  if (options.fileStoreDir) appOptions.fileStoreDir = options.fileStoreDir;
  if (options.jitwordClient !== undefined) appOptions.jitwordClient = options.jitwordClient;
  if (options.aiModelClient !== undefined) appOptions.aiModelClient = options.aiModelClient;
  appOptions.embeddingClient = options.embeddingClient ?? null;
  appOptions.knowledgeWorker = options.knowledgeWorker ?? true;
  const serveWeb = options.serveWeb ?? appOptions.serveWeb;

  // 启动前预检：确保数据库目录与文件存储目录存在且可写，失败即给出清晰错误（不静默）。
  precheckWritable(path.dirname(path.resolve(appOptions.dbFile)), '数据库目录');
  precheckWritable(path.resolve(appOptions.fileStoreDir), '档案文件存储目录');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: true, credentials: true });

  const indexHtml = path.join(WEB_DIST, 'index.html');
  if (serveWeb && fs.existsSync(indexHtml)) {
    app.useStaticAssets(WEB_DIST);
    // SPA 回退：非 /api 的 GET 请求返回前端入口
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(indexHtml);
        return;
      }
      next();
    });
  }

  const port = options.port ?? PORT;
  const host = options.host ?? HOST;
  await app.listen(port, host);
  const actualPort = (app.getHttpServer().address() as { port: number }).port;
  // 通配监听时以回环地址作为默认地址，避免输出不可点击的 http://0.0.0.0。
  const displayHost = WILDCARD_HOSTS.has(host) ? '127.0.0.1' : host;
  return { app, port: actualPort, baseUrl: `http://${displayHost}:${actualPort}` };
}

function printBanner(baseUrl: string, webServed: boolean, lanHosts: string[] = []) {
  console.log('==================================================');
  console.log('  JitArchives 智能电子档案管理系统');
  console.log('--------------------------------------------------');
  console.log(`  [正式系统]   ${baseUrl}${webServed ? '  (页面 + API)' : '  (仅 API，前端未构建)'}`);
  console.log(`  [正式系统API] ${baseUrl}/api`);
  if (lanHosts.length) {
    const port = new URL(baseUrl).port;
    for (const ip of lanHosts) console.log(`  [局域网访问] http://${ip}:${port}`);
  }
  // 票据 origin 按访问地址自动解析，不再需要「统一用某个地址访问」的限制。
  console.log('  [JitWord票据origin] 随访问地址自动匹配（优先浏览器 Origin 头，兼容代理转发头）');
  if (isStrictOriginMode()) {
    console.log('  [JitWord来源白名单] 已启用严格模式（JITWORD_ORIGIN_STRICT=1）');
    console.log(`  [额外允许来源] ${extraAllowedOrigins().join(', ') || '(未配置，仅放行本机/私网)'}`);
  }
  console.log(`  [原接入验证页] ${LEGACY_DEMO_URL}  (jitword-integration，独立进程，需单独启动)`);
  console.log('--------------------------------------------------');
  console.log(`  会话 Cookie: ${SESSION_COOKIE} (HttpOnly)   数据库: ${appOptions.dbFile}`);
  console.log('==================================================');
}

async function main() {
  const result = await bootstrap();
  printBanner(
    result.baseUrl,
    fs.existsSync(path.join(WEB_DIST, 'index.html')),
    WILDCARD_HOSTS.has(HOST) ? lanIPv4Addresses() : [],
  );
}

// 仅在直接运行时启动（被测试 import 时不自动监听）
if (require.main === module) {
  main().catch((err) => {
    console.error('JitArchives 正式系统启动失败:', err);
    process.exit(1);
  });
}
