/**
 * 设备注册记录数据访问接口 + SQLite 实现。
 * 同一浏览器指纹（HMAC-SHA256 摘要）只能成功注册一次；
 * 由 registration_device_uses.fingerprint_hash 的 UNIQUE 索引在数据库层面兜底防并发。
 */
import { DatabaseSync } from 'node:sqlite';
import { Injectable, Inject } from '@nestjs/common';
import { DATABASE } from '../db/database';

export interface RegistrationDeviceUseRow {
  id: number;
  fingerprintHash: string;
  userId: number;
  createdAt: string;
}

interface DeviceUseDbRow {
  id: number | bigint;
  fingerprint_hash: string;
  user_id: number | bigint;
  created_at: string;
}

function toRow(r: DeviceUseDbRow): RegistrationDeviceUseRow {
  return {
    id: Number(r.id),
    fingerprintHash: r.fingerprint_hash,
    userId: Number(r.user_id),
    createdAt: r.created_at,
  };
}

export abstract class RegistrationDeviceRepository {
  /** 查询指定指纹是否已有成功注册记录。 */
  abstract findByFingerprintHash(hash: string): RegistrationDeviceUseRow | undefined;
  /** 记录一次设备注册（必须在事务内调用）。 */
  abstract recordRegistration(fingerprintHash: string, userId: number): RegistrationDeviceUseRow;
  /** 按用户查询其注册设备记录。 */
  abstract findByUserId(userId: number): RegistrationDeviceUseRow[];
}

@Injectable()
export class SqliteRegistrationDeviceRepository implements RegistrationDeviceRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  findByFingerprintHash(hash: string): RegistrationDeviceUseRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM registration_device_uses WHERE fingerprint_hash = ?')
      .get(hash) as unknown as DeviceUseDbRow | undefined;
    return row ? toRow(row) : undefined;
  }

  recordRegistration(fingerprintHash: string, userId: number): RegistrationDeviceUseRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        'INSERT INTO registration_device_uses (fingerprint_hash, user_id, created_at) VALUES (?, ?, ?)',
      )
      .run(fingerprintHash, userId, now);
    return toRow(
      this.db
        .prepare('SELECT * FROM registration_device_uses WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as unknown as DeviceUseDbRow,
    );
  }

  findByUserId(userId: number): RegistrationDeviceUseRow[] {
    const rows = this.db
      .prepare('SELECT * FROM registration_device_uses WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as unknown as DeviceUseDbRow[];
    return rows.map(toRow);
  }
}
