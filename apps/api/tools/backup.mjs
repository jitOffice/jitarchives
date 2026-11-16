#!/usr/bin/env node
/**
 * JitArchives 数据备份工具（阶段二第五批 · 功能二）。
 * 零依赖：仅用 Node 内置 node:sqlite / node:crypto / node:fs / node:path。
 *
 * 一致性策略（如实声明，见输出清单 warnings）：
 *   1) 对运行中的库用 `VACUUM INTO` 生成在线一致性快照（不热复制 .db/.wal/.shm）；
 *   2) 快照后打开副本执行 `PRAGMA integrity_check`，并从副本读取被引用的 stored_name 集合（即 T0 恢复点）；
 *   3) 枚举文件存储目录逐文件复制到备份并计算 SHA-256；
 *   4) 恢复点一致性校验：T0 快照引用的每个 stored_name 必须已在备份中且大小/校验一致，
 *      一旦发现被引用文件缺失 → 整体判定失败（绝不误报成功）并清理半成品目录、非零退出。
 *
 * 局限（写入清单，供运维决策）：在线快照无法保证「DB 与文件系统」严格同一物理瞬间；
 *   备份期间新增/删除并发的文件可能不被 T0 引用（作为 orphan 记录）。生产推荐维护模式/停机备份，
 *   若检测到库文件伴随非空 -wal（疑似有并发写入）会在 warnings 与 stderr 明确告警。
 *
 * 用法：node backup.mjs --db <path> --store <dir> --out <dir>
 * 安全：不覆盖同名既有备份目录；输出不含任何机密值；不删除源数据。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

function fail(msg) {
  console.error(`[backup] 失败：${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
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
  const buf = fs.readFileSync(file);
  hash.update(buf);
  return { sha256: hash.digest('hex'), size: buf.length };
}

/** 合并所有文件校验值为总校验和（排序后逐行 "storedName:sha\n" 做 SHA-256，稳定可复现）。 */
function totalChecksum(entries) {
  const hash = createHash('sha256');
  const lines = [...entries]
    .sort((a, b) => (a.storedName < b.storedName ? -1 : 1))
    .map((e) => `${e.storedName}:${e.sha256}\n`);
  for (const line of lines) hash.update(line);
  return hash.digest('hex');
}

function sqlQuote(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = args.db ? path.resolve(String(args.db)) : null;
  const storeDir = args.store ? path.resolve(String(args.store)) : null;
  const outRoot = args.out ? path.resolve(String(args.out)) : null;
  if (!dbPath || !storeDir || !outRoot) {
    fail('缺少参数：需要 --db <path> --store <dir> --out <dir>');
  }
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    fail(`源数据库不存在或不是文件：${dbPath}`);
  }
  if (!fs.existsSync(storeDir) || !fs.statSync(storeDir).isDirectory()) {
    fail(`源文件存储目录不存在或不是目录：${storeDir}`);
  }

  // 生成时间戳命名的备份目录；已存在则拒绝（绝不覆盖既有备份）
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(outRoot, `jitarchives-backup-${ts}`);
  if (fs.existsSync(backupDir)) fail(`备份目标目录已存在，拒绝覆盖：${backupDir}`);
  fs.mkdirSync(outRoot, { recursive: true });
  fs.mkdirSync(backupDir);
  const dbOutDir = path.join(backupDir, 'database');
  const filesOutDir = path.join(backupDir, 'files');
  fs.mkdirSync(dbOutDir);
  fs.mkdirSync(filesOutDir);

  // 失败即清理半成品目录（仅清理本次创建的 backupDir），非零退出
  let stage = 'init';
  const cleanupAndFail = (msg) => {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理异常，保留原始失败信息 */
    }
    fail(`${msg}（阶段：${stage}，已清理半成品目录）`);
  };

  // 并发写入告警：伴随 -wal 非空提示可能有活动写入
  const warnings = [];
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath)) {
    try {
      const walSize = fs.statSync(walPath).size;
      if (walSize > 0) {
        warnings.push(
          `检测到数据库存在非空 WAL 文件（${walSize} 字节），目标服务可能正在写入；` +
            '在线快照不能保证 DB 与文件系统的严格同一瞬间，生产建议进入维护模式/停机后再备份。',
        );
      }
    } catch {
      /* 忽略 stat 异常 */
    }
  }

  // 1) VACUUM INTO 生成一致性快照
  stage = 'vacuum';
  const snapshotPath = path.join(dbOutDir, 'snapshot.db');
  let source;
  try {
    source = new DatabaseSync(dbPath, { readOnly: true });
    source.exec(`VACUUM INTO ${sqlQuote(snapshotPath)}`);
  } catch (err) {
    // 某些 Node 版本对 readOnly 下 VACUUM 可能受限：回退为普通打开（只读意图，不写入源库）
    try {
      source?.close?.();
    } catch {
      /* ignore */
    }
    try {
      source = new DatabaseSync(dbPath);
      source.exec(`VACUUM INTO ${sqlQuote(snapshotPath)}`);
    } catch (err2) {
      cleanupAndFail(`VACUUM INTO 快照失败：${err2?.message ?? err2}`);
    }
  } finally {
    try {
      source?.close?.();
    } catch {
      /* ignore */
    }
  }
  if (!fs.existsSync(snapshotPath)) cleanupAndFail('快照文件未生成');

  // 2) 打开副本：integrity_check + 读取被引用 stored_name + 行数统计
  stage = 'inspect-snapshot';
  const snap = new DatabaseSync(snapshotPath, { readOnly: true });
  let integrity;
  try {
    integrity = snap.prepare('PRAGMA integrity_check').all();
  } catch (err) {
    cleanupAndFail(`快照完整性检查失败：${err?.message ?? err}`);
  }
  const integrityOk =
    Array.isArray(integrity) && integrity.length === 1 && integrity[0]?.integrity_check === 'ok';
  if (!integrityOk) {
    try {
      snap.close();
    } catch {
      /* ignore */
    }
    cleanupAndFail(`快照未通过 PRAGMA integrity_check：${JSON.stringify(integrity)}`);
  }

  const countOf = (table) => {
    try {
      return Number(snap.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
    } catch {
      return null; // 该库未迁移到含此表的版本
    }
  };
  // 被 DB（T0 恢复点）引用的物理文件名 → 引用来源集合
  const referenced = new Map(); // storedName -> Set<'archive_files'|'archive_file_versions'>
  const addRef = (table, name) => {
    if (!name) return;
    if (!referenced.has(name)) referenced.set(name, new Set());
    referenced.get(name).add(table);
  };
  try {
    for (const r of snap.prepare('SELECT stored_name, file_size, sha256 FROM archive_files').all()) {
      addRef('archive_files', r.stored_name);
    }
  } catch {
    /* 表可能不存在（旧库） */
  }
  try {
    for (const r of snap.prepare('SELECT stored_name, file_size, sha256 FROM archive_file_versions').all()) {
      addRef('archive_file_versions', r.stored_name);
    }
  } catch {
    /* 表可能不存在（旧库） */
  }
  // 记录 DB 侧声明的 size/sha（用于备份后一致性核对）
  const dbMeta = new Map(); // storedName -> {size, sha256, tables:[]}
  const collectMeta = (table) => {
    try {
      for (const r of snap.prepare(`SELECT stored_name, file_size, sha256 FROM ${table}`).all()) {
        if (!r.stored_name) continue;
        const cur = dbMeta.get(r.stored_name) ?? { size: r.file_size, sha256: r.sha256, tables: [] };
        cur.tables.push(table);
        dbMeta.set(r.stored_name, cur);
      }
    } catch {
      /* 忽略 */
    }
  };
  collectMeta('archive_files');
  collectMeta('archive_file_versions');

  const counts = {
    archives: countOf('archives'),
    archive_files: countOf('archive_files'),
    archive_file_versions: countOf('archive_file_versions'),
    audit_logs: countOf('audit_logs'),
    referenced_files: referenced.size,
  };
  snap.close();

  // 3) 枚举并复制文件存储目录（逐文件 SHA-256）
  stage = 'copy-files';
  let storeEntries;
  try {
    storeEntries = fs.readdirSync(storeDir, { withFileTypes: true });
  } catch (err) {
    cleanupAndFail(`读取文件存储目录失败：${err?.message ?? err}`);
  }
  const fileEntries = [];
  for (const ent of storeEntries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (name.endsWith('.uploading')) continue; // 跳过仍在上传的临时文件（非正式文件）
    const src = path.join(storeDir, name);
    const dst = path.join(filesOutDir, name);
    let digest;
    try {
      digest = sha256File(src);
      fs.copyFileSync(src, dst);
    } catch (err) {
      // 并发删除：被引用文件缺失即致命；孤儿文件缺失仅记录
      const isReferenced = referenced.has(name);
      if (isReferenced) cleanupAndFail(`复制被引用文件失败（可能在备份期间被删除）：${name}：${err?.message ?? err}`);
      warnings.push(`跳过无法读取的非引用文件：${name}`);
      continue;
    }
    fileEntries.push({
      storedName: name,
      size: digest.size,
      sha256: digest.sha256,
      referenced: referenced.has(name),
      referencedIn: referenced.has(name) ? [...(referenced.get(name) ?? [])] : ['orphan'],
    });
  }

  // 4) 恢复点一致性校验：每个被引用 stored_name 必须已复制且与 DB 元数据匹配
  stage = 'consistency-check';
  const copied = new Map(fileEntries.map((e) => [e.storedName, e]));
  const missing = [];
  const mismatched = [];
  for (const [storedName, meta] of dbMeta) {
    const got = copied.get(storedName);
    if (!got) {
      missing.push(storedName);
      continue;
    }
    // 大小一致即可判定物理文件与登记匹配；sha 仅当 DB 已记录时比对
    if (Number(meta.size) !== Number(got.size)) {
      mismatched.push({ storedName, dbSize: meta.size, diskSize: got.size });
    } else if (meta.sha256 && got.sha256 !== meta.sha256) {
      mismatched.push({ storedName, reason: 'sha256-mismatch' });
    }
  }
  if (missing.length > 0 || mismatched.length > 0) {
    cleanupAndFail(
      `恢复点一致性校验未通过：缺失被引用文件 ${missing.length} 个` +
        (missing.length ? `（${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}）` : '') +
        `；校验不匹配 ${mismatched.length} 个`,
    );
  }

  // 写清单
  stage = 'manifest';
  const manifest = {
    tool: 'jitarchives-backup',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    source: { dbFile: dbPath, storeDir },
    snapshot: { relative: 'database/snapshot.db', integrityCheck: 'ok' },
    counts,
    files: fileEntries,
    referenced: { total: dbMeta.size, missing: [], mismatched: [] },
    totalChecksum: totalChecksum(fileEntries),
    warnings,
  };
  try {
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    cleanupAndFail(`写入清单失败：${err?.message ?? err}`);
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`[backup] 告警：${w}`);
  }
  console.log(
    `[backup] 完成：${backupDir}\n` +
      `  快照 integrity_check=ok；档案=${counts.archives ?? '—'} 附件=${counts.archive_files ?? '—'} ` +
      `版本=${counts.archive_file_versions ?? '—'} 审计=${counts.audit_logs ?? '—'}\n` +
      `  复制文件 ${fileEntries.length} 个（被 DB 引用 ${counts.referenced_files} 个，全部核对存在）；总校验和 ${manifest.totalChecksum.slice(0, 16)}…`,
  );
}

main();
