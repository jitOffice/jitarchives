/**
 * 细项诊断（取证用）：票据返回的 ui/behavior/watermark、存储后端、隔离边界响应码。
 * 用法: node tools/diagnose.mjs
 * 不打印 clientSecret / 完整票据。
 */
import { loadConfig, STATE_FILE } from '../lib/config.mjs';
import { createJitWordClient } from '../lib/jitword.mjs';
import { readFile } from 'node:fs/promises';

const config = await loadConfig();
const jitword = createJitWordClient(config);
const apiRoot = config.api.replace(/\/api\/v1$/, '');
const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));

console.log('--- 1. 隔离边界响应码 ---');
for (const [method, pathname] of [
  ['GET', '/api/v1/admin/users'],
  ['GET', '/api/v1/documents'],
  ['GET', '/api/v1/parse/x'],
  ['POST', '/api/v1/user/login'],
  ['GET', '/api/v1/nonexistent-xyz'],
]) {
  const res = await fetch(`${apiRoot}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  });
  const text = (await res.text()).slice(0, 100).replace(/\s+/g, ' ');
  console.log(`  ${method.padEnd(4)} ${pathname.padEnd(24)} → HTTP ${res.status} ${text}`);
}

console.log('\n--- 2. 票据实际返回（隐藏票据本体）---');
for (const identity of ['editor', 'viewer']) {
  const ticket = await jitword.createTicket({
    docId: state.docId,
    origin: 'http://127.0.0.1:3000',
    identity,
    externalSubject: state.subject,
  });
  const { ticket: raw, requestedScopes, requestedRole, ...rest } = ticket;
  console.log(`  ${identity}: ${JSON.stringify(rest)}`);
}

console.log('\n--- 3. 显式 ui.readonly=true 的只读票（核对是否被服务端采纳）---');
const res = await jitword.request('/embed/tickets', {
  method: 'POST',
  body: {
    tenantKey: config.tenantKey,
    providerKey: config.providerKey,
    externalSubject: state.subject,
    document: { docId: state.docId },
    permission: { role: 'viewer', scopes: ['document:read'] },
    ui: { readonly: true, theme: 'auto', toolbar: 'compact' },
    origin: 'http://127.0.0.1:3000',
    expiresIn: 60,
  },
});
const data = res.payload?.data || {};
delete data.ticket;
console.log('  HTTP', res.status, JSON.stringify(data));

console.log('\n--- 4. 存储后端（diagnostics.checks.storage）---');
const diag = await jitword.diagnostics();
console.log('  HTTP', diag.status, JSON.stringify(diag.data?.checks));
console.log('  manifest:', JSON.stringify(diag.data?.manifest?.loaderVersion), 'runtime:', JSON.stringify(diag.data?.manifest?.runtimeVersion));
