/**
 * 从根目录的 jiword_config.txt 抽取接入参数，写入 config/config.local.json。
 *
 * 只做正则匹配，不对配置文本做任何 eval / new Function / require，
 * 因此配置文件里的注释和代码片段不会被执行。
 * 终端只打印字段名与长度，不打印任何密钥值。
 *
 * 用法: node tools/import-config.mjs [源文件路径]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, LOCAL_CONFIG_FILE, ROOT_DIR } from '../lib/config.mjs';

const source = process.argv[2] || path.join(ROOT_DIR, '..', 'jiword_config.txt');
const raw = await readFile(source, 'utf8');

const pick = (field) => {
  const match = raw.match(new RegExp(`${field}\\s*:\\s*'([^']*)'`));
  return match ? match[1].trim() : '';
};

const config = {
  api: pick('api'),
  tenantKey: pick('tenantKey'),
  providerKey: pick('providerKey'),
  clientSecret: pick('clientSecret'),
  origin: pick('origin'),
  docId: pick('docId'),
  editorUrl: pick('editorUrl'),
  port: Number(pick('port') || 3000),
};

const missing = ['api', 'tenantKey', 'providerKey', 'clientSecret']
  .filter((field) => !config[field]);
if (missing.length) {
  console.error(`源配置缺少字段：${missing.join('、')}`);
  process.exit(1);
}

await mkdir(CONFIG_DIR, { recursive: true });
await writeFile(LOCAL_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

for (const [key, value] of Object.entries(config)) {
  const shown = key === 'clientSecret'
    ? `已读取（${String(value).length} 字符，不打印）`
    : JSON.stringify(value);
  console.log(`  ${key.padEnd(12)} ${shown}`);
}
console.log(`\n已写入 ${path.relative(ROOT_DIR, LOCAL_CONFIG_FILE)}（该文件已被 .gitignore 忽略，请勿提交）`);
