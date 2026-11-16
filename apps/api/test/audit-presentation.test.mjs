/**
 * 审计展示层单元测试（node:test，不连库、不写库）。
 *
 * 目的：锁定「操作审计页」把技术字段翻译成中文业务说明的规则，覆盖任务要求的
 * 借阅 / 附件 / 档案 / 用户 / JitWord 等审计类型，并保证：
 *  1. 每个受控动作常量都有中文名（含 file.preview），页面不会直接显示英文常量；
 *  2. 详情为中文业务说明，绝不直接拼出 archiveId / applicantId / dueAt 之类的后端字段名；
 *  3. 业务对象已删除时不编造名称（objectLabel 为 null、objectResolved=false）；
 *  4. 原始字段（action / objectType / objectId / detail）原样保留，追溯能力不变；
 *  5. 时间类信息以 time 片段返回，由浏览器按本地时区渲染（不在服务端硬编码时区）。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.join(__dirname, '..', 'dist', p)).href;

const { describeAudit, AUDIT_ACTION_LABELS, AUDIT_OBJECT_LABELS } = await import(
  dist('audit/audit.presentation.js')
);
const { AUDIT_ACTION, AUDIT_OBJECT } = await import(dist('audit/audit.types.js'));

/** 构造一条原始审计记录（字段与 audit_logs 视图一致）。 */
function row(over = {}) {
  return {
    id: 1,
    actorUserId: 2,
    actorName: '审计管理员',
    actorRole: 'admin',
    action: 'archive.create',
    objectType: 'archive',
    objectId: '9',
    result: 'success',
    detail: {},
    ip: '127.0.0.1',
    createdAt: '2026-10-28T02:00:00.000Z',
    ...over,
  };
}

/** 把描述片段拼成可断言文本（时间片段保留 ISO，便于校验「未在服务端硬编码时区」）。 */
const text = (item) => item.summary.map((p) => (p.kind === 'time' ? `<时间:${p.iso}>` : p.text)).join('');

const ARCHIVE = { title: '某合同', archiveNo: 'HT-2026-001' };

test.describe('审计展示层：中文动作与业务化描述', { concurrency: false }, async () => {
  await test('1. 受控动作常量全部有中文名，且不会回退成英文常量', () => {
    for (const action of Object.values(AUDIT_ACTION)) {
      assert.ok(AUDIT_ACTION_LABELS[action], `动作 ${action} 缺少中文名`);
      assert.notEqual(AUDIT_ACTION_LABELS[action], action, `${action} 中文名不得等于常量`);
      const item = describeAudit(row({ action }), { archive: ARCHIVE });
      assert.equal(item.actionLabel, AUDIT_ACTION_LABELS[action]);
    }
    for (const objectType of Object.values(AUDIT_OBJECT)) {
      assert.ok(AUDIT_OBJECT_LABELS[objectType], `对象类型 ${objectType} 缺少中文名`);
    }
    // file.preview 是本次明确要求补充中文化的动作
    assert.equal(AUDIT_ACTION_LABELS['file.preview'], '在线预览附件');
  });

  await test('2. 借阅通过：批准谁借阅哪份档案、期限与到期时间', () => {
    const detail = { archiveId: 9, applicantId: 5, dueAt: '2026-11-27T02:00:00.000Z' };
    const item = describeAudit(
      row({ action: 'borrow.approve', objectType: 'borrow_request', objectId: '7', detail }),
      {
        archive: ARCHIVE,
        applicant: { username: 'test_borrower', displayName: '借阅者甲' },
        borrow: { days: 30, dueAt: '2026-11-27T02:00:00.000Z' },
      },
    );
    assert.equal(item.actionLabel, '借阅通过');
    assert.equal(item.objectTypeLabel, '借阅申请');
    assert.equal(item.objectLabel, '某合同', '借阅申请的对象应展示对应档案题名');
    assert.equal(item.objectRef, '借阅申请 #7');
    assert.equal(item.objectResolved, true);
    assert.equal(
      text(item),
      '批准 test_borrower 借阅《某合同》，期限 30 天，应于 <时间:2026-11-27T02:00:00.000Z> 前归还',
    );
    assert.ok(!/archiveId|applicantId|dueAt/.test(text(item)), '详情不得出现后端字段名');
    assert.equal(item.detail, detail, '原始 detail 必须原样保留');
    assert.equal(item.objectId, '7');
  });

  await test('3. 借阅申请 / 拒绝 / 归还：均为中文说明', () => {
    const refs = { archive: ARCHIVE, applicant: { username: 'test_borrower', displayName: '借阅者甲' } };
    const request = describeAudit(
      row({ action: 'borrow.request', objectType: 'borrow_request', objectId: '7', detail: { archiveId: 9, archiveNo: 'HT-2026-001', days: 30 } }),
      refs,
    );
    assert.equal(text(request), '申请借阅《某合同》（档号 HT-2026-001），期限 30 天');

    const reject = describeAudit(
      row({ action: 'borrow.reject', objectType: 'borrow_request', objectId: '7', detail: { archiveId: 9, applicantId: 5 } }),
      refs,
    );
    assert.equal(text(reject), '拒绝 test_borrower 对《某合同》的借阅申请');

    const ret = describeAudit(
      row({ action: 'borrow.return', objectType: 'borrow_request', objectId: '7', detail: { archiveId: 9, applicantId: 5 } }),
      refs,
    );
    assert.equal(text(ret), 'test_borrower 归还《某合同》的借阅');
  });

  await test('4. 附件：上传 / 下载 / 在线预览 / 预览被拒', () => {
    const refs = { archive: ARCHIVE, file: { name: '合同扫描件.pdf' } };
    const preview = describeAudit(
      row({
        action: 'file.preview',
        objectType: 'archive_file',
        objectId: '12',
        detail: { archiveId: 9, name: '合同扫描件.pdf', kind: 'pdf' },
      }),
      refs,
    );
    assert.equal(preview.actionLabel, '在线预览附件');
    assert.equal(preview.objectLabel, '合同扫描件.pdf', '附件对象应展示附件名');
    assert.equal(preview.objectRef, '所属档案《某合同》');
    assert.equal(text(preview), '在线预览档案《某合同》的附件《合同扫描件.pdf》（PDF 文档）');

    const denied = describeAudit(
      row({
        action: 'file.preview_denied',
        objectType: 'archive_file',
        objectId: '12',
        result: 'failure',
        detail: { archiveId: 9, denied: true },
      }),
      refs,
    );
    assert.equal(denied.actionLabel, '预览被拒绝');
    assert.equal(text(denied), '尝试在线预览附件《合同扫描件.pdf》，因无该档案的查看权限被拒绝');

    const downloadDenied = describeAudit(
      row({ action: 'file.download', objectType: 'archive_file', objectId: '12', result: 'failure', detail: { archiveId: 9, denied: true } }),
      refs,
    );
    assert.equal(text(downloadDenied), '尝试下载附件《合同扫描件.pdf》，因无该档案的下载权限被拒绝');

    const upload = describeAudit(
      row({ action: 'file.upload', objectType: 'archive_file', objectId: '12', detail: { archiveId: 9, name: '合同扫描件.pdf', size: 1024 } }),
      refs,
    );
    assert.equal(text(upload), '向档案《某合同》上传附件《合同扫描件.pdf》');

    // DOCX 预览（JitWord-Preview SDK 通道）：kind=docx 必须有中文业务名
    const docxRefs = { archive: ARCHIVE, file: { name: '合同正文.docx' } };
    const docxPreview = describeAudit(
      row({
        action: 'file.preview',
        objectType: 'archive_file',
        objectId: '13',
        detail: { archiveId: 9, name: '合同正文.docx', kind: 'docx' },
      }),
      docxRefs,
    );
    assert.equal(text(docxPreview), '在线预览档案《某合同》的附件《合同正文.docx》（Word 文档）');

    // 文件版本预览：对象为「第 N 版」，不谎称为附件
    const versionPreview = describeAudit(
      row({
        action: 'file.preview',
        objectType: 'archive_file_version',
        objectId: '31',
        detail: { archiveId: 9, name: 'HT-2026-001-v1.docx', kind: 'docx', versionNo: 1 },
      }),
      { archive: ARCHIVE, version: { versionNo: 1 } },
    );
    assert.equal(versionPreview.objectLabel, '第 1 版');
    assert.equal(versionPreview.objectRef, '所属档案《某合同》');
    assert.equal(text(versionPreview), '在线预览档案《某合同》的第 1 版文件（Word 文档）');
  });

  await test('5. 档案：创建含档号、归档、访问级别变更', () => {
    const create = describeAudit(
      row({ action: 'archive.create', detail: { archiveNo: 'HT-2026-001', title: '某合同', categoryId: 3, accessLevel: 'public' } }),
      { archive: ARCHIVE },
    );
    assert.equal(create.objectLabel, '某合同');
    assert.equal(create.objectRef, '档号 HT-2026-001');
    assert.equal(text(create), '创建档案《某合同》，档号 HT-2026-001');

    const archived = describeAudit(
      row({ action: 'archive.transition_archived', detail: { archiveNo: 'HT-2026-001', title: '某合同' } }),
      { archive: ARCHIVE },
    );
    assert.equal(text(archived), '将档案《某合同》（档号 HT-2026-001）标记为已归档（此后只读）');

    const access = describeAudit(
      row({ action: 'archive.access_level_change', detail: { from: 'public', to: 'restricted' } }),
      { archive: ARCHIVE },
    );
    assert.ok(text(access).includes('公开'), '访问级别应中文化');
    assert.ok(text(access).includes('受限'), '访问级别应中文化');
    assert.ok(!/public|restricted/.test(text(access)), '详情不得残留英文枚举值');
  });

  await test('5.1 删除档案：对象已不存在时仍用 detail 交代删了什么', () => {
    const item = describeAudit(
      row({
        action: 'archive.delete',
        detail: { title: '旧草稿', archiveNo: 'WS-2026-000012', categoryId: 3, fileCount: 2, versionCount: 1 },
      }),
      {}, // 档案已被删除：展示层无法再解析业务对象
    );
    assert.equal(item.actionLabel, '删除草稿档案');
    assert.equal(item.objectLabel, null, '已删除对象不得编造名称');
    assert.equal(item.objectResolved, false);
    assert.equal(text(item), '删除档案《旧草稿》（档号 WS-2026-000012）及其 2 个附件、1 个文件版本');
    assert.equal(item.detail.fileCount, 2, '原始 detail 必须原样保留');
  });

  await test('6. 用户：创建 / 角色变更 / 启停 / 重置密码均为中文', () => {
    const refs = { user: { username: 'audit_cat', displayName: '著录员甲' } };
    const role = describeAudit(
      row({ action: 'user.role_change', objectType: 'user', objectId: '8', detail: { username: 'audit_cat', from: 'cataloger', to: 'reviewer' } }),
      refs,
    );
    assert.equal(role.objectLabel, 'audit_cat', '用户对象应展示账号');
    assert.equal(role.objectRef, '著录员甲');
    assert.equal(text(role), '将用户 audit_cat 的角色由「著录员」变更为「审核员」');

    const status = describeAudit(
      row({ action: 'user.status_change', objectType: 'user', objectId: '8', detail: { username: 'audit_cat', from: 'active', to: 'disabled' } }),
      refs,
    );
    assert.equal(text(status), '将用户 audit_cat 的状态由「启用」改为「禁用」');

    const created = describeAudit(
      row({ action: 'user.create', objectType: 'user', objectId: '8', detail: { username: 'audit_cat', role: 'cataloger' } }),
      refs,
    );
    assert.equal(text(created), '创建用户 audit_cat，角色为著录员');

    const reset = describeAudit(
      row({ action: 'user.password_reset', objectType: 'user', objectId: '8', detail: { username: 'audit_cat' } }),
      refs,
    );
    assert.equal(text(reset), '重置用户 audit_cat 的登录密码（旧会话已失效）');
    assert.ok(!/password|hash/i.test(JSON.stringify(reset.detail)), '审计详情不得含密码字段');
  });

  await test('7. JitWord：关联文档 / 票据 / 在线保存 / 版本入库', () => {
    const refs = { archive: ARCHIVE, document: { docName: 'contract_001.docx' } };
    const link = describeAudit(
      row({ action: 'jitword.doc_link', objectType: 'archive_document', objectId: '3', detail: { archiveId: 9, docName: 'contract_001.docx' } }),
      refs,
    );
    assert.equal(link.objectLabel, 'contract_001.docx');
    assert.equal(link.objectRef, '所属档案《某合同》');
    assert.equal(text(link), '为档案《某合同》关联在线文档「contract_001.docx」');

    const ticket = describeAudit(
      row({ action: 'jitword.ticket_issue', objectType: 'archive_document', objectId: '3', detail: { archiveId: 9, mode: 'edit', docId: 'doc-1' } }),
      refs,
    );
    assert.equal(text(ticket), '获取在线文档「contract_001.docx」的编辑票据');
    assert.ok(!/ticket|票据原文/.test(JSON.stringify(ticket.summary)), '详情不得出现票据原文');

    const deniedTicket = describeAudit(
      row({ action: 'jitword.ticket_issue', objectType: 'archive_document', objectId: '3', result: 'failure', detail: { archiveId: 9, mode: 'edit', denied: 'not_creator' } }),
      refs,
    );
    assert.equal(text(deniedTicket), '申请在线文档「contract_001.docx」的编辑票据被拒绝：仅在线文档的建档者可申请编辑票据');

    const saved = describeAudit(
      row({ action: 'jitword.doc_saved', objectType: 'archive_document', objectId: '3', detail: { archiveId: 9 } }),
      refs,
    );
    assert.equal(text(saved), '在线保存档案《某合同》的编辑内容');

    const version = describeAudit(
      row({ action: 'jitword.version_commit', objectType: 'archive_file_version', objectId: '21', detail: { archiveId: 9, versionNo: 2, origin: 'jitword_export_reupload' } }),
      { archive: ARCHIVE, version: { versionNo: 2 } },
    );
    assert.equal(version.objectLabel, '第 2 版');
    assert.equal(version.objectRef, '所属档案《某合同》');
    assert.equal(text(version), '将在线编辑成果入库为档案《某合同》的第 2 个文件版本');
  });

  await test('8. 对象已删除：不编造名称，降级为通用说明并标记未解析', () => {
    const item = describeAudit(
      row({ action: 'archive.update', objectType: 'archive', objectId: '999', detail: { categoryId: 3, renumbered: false } }),
      {},
    );
    assert.equal(item.objectLabel, null);
    assert.equal(item.objectResolved, false);
    assert.equal(item.objectTypeLabel, '档案');
    assert.equal(text(item), '编辑相关档案的著录信息');
    assert.ok(!/undefined|null|#999/.test(text(item)), '详情不得拼出后端空值或 ID');
    // 原始追溯字段仍在
    assert.equal(item.objectId, '999');
    assert.equal(item.objectType, 'archive');
  });

  await test('9. 登录失败：对象为尝试登录的账号，原因取自服务端脱敏信息', () => {
    const item = describeAudit(
      row({
        action: 'auth.login_failure',
        objectType: 'auth',
        objectId: 'test_borrower',
        actorUserId: null,
        actorName: null,
        actorRole: null,
        result: 'failure',
        detail: { attemptedUsername: 'test_borrower', reason: '账号或密码错误' },
      }),
      {},
    );
    assert.equal(item.objectLabel, 'test_borrower');
    assert.equal(item.objectTypeLabel, '登录会话');
    assert.equal(text(item), '账号 test_borrower 登录失败（账号或密码错误）');
  });

  await test('10. 未登记的新动作：不编造说明，中文标签回退为常量且技术详情仍可查', () => {
    const item = describeAudit(row({ action: 'future.unknown_action', objectType: 'archive' }), { archive: ARCHIVE });
    assert.equal(item.actionLabel, 'future.unknown_action');
    assert.deepEqual(item.summary, []);
    assert.equal(item.objectTypeLabel, '档案');
    assert.equal(item.action, 'future.unknown_action');
  });
});
