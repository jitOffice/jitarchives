/**
 * 阶段一验证页：加载官方 iframe SDK v1（稳定通道），双测试身份嵌入同一份测试文档。
 *
 * 关键约束（与官方文档一致）：
 *   - clientSecret 只在服务端；页面只调用本服务的 /api/ticket 拿票；
 *   - getEmbedTicket 每次握手/续期都重新请求，禁止缓存；
 *   - 只使用官方文档列出的方法（save / exportDocx / importDocx / getContent / setReadonly…），不臆造接口；
 *   - “验证只读权限”在**专属探测文档**上用只读票据尝试写操作，只有明确权限拒绝才判通过，
 *     探测实例用官方 destroy() 回收，全程不改动验证主文档。
 */
const params = new URLSearchParams(location.search);
const identity = params.get('identity') === 'viewer' ? 'viewer' : 'editor';
const marker = params.get('marker') || '阶段一浏览器输入验证-20261026';

const IMPORT_MARKER = 'IMPORT-SAMPLE-JITARCHIVES-20261026';
const el = (id) => document.getElementById(id);
const state = { config: null, editor: null, sdkVersion: null, ready: null, lastTicket: null, exported: null, probeRunning: false };

window.__stage1 = state;

function log(message, tone) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  if (tone) item.className = tone;
  el('log-list').appendChild(item);
  el('log-list').parentElement.scrollTop = el('log-list').parentElement.scrollHeight;
}

function setField(id, text, tone) {
  const node = el(id);
  node.textContent = text;
  node.className = tone || '';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`SDK loader 加载失败：${src}`));
    document.head.appendChild(script);
  });
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${url} 返回 HTTP ${res.status}`);
  return data;
}

/** 每次调用都向后端现要一张新票（票据一次性，禁止缓存）。
 *  target=main 为验证主文档；target=probe 为“验证只读权限”专用的探测文档。
 */
async function requestTicket(target = 'main') {
  const data = await fetchJson('/api/ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, target }),
  });
  if (target === 'main') {
    state.lastTicket = data;
    setField('f-scopes', (data.scopes || []).join(', ') || '-', data.scopes?.includes('document:edit') ? 'ok' : 'warn');
    setField('f-origin', data.origin || '-', data.origin === location.origin ? 'ok' : 'err');
    log(`取票成功：${identity} / ${(data.scopes || []).join(',')} / origin=${data.origin} / ${data.expiresIn}s 有效（未缓存）`);
  } else {
    log(`取票成功（${target} 文档 docId=${data.docId}）：${identity} / ${(data.scopes || []).join(',')} / ${data.expiresIn}s 有效（未缓存）`);
  }
  return data;
}

/** 验证主文档的票据提供者：每次握手/续期都重新请求 */
async function getEmbedTicket() {
  return (await requestTicket('main')).ticket;
}

/* ---------------- 导出字节归一化：只依赖实际返回结构，不做假设 ---------------- */

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normalizeExport(res) {
  const payload = res && typeof res === 'object' && res.result !== undefined ? res.result : res;
  const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [typeof payload];
  const p = payload || {};

  let bytes = null;
  const candidates = [p.base64, p.content, p.data, p.docx, p.bytes, p.buffer, typeof payload === 'string' ? payload : null];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate instanceof ArrayBuffer) { bytes = new Uint8Array(candidate); break; }
    if (ArrayBuffer.isView(candidate)) { bytes = new Uint8Array(candidate.buffer.slice(candidate.byteOffset, candidate.byteOffset + candidate.byteLength)); break; }
    if (Array.isArray(candidate)) { bytes = new Uint8Array(candidate); break; }
    if (typeof candidate === 'string') {
      const cleaned = candidate.replace(/^data:[^;]+;base64,/, '');
      if (cleaned.length > 100) { bytes = base64ToBytes(cleaned); break; }
    }
  }
  const fileName = p.fileName || p.filename || p.name || `jitarchives-export-${Date.now()}.docx`;
  return { payload, keys, bytes, fileName };
}

function download(bytes, fileName) {
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.endsWith('.docx') ? fileName : `${fileName}.docx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- 操作按钮 ---------------- */

async function handleSave() {
  try {
    const result = await state.editor.save();
    setField('f-save', '保存调用成功', 'ok');
    log(`save() → ${JSON.stringify(result).slice(0, 300)}`, 'ok');
  } catch (error) {
    setField('f-save', `${error.code || 'ERROR'} 保存失败`, 'err');
    log(`save() 失败：${error.code || ''} ${error.message}`, 'err');
  }
}

async function handleExport() {
  const button = el('btn-export');
  button.disabled = true;
  try {
    log('exportDocx() 调用中…');
    const result = await state.editor.exportDocx({ timeout: 60000 });
    const { payload, keys, bytes, fileName } = normalizeExport(result);
    log(`exportDocx() 返回字段：${keys.join(', ')}`);
    log(`exportDocx() 返回：${JSON.stringify(payload).slice(0, 400)}`);

    // 实测（SDK 1.1.0 + inner.jitword.com 演示环境）：exportDocx 只回传
    // { success, filename, size, mimeType }，docx 字节由编辑器在浏览器内直接下载，
    // 不交给宿主页面。此时以“元数据成功”作为导出成功依据，并提示文件位置。
    if (!bytes && payload && payload.success) {
      state.exported = payload;
      setField('f-export', `已导出 ${payload.filename}（${payload.size} 字节）`, 'ok');
      log(`导出成功：${payload.filename}，${payload.size} 字节，${payload.mimeType}`, 'ok');
      log('注意：SDK 只回传元数据，docx 字节不在宿主页面；文件已由编辑器在浏览器内下载（本机默认下载目录/桌面）。');
      log('校验方法：把下载到的 docx 复制到 runtime/exports/ 后执行 node tools/selfcheck.mjs');
      return;
    }

    if (!bytes || !bytes.length) throw new Error(`未能从返回结构提取 docx 字节（字段：${keys.join(', ')}）`);

    const saved = await fetchJson('/api/artifacts/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64: bytesToBase64(bytes),
        fileName: String(fileName).endsWith('.docx') ? fileName : `${fileName}.docx`,
        expect: marker,
      }),
    });
    state.exported = saved;
    download(bytes, String(fileName).endsWith('.docx') ? fileName : `${fileName}.docx`);

    const check = saved.inspection?.containsExpect;
    setField('f-export', `${saved.size} 字节 / 含标记:${check === null ? '未校验' : check ? '是' : '否'}`, check === false ? 'err' : 'ok');
    log(`导出落盘：${saved.file}（${saved.size} 字节，sha256 ${saved.sha256.slice(0, 16)}…）`, 'ok');
    log(`导出件解析：部件 ${saved.inspection?.parts ?? '?'} 个，段落 ${saved.inspection?.paragraphCount ?? '?'} 个，含「${marker}」：${check}`);
    if (saved.inspection?.textPreview) log(`导出正文摘录：${saved.inspection.textPreview.slice(0, 200)}`);
    if (saved.inspectionError) log(`导出件解析失败：${saved.inspectionError}`, 'err');
  } catch (error) {
    setField('f-export', `${error.code || 'ERROR'} 导出失败`, 'err');
    log(`导出失败：${error.code || ''} ${error.message}`, 'err');
  } finally {
    button.disabled = false;
  }
}

async function importBlob(blob, fileName) {
  try {
    log(`importDocx() 调用中（${fileName}，${blob.size} 字节）…`);
    const result = await state.editor.importDocx({ content: blob, fileName, mode: 'replace', timeout: 60000 });
    const detail = result && result.result !== undefined ? result.result : result;
    setField('f-import', '导入成功', 'ok');
    log(`importDocx() → ${JSON.stringify(detail).slice(0, 400)}`, 'ok');
    return detail;
  } catch (error) {
    setField('f-import', `${error.code || 'ERROR'} 导入失败`, 'err');
    log(`importDocx() 被拒绝：${error.code || ''} ${error.message}`, 'err');
    throw error;
  }
}

async function handleImportSample() {
  try {
    const res = await fetch(`/api/sample-import-docx?marker=${encodeURIComponent(IMPORT_MARKER)}`);
    if (!res.ok) throw new Error(`样例下载失败 HTTP ${res.status}`);
    const blob = await res.blob();
    await importBlob(blob, 'jitarchives-import-sample.docx');
  } catch (error) {
    log(`内置样例导入失败：${error.message}`, 'err');
  }
}

/* ---------------- “验证只读权限”：专属探测文档 + 严格判定 ---------------- */

// 只有厂商明确返回“权限拒绝”才算只读拦截通过；
// 文件损坏、超时、连接异常、内部错误等一律判验证失败，避免把任何导入失败都当成拦截成功。
const PERMISSION_DENIED_CODES = new Set(['PERMISSION_DENIED']);
const PROBE_SAVE_TIMEOUT = 15000;
const PROBE_IMPORT_TIMEOUT = 30000;

/** 给任意异步步骤加超时：超时也按“验证失败”处理，不阻塞按钮与页面 */
function withTimeout(run, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} 超时（${ms}ms 内无响应）`);
      error.code = 'PROBE_TIMEOUT';
      reject(error);
    }, ms);
    Promise.resolve().then(run).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 执行一次写操作并按错误码分类：只有权限拒绝算“被拦住”，写成功一律算失败 */
async function attemptWrite(label, run, timeoutMs) {
  try {
    const value = await withTimeout(run, timeoutMs, label);
    return { label, denied: false, code: 'ALLOWED', detail: JSON.stringify(value ?? null).slice(0, 200) };
  } catch (error) {
    const code = String((error && error.code) || 'UNKNOWN');
    return { label, denied: PERMISSION_DENIED_CODES.has(code), code, detail: String((error && error.message) || '') };
  }
}

function describeAttempt(result) {
  return result.denied
    ? `${result.label} → ${result.code}（明确权限拒绝，符合预期）`
    : `${result.label} → ${result.code}（${result.detail || '未出现权限拒绝'}）`;
}

/** 取内置测试 DOCX（服务端零依赖生成的完整有效文件），并做最小结构自检 */
async function fetchProbeDocx() {
  const res = await fetch('/api/probe-docx', { cache: 'no-store' });
  if (!res.ok) throw new Error(`内置测试 DOCX 下载失败 HTTP ${res.status}`);
  const blob = await res.blob();
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (!isZip) throw new Error(`内置测试 DOCX 不是有效 zip（前 4 字节：${[...head].join(',') || '空'}）`);
  if (blob.size < 1024) throw new Error(`内置测试 DOCX 体量异常（${blob.size} 字节），疑似不完整`);
  return blob;
}

/** 验证主文档正文快照：用于证明“验证只读权限”没有改动正文 */
async function readMainSignature() {
  const result = await withTimeout(() => state.editor.getContent(), 20000, '读取验证主文档正文');
  return JSON.stringify(result);
}

/** 按钮可用性：只在只读身份下允许执行 */
function setupProbeButton() {
  const button = el('btn-probe-write');
  if (!button) return;
  if (identity === 'viewer') {
    button.disabled = false;
    button.title = '用只读票据在专属探测文档上尝试 save()/importDocx()；只有明确的权限拒绝才算通过';
    setField('f-probe', '待执行（只读身份）', '');
  } else {
    button.disabled = true;
    button.title = '仅只读身份可执行：请先切换到“只读身份”后验证';
    setField('f-probe', '编辑身份下禁用：请先切换到只读身份', 'warn');
  }
}

async function handleProbeReadonly() {
  if (identity !== 'viewer') {
    log('验证只读权限：仅允许在只读身份下执行，请切换到“只读身份”后重试', 'err');
    setField('f-probe', '编辑身份下不可执行：请先切换到只读身份', 'warn');
    return;
  }
  if (state.probeRunning) {
    log('验证只读权限：上一次验证仍在进行，请稍候', 'warn');
    return;
  }
  if (!state.config) {
    log('验证只读权限：页面配置尚未加载完成，请稍后重试', 'err');
    return;
  }

  const button = el('btn-probe-write');
  const recovery = el('probe-recovery');
  const attempts = [];
  let probeEditor = null;
  let before = null;
  let failure = null;

  state.probeRunning = true;
  button.disabled = true;
  recovery.hidden = true;
  setField('f-probe', '验证中…（专属探测文档）', '');
  log('验证只读权限：开始（目标为专属探测文档，不改动验证主文档）');

  try {
    const probeDocId = state.config.probeDocId;
    if (!probeDocId) {
      throw new Error('服务端没有可用的专属探测文档（probeDocId 为空）：为避免覆盖验证主文档，本次直接判为验证失败；请重启本地验证服务以创建探测文档');
    }
    if (!window.JitWord) throw new Error('iframe SDK 未就绪（window.JitWord 不存在），无法创建探测实例');
    log(`验证只读权限：探测文档 ${state.config.probeDocName || '-'}（docId=${probeDocId}），验证主文档 docId=${state.config.docId}`);

    before = await readMainSignature().catch((error) => {
      log(`验证前读取验证主文档失败：${error.code || ''} ${error.message}（正文一致性将无法确认，整体判为“验收未完成”）`, 'warn');
      return null;
    });

    const docx = await fetchProbeDocx();
    log(`验证只读权限：内置测试 DOCX 就绪（${docx.size} 字节，zip 头有效，标记 ${state.config.probeMarker || '-'}）`);

    // 预取一张只读票据并先核对 scopes，再交给探测实例握手（后续续期仍现取）
    let prefetched = await requestTicket('probe');
    const probeTicket = async () => {
      const next = prefetched || (await requestTicket('probe'));
      prefetched = null;
      return next.ticket;
    };
    const scopes = prefetched.scopes || [];
    if (scopes.includes('document:edit')) throw new Error(`只读票据仍含 document:edit（${scopes.join(',')}），票据策略异常`);
    log(`验证只读权限：只读票据 scopes=${scopes.join(',') || '-'}（不含 document:edit）`);

    probeEditor = window.JitWord.createEditor({
      container: '#probe-stage',
      editorUrl: state.config.editorUrl,
      apiBase: state.config.apiBase,
      docId: probeDocId,
      documentType: 'document',
      tenantKey: state.config.tenantKey,
      providerKey: state.config.providerKey,
      auth: { mode: 'embed-ticket', getEmbedTicket: probeTicket },
      ui: { theme: 'auto', chrome: 'toolbar', readonly: true },
      debug: { enabled: false },
    });
    probeEditor.on('error', (error) => log(`探测实例 error：${error.code || ''} ${error.message}`, 'err'));
    await withTimeout(() => probeEditor.ready(), 30000, '探测实例握手');
    log('验证只读权限：探测实例握手完成', 'ok');

    attempts.push(await attemptWrite('save()', () => probeEditor.save({ timeout: PROBE_SAVE_TIMEOUT }), PROBE_SAVE_TIMEOUT + 5000));
    attempts.push(await attemptWrite('importDocx()', () => probeEditor.importDocx({
      content: docx,
      fileName: 'jitarchives-permission-probe.docx',
      mode: 'replace',
      timeout: PROBE_IMPORT_TIMEOUT,
    }), PROBE_IMPORT_TIMEOUT + 10000));
  } catch (error) {
    failure = error;
  }

  // 官方支持的恢复方式：destroy() 回收探测实例，其 iframe 内的权限提示随实例一起消失；
  // 验证主文档的 iframe 全程不参与写操作，因此无需关闭任何厂商内部弹窗。
  if (probeEditor) {
    try { probeEditor.destroy(); } catch (error) { log(`探测实例 destroy() 异常：${error.message}`, 'warn'); }
  }
  el('probe-stage').innerHTML = '';

  try {
    // 快照读取失败时 after 为 null（before 已失败则不再重复读取）
    const after = before === null ? null : await readMainSignature().catch((error) => {
      log(`验证后读取验证主文档失败：${error.code || ''} ${error.message}（正文一致性将无法确认，整体判为“验收未完成”）`, 'warn');
      return null;
    });

    // 维度一：权限拦截——save/importDocx 是否都被明确拒绝，独立于正文一致性
    const permissionFailures = [];
    if (failure) permissionFailures.push(`${failure.code || 'ERROR'} ${failure.message}`.trim());
    for (const attempt of attempts) if (!attempt.denied) permissionFailures.push(`${attempt.label} 未出现权限拒绝（${attempt.code}）`);
    if (!failure && attempts.length !== 2) permissionFailures.push(`写操作验证未完整执行（已完成 ${attempts.length}/2）`);

    // 维度二：正文一致性——仅当验证前后快照都读取成功才可比对
    const snapshotAvailable = before !== null && after !== null;
    const contentUnchanged = snapshotAvailable ? before === after : null;
    const contentFailures = [];
    const contentIncomplete = [];
    if (before === null) contentIncomplete.push('验证前未能读取验证主文档正文快照');
    else if (after === null) contentIncomplete.push('验证后未能读取验证主文档正文快照');
    else if (contentUnchanged === false) contentFailures.push('验证主文档正文发生变化（探测不应影响主文档）');

    for (const attempt of attempts) log(`验证只读权限：${describeAttempt(attempt)}`, attempt.denied ? 'ok' : 'err');
    if (snapshotAvailable) {
      log(`验证只读权限：验证主文档正文${contentUnchanged ? '未变化' : '发生变化'}`, contentUnchanged ? 'ok' : 'err');
    } else {
      log('验证只读权限：正文一致性未完成比对（快照读取失败），不据此宣称主文档未变化', 'warn');
    }

    if (permissionFailures.length || contentFailures.length) {
      // 权限拦截失败或正文发生变化：判为验证失败
      const reasons = [...permissionFailures, ...contentFailures];
      setField('f-probe', `验证失败：${reasons[0]}`.slice(0, 90), 'err');
      for (const item of reasons) log(`验证只读权限：失败原因——${item}`, 'err');
      recovery.hidden = false;
      log('验证只读权限：失败。按钮与页面状态已恢复（探测实例已 destroy() 回收）；若验证主文档 iframe 内仍残留错误弹窗，请点击“重新加载页面”恢复', 'err');
    } else if (contentIncomplete.length) {
      // 权限拦截通过，但正文一致性无法确认：整体标记“验收未完成”，不得宣称主文档未变化
      setField('f-probe', '验收未完成：权限拦截已通过，但正文一致性未确认', 'warn');
      for (const item of contentIncomplete) log(`验证只读权限：验收未完成——${item}`, 'warn');
      recovery.hidden = true;
      log('验证只读权限：权限拦截（save/importDocx 均被拒绝）已通过；但主文档正文快照读取失败，无法确认正文是否一致，整体判为“验收未完成”，不代表主文档未变化。请排查主文档读取后重新执行复验', 'warn');
    } else {
      // 权限拦截与正文一致性均通过：完整通过
      setField('f-probe', '通过：权限拦截生效，主文档正文未变化', 'ok');
      log('验证只读权限：通过——只读拦截生效、探测实例已回收、主文档正文未变化，页面可继续操作', 'ok');
      recovery.hidden = true;
    }
  } finally {
    state.probeRunning = false;
    button.disabled = identity !== 'viewer';
  }
}

async function handleReadContent() {
  try {
    const result = await state.editor.getContent();
    const text = JSON.stringify(result);
    const hasMarker = text.includes(marker);
    const hasImport = text.includes(IMPORT_MARKER);
    log(`getContent() 返回 ${text.length} 字符；含输入标记「${marker}」：${hasMarker}；含导入标记：${hasImport}`);
    log(`正文摘录：${text.slice(0, 240)}`);
  } catch (error) {
    log(`getContent() 失败：${error.code || ''} ${error.message}`, 'err');
  }
}

/* ---------------- 启动 ---------------- */

async function boot() {
  el('f-page-origin').textContent = location.origin;
  el('f-identity').textContent = identity === 'editor' ? '编辑（editor）' : '只读（viewer）';
  el(`identity-${identity}`)?.classList.add('active');
  el('f-docid').textContent = '-';
  el('f-marker').textContent = marker;
  setupProbeButton();

  state.config = await fetchJson('/api/config');
  el('f-docid').textContent = state.config.docId;
  log(`配置：api=${state.config.apiBase} editor=${state.config.editorUrl} loader=${state.config.loaderUrl}`);
  log(`测试文档：${state.config.docName}（docId=${state.config.docId}）`);
  log(`探测文档（“验证只读权限”专用，与主文档隔离）：${state.config.probeDocName || '未创建'}（docId=${state.config.probeDocId || '-'}）`, state.config.probeDocId ? '' : 'warn');
  log(`请在正文中输入这句用于校验的文本：${marker}`);

  try {
    await loadScript(state.config.loaderUrl);
  } catch (error) {
    setField('f-ready', 'SDK 加载失败', 'err');
    log(error.message, 'err');
    return;
  }
  if (!window.JitWord) {
    setField('f-ready', 'SDK 未注入', 'err');
    return;
  }
  state.sdkVersion = window.JitWord.version || '未知';
  setField('f-sdk', `${state.sdkVersion}（v1 通道）`, 'ok');
  log(`SDK loader 已加载：JitWord.version=${state.sdkVersion}，能力方法 ${Object.keys(window.JitWord.actions || {}).length} 项`);

  state.editor = window.JitWord.createEditor({
    container: '#jitwordEditor',
    editorUrl: state.config.editorUrl,
    apiBase: state.config.apiBase,
    docId: state.config.docId,
    documentType: 'document',
    tenantKey: state.config.tenantKey,
    providerKey: state.config.providerKey,
    auth: { mode: 'embed-ticket', getEmbedTicket },
    ui: { theme: 'auto', chrome: 'toolbar', readonly: identity === 'viewer' },
    debug: { enabled: true },
  });

  state.editor.on('ready', (payload) => {
    state.ready = payload;
    setField('f-ready', '编辑器就绪', 'ok');
    log(`ready：${JSON.stringify(payload).slice(0, 500)}`, 'ok');
  });
  state.editor.on('error', (error) => {
    setField('f-ready', `${error.code || 'ERROR'} 出错`, 'err');
    log(`error：${error.code} ${error.message}`, 'err');
  });
  state.editor.on('saveStateChanged', (payload) => {
    const status = payload?.saveStatus || JSON.stringify(payload);
    setField('f-save', String(status), status === 'saved' ? 'ok' : '');
    log(`saveStateChanged：${JSON.stringify(payload).slice(0, 200)}`);
  });
  state.editor.on('contentChanged', (payload) => log(`contentChanged：${JSON.stringify(payload).slice(0, 200)}`));
  state.editor.on('permissionChanged', (payload) => log(`permissionChanged：${JSON.stringify(payload).slice(0, 200)}`));
  state.editor.on('connectionChanged', (payload) => log(`connectionChanged：${JSON.stringify(payload).slice(0, 160)}`));
  state.editor.on('onlineUsersChanged', (payload) => log(`onlineUsersChanged：${JSON.stringify(payload).slice(0, 160)}`));
  state.editor.on('auth.refreshRequired', () => log('auth.refreshRequired：SDK 将自行重新取票（每次现票）'));
  state.editor.on('auth.sessionExpired', () => {
    setField('f-ready', '会话已到期（已转只读）', 'warn');
    log('auth.sessionExpired：会话到期，需要重新加载页面', 'err');
  });
  state.editor.on('diagnostic', (entry) => {
    if (entry?.stage && entry.stage !== 'loader.init') log(`diagnostic：${entry.stage}`);
  });
}

el('btn-save').addEventListener('click', () => state.editor && handleSave());
el('btn-export').addEventListener('click', () => state.editor && handleExport());
el('btn-import-sample').addEventListener('click', () => state.editor && handleImportSample());
el('btn-probe-write').addEventListener('click', () => handleProbeReadonly());
el('btn-probe-recovery').addEventListener('click', () => location.reload());
el('btn-read-content').addEventListener('click', () => state.editor && handleReadContent());
el('btn-reload').addEventListener('click', () => location.reload());
el('btn-clear-log').addEventListener('click', () => { el('log-list').innerHTML = ''; });

el('btn-import-file').addEventListener('click', () => el('file-input').click());
el('file-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file || !state.editor) return;
  try {
    await importBlob(file, file.name);
  } catch { /* 已在 importBlob 内记录 */ }
  event.target.value = '';
});

boot().catch((error) => {
  setField('f-ready', '启动失败', 'err');
  log(`启动失败：${error.message}`, 'err');
});
