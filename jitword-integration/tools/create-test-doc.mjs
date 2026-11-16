/**
 * 创建/替换“仅测试”专属验证文档，并把 docId 写入 runtime/state.json（服务重启后复用）。
 *
 * 用法: node tools/create-test-doc.mjs [文档名]
 *
 * 说明：默认文档名使用 ASCII，因为 JitWord 演示环境在文档名含非 ASCII 字符时，
 * 导出接口会返回 500 `Invalid character in header content ["Content-Disposition"]`
 * （服务端直接把文档名写进了响应头）。"ONLY-TEST" 即明确的“仅测试”标识。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig, RUNTIME_DIR, STATE_FILE } from '../lib/config.mjs';
import { createJitWordClient, DEFAULT_TEST_SUBJECT } from '../lib/jitword.mjs';

const name = process.argv[2] || 'ONLY-TEST_JitArchives_Stage1_JitWord_Verification';
const config = await loadConfig();
const jitword = createJitWordClient(config);

let previous = null;
try {
  previous = JSON.parse(await readFile(STATE_FILE, 'utf8'));
} catch { /* 首次运行 */ }

const created = await jitword.createDocument({ name, externalSubject: DEFAULT_TEST_SUBJECT });

await mkdir(RUNTIME_DIR, { recursive: true });
const next = {
  docId: created.docId,
  docName: created.name || name,
  docIdSource: 'tools/create-test-doc.mjs 创建',
  subject: DEFAULT_TEST_SUBJECT,
  tenantKey: config.tenantKey,
  providerKey: config.providerKey,
  createdAt: new Date().toISOString(),
  note: '仅用于阶段一接入验证，不含业务数据；演示环境不承诺可用性与备份',
  previousDocId: previous?.docId || null,
};
await writeFile(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

console.log(`新测试文档已创建：docId=${next.docId}`);
console.log(`文档名：${next.docName}`);
console.log(`创建主体：${next.subject}（换票必须用同一主体）`);
if (previous?.docId) console.log(`上一份 docId=${previous.docId} 仅保留在 state.previousDocId 中，不再使用`);
console.log('请重启验证服务：node server.mjs');
