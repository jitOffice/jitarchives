#!/usr/bin/env node
/**
 * JitArchives 阶段一 · JitWord 接入验证服务（零依赖，Node.js >= 18）
 *
 * 只做四件事：
 *   1. 首次启动时用 clientSecret 创建一份带“仅测试”标识的专属文档，docId 落盘到 runtime/state.json，重启复用；
 *   2. 提供 POST /api/ticket：按测试身份（editor / viewer）现签一次性票据，clientSecret 永不离开本进程；
 *   3. 提供导出落地接口 POST /api/artifacts/export，把浏览器拿到的 docx 字节存到 runtime/exports 便于核对；
 *   4. 托管 public/ 下的验证页面。
 *
 * 监听地址固定 127.0.0.1（仅本机可访问）。
 */
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import {
  loadConfig, publicConfig, leaksSecret, ROOT_DIR, PUBLIC_DIR, RUNTIME_DIR, STATE_FILE, EXPORT_DIR,
} from './lib/config.mjs';
import { createJitWordClient, identityProfile, IDENTITY_NAMES, DEFAULT_TEST_SUBJECT } from './lib/jitword.mjs';
import { buildSampleDocx, extractDocxText } from './lib/docx.mjs';

const DOC_NAME_PREFIX = '【仅测试】JitArchives 阶段一 JitWord 接入验证文档';
// “验证只读权限”必须打在专属探测文档上：即使只读身份意外写入成功，也只会影响这份探测文档，
// 不会覆盖验证主文档的正文（见 docs/阶段一接入验证报告.md 第 12 节）。
const PROBE_DOC_NAME = 'ONLY-TEST_JitArchives_Stage1_Readonly_Probe';
const PROBE_MARKER = 'PROBE-READONLY-JITARCHIVES-20261026';
// 演示环境只有文档创建者能换到该文档的票据（无 ACL 授权接口），
// 因此“编辑/只读”两个测试身份共用同一个 externalSubject，权限差异全部由票据 role/scopes/readonly 决定。
const TEST_SUBJECT = DEFAULT_TEST_SUBJECT;
const DOC_NOTE = '仅用于阶段一接入验证，不含业务数据；演示环境不承诺可用性与备份';
const SAMPLE_MARKER = 'IMPORT-SAMPLE-JITARCHIVES-20261026';
const LISTEN_HOST = '127.0.0.1';
const MAX_BODY = 80 * 1024 * 1024;

const config = await loadConfig().catch((error) => {
  console.error(`[启动失败] ${error.message}`);
  process.exit(1);
});
const jitword = createJitWordClient(config);

let state = null;

function log(message) {
  // 兜底：任何日志都不得包含密钥
  const safe = leaksSecret(message, config.clientSecret) ? '[已拦截：日志含密钥]' : message;
  console.log(safe);
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return parsed?.docId ? parsed : null;
  } catch {
    return null;
  }
}

async function saveState(next) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** 专属探测文档：只服务于“验证只读权限”，与验证主文档完全隔离，创建失败不影响主流程 */
async function ensureProbeDocument(next) {
  if (next.probeDocId) return;
  try {
    const created = await jitword.createDocument({ name: PROBE_DOC_NAME, externalSubject: TEST_SUBJECT });
    next.probeDocId = created.docId;
    next.probeDocName = created.name || PROBE_DOC_NAME;
    next.probeDocCreatedAt = new Date().toISOString();
    delete next.probeError;
    log(`[探测文档] 已创建 docId=${next.probeDocId}（仅用于“验证只读权限”，与验证主文档隔离）`);
  } catch (error) {
    delete next.probeDocId;
    next.probeError = error.message;
    log(`[探测文档] 创建失败：${error.message}；页面上“验证只读权限”会直接判为验证失败（不会退回使用验证主文档）`);
  }
}

/** 取或建专属测试文档：配置里给了 docId 就直接用，否则复用 state.json，最后才创建新文档 */
async function ensureDocument() {
  const cached = await readState();
  let next;

  if (config.docId) {
    next = {
      docId: config.docId,
      docName: cached?.docName || `${DOC_NAME_PREFIX}（配置指定）`,
      docIdSource: 'config.docId / JITWORD_DOC_ID',
      subject: cached?.subject || TEST_SUBJECT,
      tenantKey: config.tenantKey,
      providerKey: config.providerKey,
      createdAt: cached?.createdAt || new Date().toISOString(),
      note: DOC_NOTE,
    };
  } else if (cached?.docId) {
    next = { ...cached, subject: cached.subject || TEST_SUBJECT };
  } else {
    const created = await jitword.createDocument({
      name: `${DOC_NAME_PREFIX} · ${new Date().toISOString().slice(0, 10)}`,
      externalSubject: TEST_SUBJECT,
    });
    next = {
      docId: created.docId,
      docName: created.name || `${DOC_NAME_PREFIX}`,
      docIdSource: '首次启动时由 POST /embed/documents 创建',
      subject: TEST_SUBJECT,
      tenantKey: config.tenantKey,
      providerKey: config.providerKey,
      createdAt: new Date().toISOString(),
      note: DOC_NOTE,
    };
  }

  if (cached?.previousDocId) next.previousDocId = cached.previousDocId;
  if (cached?.probeDocId) {
    next.probeDocId = cached.probeDocId;
    next.probeDocName = cached.probeDocName;
    next.probeDocCreatedAt = cached.probeDocCreatedAt;
  }

  await ensureProbeDocument(next);
  await saveState(next);
  return next;
}

/** 票据签发时声明的 origin 必须与浏览器地址栏一致：直接取自页面请求的 Host（仅接受回环地址） */
function resolveOrigin(req) {
  if (config.origin) return config.origin;
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    const error = new Error('只接受本机回环地址访问');
    error.status = 403;
    throw error;
  }
  return `http://${host}`;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  if (leaksSecret(text, config.clientSecret)) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: '响应体包含敏感字段，已拦截' }));
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJsonBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求体过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || LISTEN_HOST}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      sendJson(res, 200, publicConfig(config, {
        docId: state.docId,
        docName: state.docName,
        testOnly: true,
        identityNotice: '测试身份切换仅用于接入验证，尚未接入正式业务登录与权限体系',
        storage: '文档正文保存在 JitWord 服务端，本地只保存 docId 映射',
        // “验证只读权限”专用：专属探测文档与内置测试 DOCX
        probeDocId: state.probeDocId || null,
        probeDocName: state.probeDocName || null,
        probeMarker: PROBE_MARKER,
        probeAvailable: Boolean(state.probeDocId),
        probeNotice: '“验证只读权限”只在专属探测文档上执行，不会写入验证主文档',
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        node: process.version,
        docId: state.docId,
        docName: state.docName,
        docIdSource: state.docIdSource,
        probeDocId: state.probeDocId || null,
        probeDocName: state.probeDocName || null,
        probeDocCreatedAt: state.probeDocCreatedAt || null,
        probeError: state.probeError || null,
        testSubject: state.subject,
        createdAt: state.createdAt,
        stateFile: path.relative(ROOT_DIR, STATE_FILE),
        jitwordApi: config.api,
        editorUrl: config.editorUrl,
        sdkChannel: 'v1（官方稳定通道）',
        originPolicy: config.origin || '取自请求 Host（与浏览器地址栏一致）',
        configSource: config.configSource,
        clientSecret: '服务端已加载（不对外输出）',
        storage: 'JitWord 服务端（演示环境无备份承诺）',
        identities: IDENTITY_NAMES,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ticket') {
      const body = await readJsonBody(req);
      const identity = String(body.identity || 'editor');
      if (!IDENTITY_NAMES.includes(identity)) {
        sendJson(res, 400, { error: `identity 只能是 ${IDENTITY_NAMES.join(' / ')}` });
        return;
      }
      // target=probe 用于“验证只读权限”：只打在专属探测文档上，避免误写验证主文档
      const target = String(body.target || 'main');
      if (!['main', 'probe'].includes(target)) {
        sendJson(res, 400, { error: 'target 只能是 main / probe' });
        return;
      }
      const targetDocId = target === 'probe' ? state.probeDocId : state.docId;
      if (!targetDocId) {
        sendJson(res, 404, { error: `没有可用的${target === 'probe' ? '专属探测' : '验证主'}文档（${target === 'probe' ? 'probeDocId' : 'docId'} 为空）` });
        return;
      }
      const origin = resolveOrigin(req);
      // 每次请求现签一张票，不做任何缓存（官方文档第 08 节第二条）
      const ticket = await jitword.createTicket({
        docId: targetDocId, origin, identity, externalSubject: state.subject,
      });
      log(`[换票] target=${target} identity=${identity} role=${ticket.requestedRole} origin=${origin} expiresIn=${ticket.expiresIn} docId=${targetDocId}`);
      sendJson(res, 200, {
        ticket: ticket.ticket,
        expiresAt: ticket.expiresAt,
        expiresIn: ticket.expiresIn,
        target,
        docId: ticket.docId || targetDocId,
        origin: ticket.origin || origin,
        identity,
        scopes: ticket.scopes,
        requestedScopes: ticket.requestedScopes,
        ui: ticket.ui,
        issuedAt: new Date().toISOString(),
        cached: false,
      });
      return;
    }

    // “验证只读权限”专用：完整有效的内置测试 DOCX（零依赖生成，7 个 OOXML 部件）
    if (req.method === 'GET' && url.pathname === '/api/probe-docx') {
      const docx = buildSampleDocx({
        marker: PROBE_MARKER,
        paragraphs: [
          '一、本文件是“验证只读权限”专用测试 DOCX，只导入到专属探测文档。',
          '二、只读身份下导入应被权限拒绝；无论结果如何都不会影响验证主文档。',
        ],
      });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="jitarchives-permission-probe.docx"',
        'Content-Length': docx.length,
        'Cache-Control': 'no-store',
      });
      res.end(docx);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sample-import-docx') {
      const marker = String(url.searchParams.get('marker') || SAMPLE_MARKER);
      const docx = buildSampleDocx({
        marker,
        paragraphs: [
          '一、导入能力验证：正文应在本段之后正确显示。',
          '二、本文件由验证服务用零依赖方式生成，文件名与内容均不含业务信息。',
        ],
      });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="jitarchives-import-sample.docx"`,
        'Content-Length': docx.length,
        'Cache-Control': 'no-store',
      });
      res.end(docx);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/artifacts/export') {
      const body = await readJsonBody(req);
      const raw = String(body.base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) {
        sendJson(res, 400, { error: '缺少 base64 内容' });
        return;
      }
      const buffer = Buffer.from(raw, 'base64');
      if (!buffer.length || buffer.readUInt32LE(0) !== 0x04034b50) {
        sendJson(res, 400, { error: '收到的内容不是 zip/docx（缺少 PK 头）' });
        return;
      }
      await mkdir(EXPORT_DIR, { recursive: true });
      const safeName = String(body.fileName || 'jitword-export.docx').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      const file = path.join(EXPORT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName}`);
      await writeFile(file, buffer);

      let inspection = null;
      let inspectionError = null;
      try {
        const extracted = extractDocxText(buffer);
        const expect = String(body.expect || '');
        inspection = {
          parts: extracted.files.length,
          partsSample: extracted.files.slice(0, 12),
          paragraphCount: extracted.paragraphs.length,
          containsExpect: expect ? extracted.text.includes(expect) : null,
          textPreview: extracted.text.slice(0, 1200),
        };
      } catch (error) {
        inspectionError = error.message;
      }

      sendJson(res, 200, {
        file: path.relative(ROOT_DIR, file),
        absolutePath: file,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        inspection,
        inspectionError,
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    log(`[错误] ${error.message}`);
    const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
    sendJson(res, status, { error: error.message });
  }
});

/** 端口占用时顺延，避开 Windows 保留端口段 */
async function bind(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, LISTEN_HOST);
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`端口 ${startPort} 起连续 50 个端口均不可用`);
}

let port;
try {
  log(`[配置] 来源 ${config.configSource}；接口 ${config.api}；租户 ${config.tenantKey}/${config.providerKey}；密钥已加载（不打印）`);
  state = await ensureDocument();
  log(`[文档] docId=${state.docId} 来源=${state.docIdSource}`);
  port = await bind(config.port);
} catch (error) {
  console.error(`[启动失败] ${error.message}`);
  process.exit(1);
}

const origin = config.origin || `http://${LISTEN_HOST}:${port}`;
log('');
log(`JitArchives 阶段一 · JitWord 接入验证服务已启动（Node ${process.version}）`);
log(`  页面（编辑身份）  http://${LISTEN_HOST}:${port}/?identity=editor`);
log(`  页面（只读身份）  http://${LISTEN_HOST}:${port}/?identity=viewer`);
log(`  换票接口          POST http://${LISTEN_HOST}:${port}/api/ticket  {"identity":"editor|viewer"}`);
log(`  测试文档          ${state.docName}`);
log(`  探测文档          ${state.probeDocId ? `${state.probeDocName}（docId=${state.probeDocId}，仅用于“验证只读权限”）` : `不可用：${state.probeError || '未创建'}`}`);
log(`  票据 origin       ${origin}${config.origin ? '（来自配置）' : '（取自请求 Host，须与浏览器地址栏一致）'}`);
log('  安全提示          clientSecret 仅在本进程内存；票据每次现签不缓存；服务仅监听 ' + LISTEN_HOST);
log('');
