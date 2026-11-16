#!/usr/bin/env node
/**
 * 阶段一接入自检（可重复执行）：
 *   node tools/selfcheck.mjs [--base http://127.0.0.1:3000] [--skip-local]
 *
 * 覆盖“不依赖浏览器”的验证项；需要浏览器交互的项会输出「待人工/浏览器验证」。
 * 输出中不会打印 clientSecret 与完整票据，只打印长度、scopes 等元信息。
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import {
  loadConfig, leaksSecret, ROOT_DIR, PUBLIC_DIR, STATE_FILE, EXPORT_DIR, LOCAL_CONFIG_FILE,
} from '../lib/config.mjs';
import { createJitWordClient } from '../lib/jitword.mjs';
import { extractDocxText } from '../lib/docx.mjs';

const args = process.argv.slice(2);
const baseArgIndex = args.indexOf('--base');
const BASE = baseArgIndex >= 0 ? args[baseArgIndex + 1] : 'http://127.0.0.1:3000';
const SKIP_LOCAL = args.includes('--skip-local');

const results = [];
function record(id, name, status, evidence) {
  results.push({ id, name, status, evidence });
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log(`[${icon}] ${id} ${name}`);
  if (evidence) console.log(`       ${evidence}`);
}

async function step(id, name, fn) {
  try {
    const evidence = await fn();
    record(id, name, 'PASS', evidence);
  } catch (error) {
    record(id, name, 'FAIL', error.message);
  }
}

function httpGet(url, options = {}) {
  return fetch(url, { redirect: 'manual', ...options });
}

const config = await loadConfig().catch((error) => {
  console.error(`配置加载失败：${error.message}`);
  process.exit(2);
});
const secret = config.clientSecret;
const jitword = createJitWordClient(config);

console.log('== 阶段一 JitWord 接入自检 ==');
console.log(`Node ${process.version} / 配置来源 ${config.configSource} / 接口 ${config.api}`);
console.log('（不打印 clientSecret 与完整票据）\n');

/* ---------- 一、JitWord 服务端可达性与真实性 ---------- */

let manifest = null;
await step('J1', 'JitWord 服务与能力清单可达', async () => {
  manifest = await jitword.manifest();
  return `loaderVersion=${manifest.loaderVersion} protocol=${manifest.protocolVersion} authModes=${(manifest.authModes || []).join('/')} ticketTtl=${manifest.ticketTtlSeconds}s`;
});

await step('J2', 'iframe SDK loader.js 可访问且为 JavaScript', async () => {
  const res = await httpGet(config.loaderUrl);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!type.includes('javascript')) throw new Error(`Content-Type=${type}（应为 application/javascript）`);
  const version = body.match(/LOADER_VERSION\s*=\s*'([^']+)'/)?.[1] || '未解析到';
  const methods = [...body.matchAll(/EditorInstance\.prototype\.(\w+)\s*=/g)].map((m) => m[1]);
  const required = ['importDocx', 'exportDocx', 'getContent', 'save', 'setReadonly'];
  const missing = required.filter((name) => !methods.includes(name));
  if (missing.length) throw new Error(`loader 缺少方法：${missing.join(',')}`);
  return `HTTP ${res.status} ${type} loader=${version}（manifest 声明 ${manifest?.loaderVersion}）；prototype 方法 ${methods.length} 个，含 importDocx/exportDocx/getContent/save/setReadonly`;
});

await step('J3', '编辑器 SPA 路由可回落（iframe 白屏前置条件）', async () => {
  const res = await httpGet(`${config.editorUrl}/embed/document/probe`);
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || !type.includes('html')) throw new Error(`HTTP ${res.status} ${type}`);
  return `HTTP 200 ${type}`;
});

await step('J4', '管理后台与文档列表路径被服务端拦截', async () => {
  const apiRoot = config.api.replace(/\/api\/v1$/, '');
  const probes = ['/api/v1/admin/users', '/api/v1/documents', '/api/v1/parse/x'];
  const rows = [];
  for (const p of probes) {
    const res = await httpGet(`${apiRoot}${p}`);
    const body = await res.json().catch(() => ({}));
    rows.push(`${p}→${res.status}/${body.code ?? '?'}`);
    if (body.code !== 404) throw new Error(`${p} 未被拦截：HTTP ${res.status} ${JSON.stringify(body).slice(0, 80)}`);
  }
  return rows.join('  ');
});

await step('J4b', '注册/登录路径按文档说法应返回 404', async () => {
  const apiRoot = config.api.replace(/\/api\/v1$/, '');
  const res = await httpGet(`${apiRoot}/api/v1/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  if (body.code === 404) return `HTTP 404 Not Found（与官方文档一致）`;
  throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}；官方文档称该路径应被服务端拦截并返回 404，实测接口仍在线（未验证账号体系安全性，建议向服务商确认）`);
});

await step('J5', '不提供密钥时换票接口拒绝请求（反向验证）', async () => {
  const res = await jitword.createTicketWithoutSecret({
    tenantKey: config.tenantKey,
    providerKey: config.providerKey,
    externalSubject: 'stage1-no-secret',
    document: { docId: 'any' },
    permission: { scopes: ['document:read'] },
    origin: 'http://127.0.0.1:3000',
  });
  if (res.status !== 401) throw new Error(`期望 401，实际 HTTP ${res.status}：${res.payload?.message || ''}`);
  return `HTTP 401 ${res.payload?.message || ''}`;
});

let docId = '';
let subject = '';
await step('J6', '测试文档 docId 就绪且可换取一次性票据', async () => {
  const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  docId = state.docId;
  subject = state.subject || 'stage1-verification-user';
  if (!docId) throw new Error('runtime/state.json 里没有 docId');
  const ticket = await jitword.createTicket({ docId, origin: 'http://127.0.0.1:3000', identity: 'viewer', externalSubject: subject });
  return `docId=${docId} 文档名=${state.docName} 主体=${subject} 票据长度=${ticket.ticket.length} scopes=${(ticket.scopes || []).join(',')} 过期=${ticket.expiresAt}`;
});

await step('J7', '票据每次现签互不相同（未缓存复用）', async () => {
  const a = await jitword.createTicket({ docId, origin: 'http://127.0.0.1:3000', identity: 'editor', externalSubject: subject });
  const b = await jitword.createTicket({ docId, origin: 'http://127.0.0.1:3000', identity: 'editor', externalSubject: subject });
  if (a.ticket === b.ticket) throw new Error('两次换票返回了同一张票据');
  return `两次票据长度 ${a.ticket.length}/${b.ticket.length}，内容不同；有效期 ${a.expiresIn}s`;
});

await step('J8', '编辑/只读身份的权限由票据决定（scopes 差异）', async () => {
  const editor = await jitword.createTicket({ docId, origin: 'http://127.0.0.1:3000', identity: 'editor', externalSubject: subject });
  const viewer = await jitword.createTicket({ docId, origin: 'http://127.0.0.1:3000', identity: 'viewer', externalSubject: subject });
  const editorScopes = editor.scopes || [];
  const viewerScopes = viewer.scopes || [];
  if (!editorScopes.includes('document:edit')) throw new Error(`编辑票据缺少 document:edit：${editorScopes}`);
  if (viewerScopes.includes('document:edit')) throw new Error(`只读票据包含 document:edit：${viewerScopes}`);
  return `editor=[${editorScopes}] ui.readonly=${editor.ui?.readonly}；viewer=[${viewerScopes}] ui.readonly=${viewer.ui?.readonly}`;
});

await step('J9', '生效策略可读（授权域名与能力上限）', async () => {
  const res = await jitword.profile();
  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${res.message || ''}`);
  const data = res.data || {};
  const p = data.profile || {};
  return `allowedOrigins=${JSON.stringify(p.allowedOrigins ?? null)} capabilities=${JSON.stringify(data.capabilities ?? null)} features=${JSON.stringify(p.features ?? null).slice(0, 120)}`;
});

/* ---------- 二、本地验证服务 ---------- */

if (SKIP_LOCAL) {
  record('L0', '本地服务检查', 'SKIP', '按 --skip-local 跳过');
} else {
  let localAlive = false;
  await step('L1', '本地验证服务可达', async () => {
    const res = await httpGet(`${BASE}/api/status`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localAlive = true;
    return `docId=${data.docId} 配置=${data.configSource} 存储=${data.storage}`;
  });

  if (!localAlive) {
    record('L2..L6', '本地接口检查', 'SKIP', '本地服务未启动，先执行 node server.mjs');
  } else {
    await step('L2', '浏览器可见配置不含 clientSecret', async () => {
      const res = await httpGet(`${BASE}/api/config`);
      const text = await res.text();
      if (leaksSecret(text, secret)) throw new Error('响应包含 clientSecret');
      const data = JSON.parse(text);
      const keys = Object.keys(data).join(',');
      if (/secret/i.test(keys)) throw new Error(`响应字段疑似含密钥字段：${keys}`);
      return `字段：${keys}`;
    });

    await step('L3', '静态文件与接口响应不含 clientSecret', async () => {
      const targets = ['/', '/app.js', '/styles.css', '/api/status', '/api/config'];
      for (const target of targets) {
        const res = await httpGet(`${BASE}${target}`);
        const text = await res.text();
        if (leaksSecret(text, secret)) throw new Error(`${target} 响应包含 clientSecret`);
      }
      for (const file of await readdir(PUBLIC_DIR)) {
        const full = path.join(PUBLIC_DIR, file);
        if ((await stat(full)).isFile() && leaksSecret(await readFile(full, 'utf8'), secret)) {
          throw new Error(`public/${file} 文件本身包含 clientSecret`);
        }
      }
      return `已扫描 ${targets.length} 个响应 + public/ 下全部文件`;
    });

    await step('L4', '本地换票接口按身份签发且不缓存', async () => {
      const post = () => httpGet(`${BASE}/api/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: 'viewer' }),
      }).then((r) => r.json());
      const a = await post();
      const b = await post();
      if (!a.ticket || !b.ticket) throw new Error(`换票失败：${a.error || b.error || '无票据'}`);
      if (a.ticket === b.ticket) throw new Error('两次请求返回同一张票据');
      if (leaksSecret(JSON.stringify(a), secret)) throw new Error('换票响应包含 clientSecret');
      if (a.origin !== BASE) throw new Error(`票据 origin=${a.origin} 与页面来源 ${BASE} 不一致`);
      return `scopes=${(a.scopes || []).join(',')} origin=${a.origin} 有效期=${a.expiresIn}s 两次票据不同`;
    });

    await step('L5', '服务只监听本机回环地址', async () => {
      const port = Number(new URL(BASE).port || 80);
      const lan = Object.values(os.networkInterfaces()).flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      if (!lan.length) return '未发现非回环网卡，跳过外部连通性探测（监听地址 127.0.0.1 已写在代码中）';
      for (const address of lan.slice(0, 3)) {
        const reachable = await new Promise((resolve) => {
          const socket = net.connect({ host: address, port, timeout: 800 });
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => resolve(false));
          socket.once('timeout', () => { socket.destroy(); resolve(false); });
        });
        if (reachable) throw new Error(`可从 ${address}:${port} 访问，服务未限制在本机`);
      }
      return `已验证 ${lan.slice(0, 3).join(' / ')} 均无法连通 ${port}`;
    });

    await step('L6', '导出产物落地并可解析正文', async () => {
      const names = (await readdir(EXPORT_DIR).catch(() => [])).filter((f) => f.endsWith('.docx'));
      if (!names.length) {
        throw new Error('runtime/exports 下暂无导出文件。SDK 只回传元数据、字节由浏览器直接下载，请把下载到的 docx 复制到 runtime/exports/ 后重跑');
      }
      const withTime = await Promise.all(names.map(async (name) => ({
        name,
        mtime: (await stat(path.join(EXPORT_DIR, name))).mtimeMs,
      })));
      const newest = withTime.sort((a, b) => b.mtime - a.mtime)[0].name;
      const file = path.join(EXPORT_DIR, newest);
      const buffer = await readFile(file);
      const info = extractDocxText(buffer);
      const markers = ['IMPORT-SAMPLE-JITARCHIVES-20261026', 'JITARCHIVES-STAGE1-TYPING-20261026'];
      const hit = markers.filter((m) => info.text.includes(m));
      if (!hit.length) throw new Error(`${newest} 未包含任何测试标记（正文首段：${info.paragraphs[0] || ''}）`);
      return `${newest}：${buffer.length} 字节，OOXML 部件 ${info.files.length} 个，段落 ${info.paragraphs.length} 个，命中标记 ${hit.join('/')}`;
    });
  }
}

/* ---------- 汇总 ---------- */

const failed = results.filter((r) => r.status === 'FAIL');
console.log('\n== 汇总 ==');
console.log(`通过 ${results.filter((r) => r.status === 'PASS').length} / 失败 ${failed.length} / 跳过 ${results.filter((r) => r.status === 'SKIP').length}`);
console.log('浏览器交互项（握手、正文输入、保存后重开、导入导出、只读拦截）需人工或以浏览器自动化完成，结果见 docs/阶段一接入验证报告.md。');
console.log(`本地敏感配置：${path.relative(ROOT_DIR, LOCAL_CONFIG_FILE)}（已被 .gitignore 忽略）`);
if (failed.length) {
  console.log('\n失败项：');
  for (const item of failed) console.log(`  - ${item.id} ${item.name}: ${item.evidence}`);
  process.exit(1);
}
