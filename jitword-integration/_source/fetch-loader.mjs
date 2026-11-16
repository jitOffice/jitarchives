// 抓取 SDK loader.js 原文到本地，便于核对真实方法签名（不提交敏感信息，loader 为公开产物）
// 用法: node fetch-loader.mjs
import { writeFile } from 'node:fs/promises';

const url = 'https://inner.jitword.com/px-editor/iframe-sdk/v1/loader.js';
const res = await fetch(url);
const text = await res.text();
await writeFile(new URL('./loader.v1.js', import.meta.url), text, 'utf8');
console.log(`HTTP ${res.status}, ${text.length} bytes`);
