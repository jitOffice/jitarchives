/**
 * 认证接口：初始化状态 / 管理员初始化 / 登录 / 退出 / 当前用户 / 固定邀请码 + 浏览器指纹注册。
 * 请求与响应均不出现密码哈希；错误密码统一返回 401。
 */
import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SESSION_COOKIE, INVITATION_QR_URL, INVITE_REPLY_KEYWORD } from '../config';
import { UserView } from '../common/roles';
import { AuthService } from './auth.service';
import { CurrentUser, SessionGuard } from './guards';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, AUDIT_OBJECT } from '../audit/audit.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /** 公开：系统是否已初始化管理员。 */
  @Get('status')
  status(): { initialized: boolean } {
    return { initialized: this.auth.isInitialized() };
  }

  /** 公开（仅首次可用）：初始化管理员，完成后直接建立登录会话。 */
  @Post('init-admin')
  initAdmin(
    @Body() body: { username?: string; displayName?: string; email?: string; password?: string },
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ): { user: UserView } {
    const user = this.auth.initAdmin({
      username: body.username ?? '',
      displayName: body.displayName,
      email: body.email,
      password: body.password ?? '',
    });
    // 初始化成功后自动登录，减少一次人工输入
    this.auth.login(user.username, body.password ?? '', res, req.ip);
    this.audit.record(
      { id: user.id, role: user.role, ip: req.ip ?? null },
      AUDIT_ACTION.INIT_ADMIN,
      AUDIT_OBJECT.USER,
      user.id,
      { username: user.username },
    );
    return { user };
  }

  @Post('login')
  login(
    @Body() body: { username?: string; password?: string },
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ): { user: UserView; expiresAt: number } {
    const attempted = (body.username ?? '').trim();
    try {
      const result = this.auth.login(attempted, body.password ?? '', res, req.ip);
      this.audit.record(
        { id: result.user.id, role: result.user.role, ip: req.ip ?? null },
        AUDIT_ACTION.LOGIN,
        AUDIT_OBJECT.AUTH,
        result.user.id,
        { username: result.user.username },
      );
      return { user: result.user, expiresAt: result.session.expiresAt };
    } catch (err) {
      // 失败登录留痕：不记录密码；仅记 attempted 用户名与失败原因（脱敏）
      this.audit.log({
        actorUserId: null,
        actorRole: null,
        action: AUDIT_ACTION.LOGIN_FAILURE,
        objectType: AUDIT_OBJECT.AUTH,
        objectId: attempted || null,
        result: 'failure',
        detail: { attemptedUsername: attempted || '(空)', reason: (err as Error)?.message ?? '认证失败' },
        ip: req.ip ?? null,
      });
      throw err;
    }
  }

  /** 退出：删除服务端会话，原 Cookie 立即失效。 */
  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): { ok: true } {
    const token = req.cookies?.[SESSION_COOKIE];
    const current = this.auth.resolveSessionUser(token);
    this.auth.logout(token, res);
    if (current) {
      this.audit.record(
        { id: current.id, role: current.role, ip: req.ip ?? null },
        AUDIT_ACTION.LOGOUT,
        AUDIT_OBJECT.AUTH,
        current.id,
        { username: current.username },
      );
    }
    return { ok: true } as const;
  }

  /** 受保护：返回当前登录用户（真实后端校验，非前端本地状态）。 */
  @UseGuards(SessionGuard)
  @Get('me')
  me(@CurrentUser() user: UserView): { user: UserView } {
    return { user };
  }

  /** 公开：返回邀请码获取方式（公众号二维码 + 回复关键字）。 */
  @Get('invite-info')
  inviteInfo(): { qrUrl: string; replyKeyword: string } {
    return { qrUrl: INVITATION_QR_URL, replyKeyword: INVITE_REPLY_KEYWORD };
  }

  /** 公开：用户自助注册，固定邀请码 + 浏览器指纹设备限制。 */
  @Post('register')
  register(
    @Body() body: { username?: string; displayName?: string; email?: string; password?: string; invitationCode?: string; fingerprint?: string },
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ): { user: UserView; expiresAt: number } {
    const attempted = (body.username ?? '').trim();
    try {
      const user = this.auth.register({
        username: body.username ?? '',
        displayName: body.displayName,
        email: body.email,
        password: body.password ?? '',
        invitationCode: body.invitationCode ?? '',
        fingerprint: body.fingerprint ?? '',
        ip: req.ip,
      });
      const result = this.auth.login(user.username, body.password ?? '', res, req.ip);
      this.audit.record(
        { id: user.id, role: user.role, ip: req.ip ?? null },
        AUDIT_ACTION.REGISTER,
        AUDIT_OBJECT.USER,
        user.id,
        { username: user.username, email: user.email || undefined },
      );
      return { user: result.user, expiresAt: result.session.expiresAt };
    } catch (err) {
      this.audit.log({
        actorUserId: null,
        actorRole: null,
        action: AUDIT_ACTION.REGISTER_FAILURE,
        objectType: AUDIT_OBJECT.AUTH,
        objectId: attempted || null,
        result: 'failure',
        detail: { attemptedUsername: attempted || '(空)', reason: (err as Error)?.message ?? '注册失败' },
        ip: req.ip ?? null,
      });
      throw err;
    }
  }
}
