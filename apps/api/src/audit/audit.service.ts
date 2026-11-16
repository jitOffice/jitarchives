/**
 * 审计服务：统一写入入口 + 服务端查询（阶段二第五批 · 功能一）。
 *
 * 一致性说明（如实）：
 * - 审计表与业务表位于同一 SQLite 文件、共享同一连接，因此在开启的事务内，
 *   审计写入与业务写入会随同一 COMMIT 原子落库；
 * - logTx(event) 供「关键状态变更」在业务事务块内调用，失败即抛错回滚（避免业务成功而审计丢失）；
 * - log(event) 供登录、下载等「响应已成事实」的非关键事件做尽力写入，写入失败仅告警不改变业务结果；
 * - 不将「同一库内逻辑独立表」虚称为跨物理库的强一致；也不虚称数据库级法律不可篡改。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditRepository } from './audit.repositories';
import { AuditPresenter } from './audit.presentation';
import {
  AuditAction,
  AuditEvent,
  AuditItemPage,
  AuditObjectType,
  AuditQuery,
  AUDIT_OBJECT,
} from './audit.types';
import { UserView } from '../common/roles';

/** 记录所需的操作人身份（一律来自服务端已校验会话）。 */
export interface AuditActor {
  id: number | null;
  role: string | null;
  ip?: string | null;
}

export function actorFromUser(user: UserView | undefined, ip?: string | null): AuditActor {
  return { id: user?.id ?? null, role: user?.role ?? null, ip: ip ?? null };
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(AuditRepository) private readonly repo: AuditRepository,
    @Inject(AuditPresenter) private readonly presenter: AuditPresenter,
  ) {}

  /** 事务内原子写入：不吞异常，供关键状态变更与业务写入同事务提交。 */
  logTx(event: AuditEvent): void {
    this.repo.insert(event);
  }

  /** 尽力写入：非关键事件（登录成功/失败、下载、退出等），失败仅告警，不影响已完成的业务响应。 */
  log(event: AuditEvent): void {
    try {
      this.repo.insert(event);
    } catch (err) {
      // 审计写入失败绝不改变业务结果，但必须显式告警，便于运维发现审计链路异常。
      console.warn(
        `[audit] 审计写入失败（已忽略，不影响业务结果）: action=${event.action} obj=${event.objectType}#${event.objectId ?? '-'}`,
        (err as Error)?.message ?? err,
      );
    }
  }

  /** 便捷构造：从操作人 + 动作 + 对象生成事件。 */
  record(
    actor: AuditActor,
    action: AuditAction,
    objectType: AuditObjectType,
    objectId: number | string | null,
    detail?: Record<string, unknown>,
    result: 'success' | 'failure' = 'success',
  ): void {
    this.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action,
      objectType,
      objectId,
      result,
      detail: detail ?? {},
      ip: actor.ip ?? null,
    });
  }

  /**
   * 查询审计记录：过滤/分页仍由仓储层 SQL 执行（结果集不变），
   * 仅在返回前为每行附加中文展示字段（对象真实名称、业务化说明）。
   */
  query(q: AuditQuery): AuditItemPage {
    const page = this.repo.query(q);
    return { ...page, items: this.presenter.present(page.items) };
  }

  static readonly OBJECT = AUDIT_OBJECT;
}
