/**
 * 认证服务：管理员初始化 / 登录 / 会话校验 / 退出 / 固定邀请码 + 浏览器指纹注册。
 * 密码仅以 scrypt 哈希存储；任何返回值都不包含密码或哈希。
 * 注册流程：校验固定邀请码 → 校验指纹 → HMAC 摘要 → 事务内创建用户 + 设备记录。
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { SESSION_COOKIE, SESSION_TTL_MS, REGISTRATION_INVITE_CODE, DEVICE_FINGERPRINT_SECRET } from '../config';
import { ROLE_ADMIN, ROLE_BORROWER, ROLE_LABELS, UserView } from '../common/roles';
import { UserRepository, UserRow } from '../users/user.repository';
import { SessionRepository } from './session.repository';
import { RegistrationDeviceRepository } from './registration-device.repository';
import { hashPassword, verifyPassword } from './password';
import { SqliteTransaction } from '../db/transaction';

export interface LoginResult {
  user: UserView;
  session: { expiresAt: number };
}

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role],
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 登录失败速率限制：同一 IP 在窗口期内最多允许 N 次失败。 */
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 分钟
const LOGIN_RATE_MAX_FAILURES = 10;

/** 注册速率限制：同一 IP 在窗口期内最多 N 次注册。 */
const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000; // 60 分钟
const REGISTER_RATE_MAX = 5;

interface RateEntry {
  count: number;
  firstAttempt: number;
}

@Injectable()
export class AuthService {
  /** 登录失败速率追踪：ip → { count, firstAttempt }。内存级，重启重置。 */
  private loginFailTracker = new Map<string, RateEntry>();
  /** 注册速率追踪：ip → { count, firstAttempt }。内存级，重启重置。 */
  private registerTracker = new Map<string, RateEntry>();

  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(RegistrationDeviceRepository) private readonly devices: RegistrationDeviceRepository,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
  ) {}

  /** 是否已初始化管理员（决定前端展示初始化表单还是登录表单）。 */
  isInitialized(): boolean {
    return this.users.countUsers() > 0;
  }

  /** 管理员初始化：仅系统无任何用户时允许，不预设任何默认账号密码。 */
  initAdmin(input: { username: string; displayName?: string; email?: string; password: string }): UserView {
    if (this.isInitialized()) {
      throw new ConflictException('系统已初始化，不能重复创建管理员');
    }
    const username = this.validateUsername(input.username);
    this.validatePassword(input.password);
    const email = this.validateEmail(input.email);
    const user = this.users.create({
      username,
      displayName: (input.displayName || '').trim() || username,
      email,
      passwordHash: hashPassword(input.password),
      role: ROLE_ADMIN,
    });
    return toUserView(user);
  }

  login(username: string, password: string, res: Response, ip?: string): LoginResult {
    this.sessions.deleteExpired(Date.now());

    // 登录失败速率限制
    const clientIp = ip || 'unknown';
    this.checkLoginRate(clientIp);

    const user = this.users.findByUsername((username || '').trim());
    if (!user || !password || !verifyPassword(password, user.passwordHash)) {
      this.recordLoginFailure(clientIp);
      throw new UnauthorizedException('账号或密码错误');
    }
    if (user.status !== 'active') {
      throw new UnauthorizedException('该账号已被禁用');
    }

    // 登录成功，清除该 IP 的失败计数
    this.loginFailTracker.delete(clientIp);

    const token = randomBytes(32).toString('hex');
    const session = this.sessions.create(token, user.id, SESSION_TTL_MS, ip);
    this.setSessionCookie(res, token, session.expiresAt);
    return { user: toUserView(user), session: { expiresAt: session.expiresAt } };
  }

  logout(token: string | undefined, res: Response): void {
    if (token) this.sessions.delete(token);
    this.clearSessionCookie(res);
  }

  /** 校验会话并返回当前用户；会话不存在/过期/用户被禁用或删号都视为未登录。 */
  resolveSessionUser(token: string | undefined): UserView | undefined {
    if (!token) return undefined;
    const session = this.sessions.find(token);
    if (!session || session.expiresAt <= Date.now()) return undefined;
    const user = this.users.findById(session.userId);
    if (!user || user.status !== 'active') return undefined;
    return toUserView(user);
  }

  /** 用户被禁用/删除后立即踢出其全部会话。 */
  revokeUserSessions(userId: number): void {
    this.sessions.deleteByUser(userId);
  }

  private setSessionCookie(res: Response, token: string, expiresAt: number): void {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
  }

  private clearSessionCookie(res: Response): void {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  validateUsername(raw: string): string {
    const username = (raw || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      throw new BadRequestException('账号需为 3-32 位字母、数字、._- 组合');
    }
    return username;
  }

  validatePassword(password: string): void {
    if (!password || password.length < 6 || password.length > 64) {
      throw new BadRequestException('密码长度需为 6-64 位');
    }
  }

  /** 邮箱校验：可空，非空时必须合法。 */
  validateEmail(rawEmail?: string): string {
    const email = (rawEmail || '').trim();
    if (!email) return '';
    // 基础邮箱格式校验
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }
    if (email.length > 254) {
      throw new BadRequestException('邮箱长度不能超过 254 个字符');
    }
    return email;
  }

  /**
   * 用户自助注册：固定邀请码 + 浏览器指纹设备限制。
   * 流程：
   *  1. 校验用户名、邮箱、密码、固定邀请码；
   *  2. 校验浏览器指纹格式并计算 HMAC-SHA256 摘要；
   *  3. 查询该指纹是否已有注册记录（有则 409）；
   *  4. 事务内原子创建用户 + 设备记录（UNIQUE 索引兜底防并发）。
   */
  register(input: {
    username: string;
    displayName?: string;
    email?: string;
    password: string;
    invitationCode: string;
    fingerprint: string;
    ip?: string;
  }): UserView {
    // 注册速率限制
    const clientIp = input.ip || 'unknown';
    this.checkRegisterRate(clientIp);

    // 1. 校验固定邀请码（严格匹配，忽略首尾空格，不写入日志）
    const code = (input.invitationCode || '').trim();
    if (!code || code !== REGISTRATION_INVITE_CODE) {
      throw new BadRequestException('邀请码不正确，请检查后重试');
    }

    // 2. 校验用户名、密码、邮箱
    const username = this.validateUsername(input.username);
    this.validatePassword(input.password);
    const email = this.validateEmail(input.email);

    // 用户名重复校验
    if (this.users.findByUsername(username)) {
      throw new ConflictException('用户名已存在');
    }

    // 邮箱重复校验（非空时）
    if (email && this.users.findByEmail(email)) {
      throw new ConflictException('邮箱已注册');
    }

    // 3. 校验浏览器指纹并计算 HMAC 摘要
    const fingerprintHash = this.computeFingerprintHash(input.fingerprint);

    // 事务外先检查该指纹是否已注册（快速失败）
    if (this.devices.findByFingerprintHash(fingerprintHash)) {
      throw new ConflictException('激活码已使用，该设备不能重复注册');
    }

    // 4. 事务内原子创建用户 + 设备记录
    const user = this.tx.run(() => {
      // 事务内重新检查（防并发：BEGIN IMMEDIATE 拿写锁后再次确认）
      if (this.devices.findByFingerprintHash(fingerprintHash)) {
        throw new ConflictException('激活码已使用，该设备不能重复注册');
      }

      const created = this.users.create({
        username,
        displayName: (input.displayName || '').trim() || username,
        email,
        passwordHash: hashPassword(input.password),
        role: ROLE_BORROWER,
      });

      // 同一事务内记录设备注册（UNIQUE 索引兜底）
      this.devices.recordRegistration(fingerprintHash, created.id);

      return created;
    });

    // 注册成功，记录速率
    this.recordRegister(clientIp);

    return toUserView(user);
  }

  /**
   * 计算浏览器指纹的 HMAC-SHA256 摘要。
   * 前端传来的 fingerprint 必须是合法的 hex 字符串（32 字节 = 64 hex 字符）。
   * 服务端使用 DEVICE_FINGERPRINT_SECRET 计算摘要，数据库只存摘要。
   */
  private computeFingerprintHash(fingerprint: string): string {
    const fp = (fingerprint || '').trim();
    // 格式校验：FingerprintJS visitorId 为 32 位 hex 字符串
    if (!/^[0-9a-f]{32}$/i.test(fp)) {
      throw new BadRequestException('设备标识格式无效');
    }
    return createHmac('sha256', DEVICE_FINGERPRINT_SECRET).update(fp).digest('hex');
  }

  // ==================== 速率限制 ====================

  private checkLoginRate(ip: string): void {
    const entry = this.loginFailTracker.get(ip);
    if (!entry) return;
    const now = Date.now();
    // 窗口过期重置
    if (now - entry.firstAttempt > LOGIN_RATE_WINDOW_MS) {
      this.loginFailTracker.delete(ip);
      return;
    }
    if (entry.count >= LOGIN_RATE_MAX_FAILURES) {
      const remainMs = LOGIN_RATE_WINDOW_MS - (now - entry.firstAttempt);
      const remainMin = Math.ceil(remainMs / 60000);
      throw new UnauthorizedException(`登录失败次数过多，请 ${remainMin} 分钟后再试`);
    }
  }

  private recordLoginFailure(ip: string): void {
    const now = Date.now();
    const entry = this.loginFailTracker.get(ip);
    if (!entry || now - entry.firstAttempt > LOGIN_RATE_WINDOW_MS) {
      this.loginFailTracker.set(ip, { count: 1, firstAttempt: now });
      return;
    }
    entry.count++;
  }

  private checkRegisterRate(ip: string): void {
    const entry = this.registerTracker.get(ip);
    if (!entry) return;
    const now = Date.now();
    if (now - entry.firstAttempt > REGISTER_RATE_WINDOW_MS) {
      this.registerTracker.delete(ip);
      return;
    }
    if (entry.count >= REGISTER_RATE_MAX) {
      const remainMs = REGISTER_RATE_WINDOW_MS - (now - entry.firstAttempt);
      const remainMin = Math.ceil(remainMs / 60000);
      throw new BadRequestException(`注册频率过高，请 ${remainMin} 分钟后再试`);
    }
  }

  private recordRegister(ip: string): void {
    const now = Date.now();
    const entry = this.registerTracker.get(ip);
    if (!entry || now - entry.firstAttempt > REGISTER_RATE_WINDOW_MS) {
      this.registerTracker.set(ip, { count: 1, firstAttempt: now });
      return;
    }
    entry.count++;
  }
}
