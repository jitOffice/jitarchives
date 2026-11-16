// 下载官方 JitWord 嵌入示例包（仅用于阶段一接入验证的资料留存）
// 用法: node download-demo.mjs [url]
import { writeFile } from 'node:fs/promises';

const url = process.argv[2] || 'https://inner.jitword.com/demo/jitword-embed-demo.zip';
const out = new URL('./jitword-embed-demo.zip', import.meta.url);

const res = await fetch(url);
if (!res.ok) {
  console.error(`下载失败: HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(out, buf);
console.log(`已保存 ${out.pathname} (${buf.length} bytes)`);
