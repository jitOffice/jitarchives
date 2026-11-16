/**
 * 最后一名启用管理员保护 · 仓储层原子性验证（node:test）
 *
 * 为什么单独一个文件：HTTP 层的并发用例受 Node 单线程事件循环影响会被天然串行化，
 * 无法证明“检查与写入”在并发写入下仍然安全；这里直接驱动 SqliteUserRepository，
 * 用两个独立数据库连接（等价于两个进程/两个写事务）验证：
 *  1. 唯一写入入口 updateWithActiveAdminGuard 同时拦住“降级”和“禁用”最后一名启用管理员；
 *  2. 已禁用的管理员不计入可用数量，修改它不会被误拒；
 *  3. 校验失败时不产生任何写入（无部分更新）；
 *  4. 事务内异常整体回滚，不留中间状态，回滚后连接仍可继续使用；
 *  5. 两个连接之间 BEGIN IMMEDIATE 写入互斥：被锁一方无法在“读到旧数量”时写入，
 *     拿到锁后重读会发现只剩 1 名启用管理员并拒绝——竞态窗口在数据库层被消除。
 *
 * 使用独立测试库 storage/test-admin-guard-<pid>.db，绝不触碰正式库。
 * 运行：npm test（根目录，需先 npm run build:api）
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-admin-guard-${process.pid}.db`);

let db = null;
let repo = null;
let openDatabase = null;
let RepositoryClass = null;

/** Windows 下 sqlite 句柄可能未即时释放，清理失败不影响结论（文件名含 pid，不串用）。 */
function safeRm(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* 忽略 EPERM */
  }
}

function cleanupFiles() {
  for (const suffix of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${suffix}`);
}

/** 造一个用户（密码哈希只做占位，本文件不涉及登录）。 */
function mk(username, role, status = 'active') {
  return repo.create({
    username,
    displayName: username,
    passwordHash: 'scrypt$placeholder',
    role,
    status,
  });
}

before(async () => {
  const distDir = path.join(__dirname, '..', 'dist');
  const dbMod = await import(pathToFileURL(path.join(distDir, 'db', 'database.js')).href);
  const repoMod = await import(pathToFileURL(path.join(distDir, 'users', 'user.repository.js')).href);
  openDatabase = dbMod.openDatabase;
  RepositoryClass = repoMod.SqliteUserRepository;
  cleanupFiles();
  db = openDatabase(DB_FILE);
  repo = new RepositoryClass(db);
});

after(() => {
  if (db) db.close();
  cleanupFiles();
});

// 每个用例独立数据（仅作用于本文件的临时测试库）
beforeEach(() => {
  db.exec('DELETE FROM users;');
});

test('用例1：只有 A 为启用管理员时，降级 A 被拒绝且不产生任何写入', () => {
  const a = mk('r1_active_admin', 'admin');
  mk('r1_disabled_admin', 'admin', 'disabled');
  assert.equal(repo.countActiveAdmins(), 1, '已禁用的管理员不得计入可用数量');

  const before = repo.findById(a.id);
  const res = repo.updateWithActiveAdminGuard(a.id, { role: 'cataloger' });
  assert.deepEqual(res, { ok: false, reason: 'last-active-admin' });

  const after = repo.findById(a.id);
  assert.equal(after.role, 'admin', '角色必须保持管理员');
  assert.equal(after.updatedAt, before.updatedAt, '被拒绝时不得写入（updated_at 未变化）');
});

test('用例2：只有 A 为启用管理员时，禁用 A 被拒绝（仓储层本身即拦住，不依赖业务层自禁用规则）', () => {
  const a = mk('r2_active_admin', 'admin');
  const res = repo.updateWithActiveAdminGuard(a.id, { status: 'disabled' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'last-active-admin');
  assert.equal(repo.findById(a.id).status, 'active');
  assert.equal(repo.countActiveAdmins(), 1);
});

test('用例5：已禁用的管理员不计入可用数量，修改其角色不会被误拒', () => {
  const a = mk('r3_active_admin', 'admin');
  const b = mk('r3_disabled_admin', 'admin', 'disabled');
  assert.equal(repo.countActiveAdmins(), 1);

  const res = repo.updateWithActiveAdminGuard(b.id, { role: 'reviewer' });
  assert.equal(res.ok, true, '已禁用管理员不参与保底校验，调整角色应成功');
  assert.equal(res.user.role, 'reviewer');
  assert.equal(repo.countActiveAdmins(), 1);
  assert.equal(repo.findById(a.id).role, 'admin');
});

test('用例3/4：两名启用管理员时，降级/禁用其中一名成功；剩一名后再次操作被拒', () => {
  const a = mk('r4_admin_a', 'admin');
  const b = mk('r4_admin_b', 'admin');

  const demote = repo.updateWithActiveAdminGuard(a.id, { role: 'guest' });
  assert.equal(demote.ok, true);
  assert.equal(demote.user.role, 'guest');
  assert.equal(repo.countActiveAdmins(), 1);

  const disableLast = repo.updateWithActiveAdminGuard(b.id, { status: 'disabled' });
  assert.equal(disableLast.ok, false);
  assert.equal(disableLast.reason, 'last-active-admin');
  assert.equal(repo.findById(b.id).status, 'active');
});

test('用例7/9：事务内异常整体回滚，不留中间状态；回滚后连接仍可用', () => {
  const a = mk('r5_admin_a', 'admin');
  const b = mk('r5_admin_b', 'admin');
  const before = repo.findById(a.id);

  assert.throws(
    () =>
      repo.transaction(() => {
        const ok = repo.updateWithActiveAdminGuard(a.id, { role: 'cataloger' });
        assert.equal(ok.ok, true, '两名启用管理员时事务内降级应通过校验');
        throw new Error('force rollback');
      }),
    /force rollback/,
  );

  const after = repo.findById(a.id);
  assert.equal(after.role, 'admin', '回滚后角色必须恢复');
  assert.equal(after.updatedAt, before.updatedAt, '回滚后不得残留写入时间');
  assert.equal(repo.countActiveAdmins(), 2);

  // 说明连接状态未被破坏：同一仓储可继续开启新的事务
  const again = repo.updateWithActiveAdminGuard(a.id, { role: 'borrower' });
  assert.equal(again.ok, true);
  assert.equal(again.user.role, 'borrower');
  assert.equal(repo.findById(b.id).role, 'admin');
});

test('用例8：两个连接的写入被 BEGIN IMMEDIATE 串行化，被锁一方无法击穿保底约束', () => {
  const a = mk('r6_admin_a', 'admin');
  const b = mk('r6_admin_b', 'admin');
  assert.equal(repo.countActiveAdmins(), 2);

  const other = openDatabase(DB_FILE);
  const repoOther = new RepositoryClass(other);
  try {
    repo.transaction(() => {
      // 连接 1 处于写事务中：连接 2 连 BEGIN IMMEDIATE 都拿不到锁（1ms 内失败，不阻塞、不死锁）
      assert.throws(() => repoOther.transaction(() => {}), /locked|busy/i);
      const res = repo.updateWithActiveAdminGuard(a.id, { role: 'guest' });
      assert.equal(res.ok, true, '事务内 A 仍是 2 名启用管理员之一，可正常降级');
    });

    // 连接 1 已提交（此时只剩 B 一名启用管理员）；连接 2 拿到锁后重新读取数量 → 必须拒绝
    const res = repoOther.updateWithActiveAdminGuard(b.id, { status: 'disabled' });
    assert.deepEqual(res, { ok: false, reason: 'last-active-admin' });
    assert.equal(repo.findById(b.id).status, 'active', '最终仍保留 1 名启用管理员');
    assert.equal(repo.countActiveAdmins(), 1);

    // 连接 2 未被上一次失败污染，仍可正常读写
    const usable = repoOther.transaction(() => repoOther.countActiveAdmins());
    assert.equal(usable, 1);
  } finally {
    other.close();
  }
});
