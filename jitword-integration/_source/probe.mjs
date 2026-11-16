// 探测 JitWord 服务端公开信息（manifest / SDK loader / 文档页），用于核对 PRD 中的 SDK 方法
// 用法: node probe.mjs
const API = 'https://inner.jitword.com/api/v1';
const EDITOR = 'https://inner.jitword.com/px-editor';

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

const manifest = await getJson(`${API}/embed/manifest`);
console.log('=== manifest ===');
console.log('HTTP', manifest.status);
console.log(JSON.stringify(manifest.json, null, 2));

const loader = await fetch(`${EDITOR}/iframe-sdk/v1/loader.js`);
const loaderText = await loader.text();
console.log('=== loader.js ===');
console.log('HTTP', loader.status, 'bytes', loaderText.length);
console.log(loaderText.slice(0, 3000));
