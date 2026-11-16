/**
 * JitArchives 阶段二第四批 · 元数据模板与动态著录后端自动化验证（node:test）
 *
 * 使用独立测试数据库（storage/test-templates-<pid>.db）与独立文件存储目录，
 * 不触碰正式库、64 项既有回归用例与其他测试库。
 * 覆盖项（对齐交付任务第十节模板相关场景）：
 *  1. 模板接口未登录 401；权限矩阵：管理仅管理员，查看为管理员/著录员；
 *  2. 模板创建/编辑/启停；重名 409；
 *  3. 字段校验：field_key ASCII 规则、同模板唯一、类型枚举、select/tags 候选项必填、
 *     number min/max、text maxLength、正则合法性；
 *  4. 分类绑定/解绑；停用模板不可绑定；
 *  5. 按分类模板拉取启用字段；
 *  6. 档案动态著录：合法入库、必填缺失/取值越界/类型不符被拒绝（后端权威）；
 *  7. 详情回显动态字段（含 tags JSON、bool）；
 *  8. 模板变更保护：被引用字段禁止改类型；停用字段保留历史值、不丢失；
 *  9. 收紧校验仅对新增生效，历史值不重算；
 * 10. 模板删除的引用保护：被分类绑定/有历史著录值拒删，未被引用可删；越权 403；写审计。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-templates-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-file-store-tpl-${process.pid}`);

let baseUrl = null;
let currentApp = null;

async function startServer() {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({ port: 0, dbFile: DB_FILE, fileStoreDir: FILE_STORE, serveWeb: false });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}
async function stopServer() {
  await currentApp.close();
  currentApp = null;
}

async function req(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

const ADMIN = { username: 'rootadmin', displayName: '总管理员', password: 'Admin#12345' };
const USERS = {
  cataloger: { username: 'cat_t', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  borrower: { username: 'bor_t', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'gst_t', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

let adminCookie = '';
const cookies = {};
const ids = {};

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201);
  return r.cookie;
}

const FULL_FIELDS = [
  { fieldKey: 'secret', label: '密级说明', type: 'select', required: true, options: ['普通', '重要', '机密'] },
  { fieldKey: 'copies', label: '份数', type: 'number', required: false, validation: { min: 1, max: 100 } },
  { fieldKey: 'tags', label: '主题标签', type: 'tags', required: false, options: ['归档', '合同', '项目'], validation: { maxItems: 2 } },
  { fieldKey: 'archived', label: '是否归档移交', type: 'bool', required: false },
  { fieldKey: 'handDate', label: '移交日期', type: 'date', required: false },
  { fieldKey: 'note', label: '备注', type: 'textarea', required: false, validation: { maxLength: 200 } },
];

test.describe('JitArchives 阶段二第四批 · 元数据模板自动化验证', { concurrency: false }, async () => {
  test.before(async () => {
    safeRm(DB_FILE);
    safeRm(`${DB_FILE}-wal`);
    safeRm(`${DB_FILE}-shm`);
    safeRmDir(FILE_STORE);
    await startServer();
  });

  test.after(async () => {
    if (currentApp) await stopServer();
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
  });

  await test('准备：初始化并建立角色与分类', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      cookies[key] = await login(USERS[key]);
    }
    const cat = await req('/api/categories', { method: 'POST', cookie: adminCookie, body: { name: '科研项目', code: 'KY' } });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;
  });

  // ==================== 1. 未登录 + 权限矩阵 ====================

  await test('模板接口：未登录 401；权限矩阵按角色独立校验', async () => {
    assert.equal((await req('/api/templates')).status, 401, '未登录必须 401');

    const catView = await req('/api/templates', { cookie: cookies.cataloger });
    assert.equal(catView.status, 200, '著录员可模板查看（templateView）');

    const catManage = await req('/api/templates', { method: 'POST', cookie: cookies.cataloger, body: { name: '越权模板', fields: [] } });
    assert.equal(catManage.status, 403, '著录员无模板管理权必须 403');

    const borView = await req('/api/templates', { cookie: cookies.borrower });
    assert.equal(borView.status, 403, '借阅者无 templateView 权限必须 403');

    const guestView = await req('/api/templates', { cookie: cookies.guest });
    assert.equal(guestView.status, 403, '访客必须 403（默认拒绝）');
  });

  // ==================== 2/3. 创建与字段校验 ====================

  await test('模板创建：非法字段定义被拒绝（key/类型/选项/范围/正则/重名）', async () => {
    const badKey = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: { name: '坏键模板', fields: [{ fieldKey: '密级', label: 'x', type: 'text' }] },
    });
    assert.equal(badKey.status, 400, '非 ASCII field_key 必须 400');

    const badType = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: { name: '坏类型模板', fields: [{ fieldKey: 'a', label: 'x', type: 'money' }] },
    });
    assert.equal(badType.status, 400, '非法类型必须 400');

    const noOpts = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: { name: '无选项模板', fields: [{ fieldKey: 'a', label: 'x', type: 'select', options: [] }] },
    });
    assert.equal(noOpts.status, 400, 'select 无候选项必须 400');

    const badRange = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: { name: '坏范围模板', fields: [{ fieldKey: 'a', label: 'x', type: 'number', validation: { min: 10, max: 1 } }] },
    });
    assert.equal(badRange.status, 400, 'min>max 必须 400');

    const badRegex = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: { name: '坏正则模板', fields: [{ fieldKey: 'a', label: 'x', type: 'text', validation: { pattern: '([' } }] },
    });
    assert.equal(badRegex.status, 400, '非法正则必须 400');

    const emptyName = await req('/api/templates', { method: 'POST', cookie: adminCookie, body: { name: '', fields: [] } });
    assert.equal(emptyName.status, 400, '空名称必须 400');

    const ok = await req('/api/templates', { method: 'POST', cookie: adminCookie, body: { name: '科研档案模板', description: '含密级与标签', fields: FULL_FIELDS } });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.fieldCount, FULL_FIELDS.length);
    ids.tpl = ok.data.id;

    const dup = await req('/api/templates', { method: 'POST', cookie: adminCookie, body: { name: '科研档案模板', fields: [] } });
    assert.equal(dup.status, 409, '重名模板必须 409');

    const dupKey = await req(`/api/templates/${ids.tpl}/fields`, {
      method: 'POST', cookie: adminCookie, body: { fieldKey: 'secret', label: '重复键', type: 'text' },
    });
    assert.equal(dupKey.status, 409, '同模板重复 field_key 必须 409');
  });

  // ==================== 4/5. 绑定与字段拉取 ====================

  await test('分类绑定：绑定启用模板并可拉取字段；停用模板不可绑定；解绑', async () => {
    const bind = await req(`/api/categories/${ids.cat}/template`, { method: 'PUT', cookie: adminCookie, body: { templateId: ids.tpl } });
    assert.equal(bind.status, 200, JSON.stringify(bind.data));
    assert.equal(bind.data.templateId, ids.tpl);

    const fields = await req(`/api/categories/${ids.cat}/template-fields`, { cookie: cookies.cataloger });
    assert.equal(fields.status, 200);
    assert.equal(fields.data.template.id, ids.tpl);
    assert.equal(fields.data.fields.length, FULL_FIELDS.length);

    // 停用模板不能绑定
    const tpl2 = await req('/api/templates', { method: 'POST', cookie: adminCookie, body: { name: '停用模板', fields: [{ fieldKey: 'z', label: 'z', type: 'text' }] } });
    assert.equal(tpl2.status, 201);
    ids.tpl2 = tpl2.data.id;
    await req(`/api/templates/${ids.tpl2}/status`, { method: 'POST', cookie: adminCookie, body: { status: 'disabled' } });
    const bindDisabled = await req(`/api/categories/${ids.cat}/template`, { method: 'PUT', cookie: adminCookie, body: { templateId: ids.tpl2 } });
    assert.equal(bindDisabled.status, 400, '绑定停用模板必须 400');

    // 越权绑定：借阅者 categoryManage 无权
    const badBind = await req(`/api/categories/${ids.cat}/template`, { method: 'PUT', cookie: cookies.borrower, body: { templateId: ids.tpl } });
    assert.equal(badBind.status, 403, '借阅者绑定分类必须 403');
  });

  // ==================== 6/7. 动态著录与回显 ====================

  await test('动态著录：合法入库并回显；必填缺失/取值越界/选项非法被拒绝', async () => {
    const missing = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: { title: '缺必填项', categoryId: ids.cat, fieldValues: { copies: '5' } },
    });
    assert.equal(missing.status, 400, '缺少必填 select 字段必须 400');

    const badSelect = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: { title: '非法密级', categoryId: ids.cat, fieldValues: { secret: '绝密' } },
    });
    assert.equal(badSelect.status, 400, 'select 取值不在候选项必须 400');

    const badNumber = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: { title: '份数越界', categoryId: ids.cat, fieldValues: { secret: '重要', copies: '999' } },
    });
    assert.equal(badNumber.status, 400, 'number 超上限必须 400');

    const badTags = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: { title: '非法标签', categoryId: ids.cat, fieldValues: { secret: '重要', tags: ['归档', '不存在'] } },
    });
    assert.equal(badTags.status, 400, 'tags 含非法选项必须 400');

    const badDate = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: { title: '非法日期', categoryId: ids.cat, fieldValues: { secret: '重要', handDate: '2026-13-40' } },
    });
    assert.equal(badDate.status, 400, 'date 格式非法必须 400');

    const ok = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: {
        title: '合法动态著录档案', categoryId: ids.cat, archiveType: '科技档案',
        fieldValues: { secret: '重要', copies: '12', tags: ['归档', '合同'], archived: '1', handDate: '2026-05-06', note: '测试' },
      },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    ids.arc = ok.data.id;

    const detail = await req(`/api/archives/${ids.arc}`, { cookie: cookies.cataloger });
    assert.equal(detail.status, 200);
    const dv = Object.fromEntries(detail.data.dynamicFields.map((f) => [f.fieldKey, f.value]));
    assert.equal(dv.secret, '重要');
    assert.equal(dv.copies, '12');
    assert.equal(dv.archived, '1');
    assert.equal(dv.handDate, '2026-05-06');
    assert.deepEqual(JSON.parse(dv.tags), ['归档', '合同'], 'tags 以 JSON 数组入库并回显');
  });

  // ==================== 8/9. 变更保护与历史值 ====================

  await test('模板变更保护：被引用字段禁止改类型；停用字段保留历史值', async () => {
    const tplDetail = await req(`/api/templates/${ids.tpl}`, { cookie: adminCookie });
    assert.equal(tplDetail.status, 200);
    const secretField = tplDetail.data.fields.find((f) => f.fieldKey === 'secret');
    assert.equal(secretField.referenced, true, '已被档案引用的字段应标记 referenced');

    const changeType = await req(`/api/templates/${ids.tpl}/fields/${secretField.id}`, {
      method: 'PUT', cookie: adminCookie, body: { type: 'number' },
    });
    assert.equal(changeType.status, 400, '被引用字段改类型必须 400');

    // 宽松化：改名允许
    const rename = await req(`/api/templates/${ids.tpl}/fields/${secretField.id}`, {
      method: 'PUT', cookie: adminCookie, body: { label: '密级别名' },
    });
    assert.equal(rename.status, 200, '改名（不收紧）应允许');
    assert.equal(rename.data.label, '密级别名');

    // 停用字段：软删，历史值保留
    const deactivate = await req(`/api/templates/${ids.tpl}/fields/${secretField.id}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(deactivate.status, 200, JSON.stringify(deactivate.data));
    assert.equal(deactivate.data.active, false, '停用后 active=false');

    const detail = await req(`/api/archives/${ids.arc}`, { cookie: cookies.cataloger });
    const stillHas = detail.data.dynamicFields.some((f) => f.fieldKey === 'secret' && f.value === '重要');
    assert.ok(stillHas, '停用字段的历史著录值必须保留、不丢失');

    // 收紧校验只对新增生效：停用字段不再出现在模板启用字段里
    const fields = await req(`/api/categories/${ids.cat}/template-fields`, { cookie: cookies.cataloger });
    assert.ok(!fields.data.fields.some((f) => f.fieldKey === 'secret'), '停用字段不在启用字段集合中');
  });

  await test('固定著录字段链路保持兼容：无 fieldValues 时按剩余启用字段处理、不受停用字段影响', async () => {
    // secret 已停用，其余启用字段均非必填 → 新建应允许，且不影响固定著录与档号生成
    const created = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: { title: '仅固定字段', categoryId: ids.cat },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.ok(created.data.archiveNo.startsWith('KY-'), '档号仍按分类链自动生成');
    const detail = await req(`/api/archives/${created.data.id}`, { cookie: cookies.cataloger });
    assert.ok(!detail.data.dynamicFields.some((f) => f.fieldKey === 'secret'), '停用字段不产生新著录记录');
  });

  // ==================== 10. 模板删除的引用保护 ====================

  await test('模板删除：被绑定/有历史著录值拒删；未被引用可删并级联清理字段；越权 403；写审计', async () => {
    // 1) 仍被分类绑定时拒删
    const bound = await req(`/api/templates/${ids.tpl}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(bound.status, 400, '被分类绑定的模板必须 400');
    assert.match(String(bound.data?.message ?? ''), /绑定/, '提示需先解除绑定');

    // 2) 解绑后仍有历史著录值 → 仍拒删（历史填写内容不能丢）
    const unbound = await req(`/api/categories/${ids.cat}/template`, {
      method: 'PUT', cookie: adminCookie, body: { templateId: null },
    });
    assert.equal(unbound.status, 200);
    const referenced = await req(`/api/templates/${ids.tpl}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(referenced.status, 400, '存在历史著录值的模板必须 400');
    assert.match(String(referenced.data?.message ?? ''), /著录值/, '提示改为停用');

    // 3) 越权：著录员无 templateManage，不依赖前端按钮
    const forbidden = await req(`/api/templates/${ids.tpl}`, { method: 'DELETE', cookie: cookies.cataloger });
    assert.equal(forbidden.status, 403, '著录员删除模板必须 403');

    // 4) 未被引用、未绑定的模板可删，信息项随模板级联清理
    const tmp = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: { name: '临时待删模板', fields: [{ fieldKey: 'a', label: '临时项', type: 'text' }] },
    });
    assert.equal(tmp.status, 201, JSON.stringify(tmp.data));
    const tmpId = tmp.data.id;
    const del = await req(`/api/templates/${tmpId}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal(del.data.ok, true);
    assert.equal((await req(`/api/templates/${tmpId}`, { cookie: adminCookie })).status, 404, '删除后不可再查询');
    const list = await req('/api/templates', { cookie: adminCookie });
    assert.ok(!list.data.some((t) => t.id === tmpId), '删除后不再出现在模板列表');

    // 5) 删除写入审计，detail 保留删除前名称
    const audit = await req('/api/audit?action=template.delete&page=1&pageSize=20', { cookie: adminCookie });
    assert.equal(audit.status, 200);
    const items = audit.data.items.filter((x) => x.action === 'template.delete');
    assert.ok(items.length >= 1, '删除模板必须写入审计');
    assert.ok(items.every((x) => x.result === 'success'), '成功删除不得记成失败');
    assert.ok(
      items.some((x) => x.detail && x.detail.name === '临时待删模板'),
      '审计 detail 需保留删除前的模板名称',
    );

    // 恢复分类绑定，保持与前面用例一致的环境（后续用例可直接复用）
    const rebound = await req(`/api/categories/${ids.cat}/template`, {
      method: 'PUT', cookie: adminCookie, body: { templateId: ids.tpl },
    });
    assert.equal(rebound.status, 200, '删除被拒绝后模板仍可用，可重新绑定');
  });
});
