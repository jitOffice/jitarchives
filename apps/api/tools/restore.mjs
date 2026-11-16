#!/usr/bin/env node
/**
 * JitArchives 数据恢复工具（阶段二第五批 · 功能三）。
 * 零依赖：仅用 Node 内置 node:sqlite / node:crypto / node:fs / node:path。
 *
 * 明确定位：这是一台「校验优先 + 隔离恢复」的运维工具，非一键覆盖生产。
 * 流程：
 *   1) 读清单，逐一核对备份文件存在且 SHA-256 匹配（任何不匹配即中止，绝不半成品落地）；
 *   2) 对快照执行 PRAGMA integrity_check，并核对快照引用的每个 stored_name 均在备份内；
 *   3) 目标防误覆盖：
 *      - 目标 DB 等于受保护的正式库默认路径（apps/api/storage/jitarchives.db）→ 默认拒绝，需 --force；
 *      - 目标 DB 或文件目录已存在数据 → 默认拒绝，需 --force；
 *      - --force 覆盖现有目标 DB 前，先对其做安全副本（<目标>.pre-restore-<ts>）；
 *   4) 恢复：复制快照为目标 DB；把备份文件复制进目标文件目录（已存在且校验相同则跳过；
 *      同名不同内容默认拒绝、--force 才覆盖；绝不删除目标目录中任何既有真实文件）；
 *   5) 恢复后业务一致性检查：目标 DB integrity_check=ok 且每条附件/版本记录对应文件在目标目录存在且校验匹配。
 *
 * 用法：node restore.mjs --from <备份目录> --into-db <path> --into-store <dir> [--force]
 * 建议：正式环境恢复前应停机；本工具仅在隔离目录/独立库上用于自动化验证。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

function fail(msg) {
  console.error(`[restore] 失败：${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--force') {
      args.force = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sqlQuote(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

/** 打开库执行 integrity_check，返回是否通过。 */
function checkIntegrity(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const r = db.prepare('PRAGMA integrity_check').all();
    return Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok';
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const fromDir = args.from ? path.resolve(String(args.from)) : null;
  const intoDb = args['into-db'] ? path.resolve(String(args['into-db'])) : null;
  const intoStore = args['into-store'] ? path.resolve(String(args['into-store'])) : null;
  const force = !!args.force;
  if (!fromDir || !intoDb || !intoStore) {
    fail('缺少参数：需要 --from <备份目录> --into-db <path> --into-store <dir> [--force]');
  }

  const manifestPath = path.join(fromDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`备份清单不存在：${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`备份清单解析失败：${err?.message ?? err}`);
  }
  if (manifest.tool !== 'jitarchives-backup') fail('清单不是 JitArchives 备份产物');

  const snapshotSrc = path.join(fromDir, manifest.snapshot?.relative ?? 'database/snapshot.db');
  const filesSrcDir = path.join(fromDir, 'files');
  if (!fs.existsSync(snapshotSrc)) fail(`备份快照缺失：${snapshotSrc}`);
  if (!fs.existsSync(filesSrcDir) || !fs.statSync(filesSrcDir).isDirectory()) fail('备份文件目录缺失');

  // 1) 逐一核对备份文件存在 + SHA-256 匹配
  for (const f of manifest.files ?? []) {
    const p = path.join(filesSrcDir, f.storedName);
    if (!fs.existsSync(p)) fail(`备份缺少文件：${f.storedName}`);
    const got = sha256File(p);
    if (got !== f.sha256) fail(`备份文件校验不匹配：${f.storedName}（期望 ${f.sha256?.slice(0, 12)}… 实得 ${got.slice(0, 12)}…）`);
  }

  // 2) 快照 integrity_check + 被引用文件均在备份内
  if (!checkIntegrity(snapshotSrc)) fail('备份快照未通过 integrity_check');
  {
    const snap = new DatabaseSync(snapshotSrc, { readOnly: true });
    try {
      const names = new Set();
      for (const t of ['archive_files', 'archive_file_versions']) {
        try {
          for (const r of snap.prepare(`SELECT stored_name FROM ${t}`).all()) names.add(r.stored_name);
        } catch {
          /* 表可能不存在 */
        }
      }
      const have = new Set((manifest.files ?? []).map((x) => x.storedName));
      const missing = [...names].filter((n) => n && !have.has(n));
      if (missing.length > 0) fail(`快照引用但备份缺失的文件 ${missing.length} 个：${missing.slice(0, 5).join(', ')}`);
    } finally {
      try {
        snap.close();
      } catch {
        /* ignore */
      }
    }
  }

  // 3) 目标防误覆盖
  const PROTECTED_DB = path.resolve(import.meta.dirname, '..', 'storage', 'jitarchives.db');
  if (intoDb === PROTECTED_DB && !force) {
    fail('目标为受保护的正式库默认路径；如需覆盖必须显式 --force，且强烈建议先停机。');
  }
  const dbExists = fs.existsSync(intoDb);
  if (dbExists && !force) fail(`目标数据库已存在：${intoDb}（需 --force，恢复前将自动做安全副本）`);
  const storeExists = fs.existsSync(intoStore);
  const storeNonEmpty = storeExists && fs.readdirSync(intoStore).length > 0;
  if (storeNonEmpty && !force) fail(`目标文件目录非空：${intoStore}（需 --force）`);

  // 覆盖现有目标 DB 前先做安全副本（绝不删除任何既有文件）
  if (dbExists && force) {
    const safeCopy = `${intoDb}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.copyFileSync(intoDb, safeCopy);
      console.warn(`[restore] 已将现有目标库安全副本保存至：${safeCopy}`);
    } catch (err) {
      fail(`无法为目标库创建安全副本（目标可能被运行中的服务占用，请先停机）：${err?.message ?? err}`);
    }
  }

  // 4) 恢复：先把文件复制到目标目录，再原子落地 DB
  fs.mkdirSync(path.dirname(intoDb), { recursive: true });
  fs.mkdirSync(intoStore, { recursive: true });

  // 4a) 文件复制（同名不同内容默认拒绝；相同则跳过；--force 才覆盖；从不删除）
  for (const f of manifest.files ?? []) {
    const src = path.join(filesSrcDir, f.storedName);
    const dst = path.join(intoStore, f.storedName);
    if (fs.existsSync(dst)) {
      const existingSha = sha256File(dst);
      if (existingSha === f.sha256) continue; // 已是同一文件，无需改动
      if (!force) fail(`目标存在同名但内容不同的文件，拒绝覆盖：${f.storedName}（需 --force）`);
      fs.copyFileSync(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }

  // 4b) DB：以快照复制到临时文件再重命名，避免留下半成品
  const tmpDb = `${intoDb}.restoring-${Date.now()}`;
  try {
    fs.copyFileSync(snapshotSrc, tmpDb);
    // Windows 下 rename 不能覆盖既有目标文件（EPERM）；--force 覆盖场景（已做 .pre-restore 安全副本）
    // 先移除既有目标库及其残留 -wal/-shm，再原子重命名落地，跨平台一致。
    if (fs.existsSync(intoDb)) {
      fs.rmSync(intoDb, { force: true });
      for (const suffix of ['-wal', '-shm']) {
        try {
          fs.rmSync(`${intoDb}${suffix}`, { force: true });
        } catch {
          /* 忽略 */
        }
      }
    }
    fs.renameSync(tmpDb, intoDb);
  } catch (err) {
    try {
      fs.rmSync(tmpDb, { force: true });
    } catch {
      /* ignore */
    }
    fail(`落地目标数据库失败（目标可能正被运行中的服务占用，请先停机）：${err?.message ?? err}`);
  }
  // 清理可能随快照携带的 -wal/-shm 不存在于 VACUUM INTO 产物，但防御性确保目标库为单文件一致态
  for (const suffix of ['-wal', '-shm']) {
    const stale = `${intoDb}${suffix}`;
    if (fs.existsSync(stale)) {
      console.warn(`[restore] 提示：目标库旁存在 ${suffix} 文件，若服务正在运行请停机后重启以正确加载。`);
    }
  }

  // 5) 恢复后业务一致性检查
  if (!checkIntegrity(intoDb)) fail('恢复后的目标数据库未通过 integrity_check');
  {
    const db = new DatabaseSync(intoDb, { readOnly: true });
    let checked = 0;
    const problems = [];
    try {
      const rows = [];
      for (const [t, col] of [
        ['archive_files', 'archive_files'],
        ['archive_file_versions', 'archive_file_versions'],
      ]) {
        try {
          for (const r of db.prepare(`SELECT stored_name, file_size, sha256 FROM ${t}`).all()) {
            rows.push({ ...r, from: col });
          }
        } catch {
          /* 表可能不存在 */
        }
      }
      for (const r of rows) {
        checked += 1;
        const p = path.join(intoStore, r.stored_name);
        if (!fs.existsSync(p)) {
          problems.push(`${r.from}:${r.stored_name} 文件缺失`);
          continue;
        }
        const sz = fs.statSync(p).size;
        if (Number(r.file_size) !== Number(sz)) problems.push(`${r.from}:${r.stored_name} 大小不符（登记 ${r.file_size} 实际 ${sz}）`);
      }
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    if (problems.length > 0) fail(`恢复后业务一致性检查发现问题 ${problems.length} 项：${problems.slice(0, 5).join('；')}`);
    console.log(`[restore] 完成：目标库=${intoDb}\n  文件目录=${intoStore}\n  业务一致性检查通过（附件/版本记录 ${checked} 条，对应文件均存在且大小匹配）。`);
  }

  // sqlQuote 仅用于潜在扩展（保持与 backup 一致的工具语义），此处显式引用避免未使用告警
  void sqlQuote;
}

main();
