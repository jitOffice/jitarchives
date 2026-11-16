/**
 * JitArchives 阶段二第五批 · 备份与恢复 CLI 端到端自动化验证（node:test）
 *
 * 隔离：独立源库（storage/test-br-src-<pid>.db）+ 独立源文件目录 + 独立备份根目录 +
 *       独立恢复目标库/目录；绝不触碰正式库，绝不对正式环境执行恢复。
 * 工具经 process.execPath（当前运行测试的 Node）调用，零额外依赖，跨平台。
 *
 * 覆盖：
 *  1. backup.mjs：VACUUM INTO 快照 + integrity_check + 逐文件 SHA-256 + 清单 + 恢复点一致性；
 *  2. 备份绝不留半成品：删除被引用文件后再次备份必须失败并清理目录、非零退出；
 *  3. restore.mjs：校验清单/逐文件校验/快照完整性，恢复到隔离目标；
 *  4. 恢复实例数据仍在：以恢复库启动新实例，档案可查、附件可下载且字节一致；
 *  5. 防误覆盖：目标已存在默认拒绝，需 --force；--force 前先做 .pre-restore 安全副本；
 *  6. 迁移兼容：备份/恢复前后档案-附件-审计等表结构随库文件完整迁移（001–006）。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE = path.join(__dirname, '..', 'storage');
const SRC_DB = path.join(STORAGE, `test-br-src-${process.pid}.db`);
const SRC_STORE = path.join(STORAGE, `test-br-src-store-${process.pid}`);
const BACKUP_ROOT = path.join(STORAGE, `test-br-backup-${process.pid}`);
const RESTORE_DB = path.join(STORAGE, `test-br-restore-${process.pid}`, 'jitarchives.db');
const RESTORE_STORE = path.join(STORAGE, `test-br-restore-${process.pid}`, 'file-store');
const FORCE_DIR = path.join(STORAGE, `test-br-force-${process.pid}`);
const FORCE_DB = path.join(FORCE_DIR, 'jitarchives.db');
const FORCE_STORE = path.join(FORCE_DIR, 'file-store');
const TOOLS = path.join(__dirname, '..', 'tools');

let baseUrl = null;
let currentApp = null;

async function startServer(dbFile, fileStoreDir) {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({ port: 0, dbFile, fileStoreDir, serveWeb: false });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}
async function stopServer() {
  if (currentApp) await currentApp.close();
  currentApp = null;
}

async function req(pathname, { method = 'GET', body, cookie, raw, headers: extraHeaders } = {}) {
  const headers = { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(extraHeaders || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.get('set-cookie');
  let newCookie = cookie;
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, cookie: newCookie };
}

/** 运行工具 CLI，返回 { code, stdout, stderr }（非零退出不抛错，交由断言判定）。 */
async function runTool(script, args) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [path.join(TOOLS, script), ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message) };
  }
}

function safeRm(f) {
  try {
    rmSync(f, { force: true });
  } catch {
    /* 忽略 */
  }
}
function safeRmDir(d) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

const ADMIN = { username: 'brroot', displayName: '备份管理员', password: 'Admin#12345' };
const PDF = new TextEncoder().encode('%PDF-1.4\n% backup restore e2e payload\n%%EOF\n');

let adminCookie = '';
const ids = {};
let backupDir = null;

test.describe('JitArchives 阶段二第五批 · 备份与恢复端到端验证', { concurrency: false }, async () => {
  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${SRC_DB}${s}`);
    safeRmDir(SRC_STORE);
    safeRmDir(BACKUP_ROOT);
    safeRmDir(path.dirname(RESTORE_DB));
    safeRmDir(FORCE_DIR);
  });

  test.after(async () => {
    await stopServer();
    for (const s of ['', '-wal', '-shm']) safeRm(`${SRC_DB}${s}`);
    safeRmDir(SRC_STORE);
    safeRmDir(BACKUP_ROOT);
    safeRmDir(path.dirname(RESTORE_DB));
    safeRmDir(FORCE_DIR);
  });

  await test('准备：源实例建立档案与附件后停机（模拟可备份的静置库）', async () => {
    await startServer(SRC_DB, SRC_STORE);
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;

    const cat = await req('/api/categories', { method: 'POST', cookie: adminCookie, body: { name: '备份分类', code: 'BK' } });
    assert.equal(cat.status, 201);
    const arc = await req('/api/archives', {
      method: 'POST', cookie: adminCookie,
      body: { title: '备份回归档案', categoryId: cat.data.id, archiveType: '文书档案', accessLevel: 'public' },
    });
    assert.equal(arc.status, 201);
    ids.arc = arc.data.id;

    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.arc}&name=${encodeURIComponent('备份附件.pdf')}`,
      { method: 'POST', cookie: adminCookie, raw: true, body: PDF, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 201, JSON.stringify(up.data));
    ids.file = up.data.id;

    await stopServer();
    assert.ok(existsSync(SRC_DB), '停机后源库文件应存在');
  });

  await test('1. backup.mjs：快照 + integrity_check + SHA-256 + 清单 + 一致性全部通过', async () => {
    const r = await runTool('backup.mjs', ['--db', SRC_DB, '--store', SRC_STORE, '--out', BACKUP_ROOT]);
    assert.equal(r.code, 0, `备份应成功：${r.stderr}`);

    const dirs = readdirSync(BACKUP_ROOT).filter((n) => n.startsWith('jitarchives-backup-'));
    assert.equal(dirs.length, 1, '应生成唯一一个备份目录');
    backupDir = path.join(BACKUP_ROOT, dirs[0]);

    const manifest = JSON.parse(readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.tool, 'jitarchives-backup');
    assert.equal(manifest.snapshot.integrityCheck, 'ok');
    assert.ok(manifest.counts.archives >= 1, '清单档案数应 >=1');
    assert.ok(manifest.files.length >= 1, '清单应含被复制文件');
    assert.equal(manifest.referenced.missing.length, 0, '被引用文件不应缺失');
    assert.equal(manifest.referenced.mismatched.length, 0, '被引用文件校验不应不匹配');
    assert.ok(/^[0-9a-f]{64}$/.test(manifest.totalChecksum), '总校验和应为 SHA-256');
    // 快照与文件真实落地
    assert.ok(existsSync(path.join(backupDir, 'database', 'snapshot.db')), '快照文件应存在');
    assert.ok(existsSync(path.join(backupDir, 'files')), '文件目录应存在');
  });

  await test('2. 恢复点一致性：删除被引用文件后备份必须失败且不留半成品', async () => {
    const manifest = JSON.parse(readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    const refFile = manifest.files.find((f) => f.referenced);
    assert.ok(refFile, '应存在被引用文件');

    // 从源目录移走被引用文件，制造 DB 引用与文件系统不一致
    const victim = path.join(SRC_STORE, refFile.storedName);
    safeRm(victim);

    const r = await runTool('backup.mjs', ['--db', SRC_DB, '--store', SRC_STORE, '--out', BACKUP_ROOT]);
    assert.notEqual(r.code, 0, '被引用文件缺失时备份必须非零退出（绝不误报成功）');
    // 失败应清理本次半成品目录：备份根下仍只有第一步那一个成功目录
    const dirs = readdirSync(BACKUP_ROOT).filter((n) => n.startsWith('jitarchives-backup-'));
    assert.equal(dirs.length, 1, '失败的备份不应残留半成品目录');
  });

  await test('3. restore.mjs：恢复到隔离目标（全新目录，无需 --force）', async () => {
    const r = await runTool('restore.mjs', ['--from', backupDir, '--into-db', RESTORE_DB, '--into-store', RESTORE_STORE]);
    assert.equal(r.code, 0, `恢复到空目标应成功：${r.stderr}`);
    assert.ok(existsSync(RESTORE_DB), '恢复后目标库应存在');
    assert.ok(existsSync(RESTORE_STORE), '恢复后目标文件目录应存在');
  });

  await test('4. 恢复实例可运行：档案可查、附件可下载且字节一致', async () => {
    await startServer(RESTORE_DB, RESTORE_STORE);
    const relogin = await req('/api/auth/login', { method: 'POST', body: { username: ADMIN.username, password: ADMIN.password } });
    assert.equal(relogin.status, 201, '恢复库应可用原凭据登录');
    const ck = relogin.cookie;

    const detail = await req(`/api/archives/${ids.arc}`, { cookie: ck });
    assert.equal(detail.status, 200, '恢复后档案仍可读取');
    assert.equal(detail.data.title, '备份回归档案');

    const dl = await fetch(`${baseUrl}/api/archive-files/${ids.file}/download`, { headers: { Cookie: ck } });
    assert.equal(dl.status, 200, '恢复后附件应可下载');
    const bytes = new Uint8Array(await dl.arrayBuffer());
    assert.equal(bytes.length, PDF.length, '下载字节长度应与原始一致');
    assert.deepEqual(Array.from(bytes), Array.from(PDF), '下载内容应与原始字节完全一致');

    await stopServer();
  });

  await test('5. 防误覆盖：目标已存在默认拒绝，--force 前做安全副本', async () => {
    // 使用独立目标（全程仅由短命 CLI 子进程操作，无 in-process 服务句柄干扰）
    const fresh = await runTool('restore.mjs', ['--from', backupDir, '--into-db', FORCE_DB, '--into-store', FORCE_STORE]);
    assert.equal(fresh.code, 0, `首次恢复到全新目标应成功：${fresh.stderr}`);

    // 目标库已存在，未加 --force 必须拒绝
    const refused = await runTool('restore.mjs', ['--from', backupDir, '--into-db', FORCE_DB, '--into-store', FORCE_STORE]);
    assert.notEqual(refused.code, 0, '目标已存在时默认必须拒绝');
    assert.ok(/已存在|force/i.test(refused.stderr), '拒绝原因应提示需 --force');

    // --force：覆盖前应对现有目标库做 .pre-restore 安全副本
    const forced = await runTool('restore.mjs', ['--from', backupDir, '--into-db', FORCE_DB, '--into-store', FORCE_STORE, '--force']);
    assert.equal(forced.code, 0, `--force 恢复应成功：${forced.stderr}`);
    const safeCopies = readdirSync(FORCE_DIR).filter((n) => n.includes('.pre-restore-'));
    assert.ok(safeCopies.length >= 1, '--force 覆盖前应保留 .pre-restore 安全副本');
    assert.ok(/已将现有目标库安全副本/.test(forced.stderr), '应明确告知安全副本路径');
  });

  await test('6. 迁移兼容：恢复库完整携带 001–006 结构（审计表随库迁移）', async () => {
    await startServer(RESTORE_DB, RESTORE_STORE);
    const relogin = await req('/api/auth/login', { method: 'POST', body: { username: ADMIN.username, password: ADMIN.password } });
    assert.equal(relogin.status, 201);
    // /api/audit 可查询 → 证明 006-audit 表随快照完整迁移
    const page = await req(`/api/audit?pageSize=5`, { cookie: relogin.cookie });
    assert.equal(page.status, 200, '恢复库审计表应存在且可查询');
    assert.ok(page.data.total >= 1, '恢复库应保留备份前的审计记录');
    await stopServer();
  });
});
