/**
 * 审计日志查询接口（阶段二第五批 · 功能一）。
 * 全部经 SessionGuard + PermissionGuard，权限点 auditView（仅管理员）。
 * 查询由后端 SQL 执行（按操作人 / 动作 / 时间范围 / 对象 + 分页），不接受客户端伪造操作人。
 */
import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SessionGuard, PermissionGuard, Perm } from '../auth/guards';
import { AuditService } from './audit.service';
import { AuditItemPage, AuditQuery } from './audit.types';
import { AUDIT_ACTION } from './audit.types';
import { AUDIT_ACTION_LABELS } from './audit.presentation';

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

@UseGuards(SessionGuard, PermissionGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** 分页查询审计记录（后端执行过滤，非前端二次筛选；返回附中文业务说明）。 */
  @Get()
  @Perm('auditView')
  list(
    @Query('actorUserId') actorUserId?: string,
    @Query('actorName') actorName?: string,
    @Query('action') action?: string,
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): AuditItemPage {
    const q: AuditQuery = {
      actorUserId: parseId(actorUserId, '操作人'),
      actorName: trimOpt(actorName),
      action: trimOpt(action),
      objectType: trimOpt(objectType),
      objectId: trimOpt(objectId),
      from: parseTime(from, '起始时间'),
      to: parseTime(to, '截止时间'),
      page: positiveInt(page, 1, '页码'),
      pageSize: Math.min(positiveInt(pageSize, 20, '每页数量'), 100),
    };
    return this.audit.query(q);
  }

  /**
   * 返回可选动作常量（供前端筛选下拉，避免用户手输动作串）及其中文名。
   * labels 与列表行的 actionLabel 同源，避免下拉与列表出现中英文不一致。
   */
  @Get('actions')
  @Perm('auditView')
  actions(): { actions: string[]; labels: Record<string, string> } {
    return { actions: Object.values(AUDIT_ACTION), labels: AUDIT_ACTION_LABELS };
  }
}

function trimOpt(v: string | undefined): string | undefined {
  const s = String(v ?? '').trim();
  return s ? s : undefined;
}

function parseId(v: string | undefined, label: string): number | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${label}参数不合法`);
  return n;
}

function parseTime(v: string | undefined, label: string): string | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  if (!ISO_RE.test(s)) throw new BadRequestException(`${label}格式需为 YYYY-MM-DD 或 ISO 时间`);
  return s;
}

function positiveInt(v: string | undefined, fallback: number, label: string): number {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${label}参数不合法`);
  return n;
}
