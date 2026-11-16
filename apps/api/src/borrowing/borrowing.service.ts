/**
 * 借阅业务服务（阶段二第四批 · 功能三/四/五）。
 * 闭环：发起申请 → 审核（通过/拒绝）→ 通过后建立档案级受控借阅授权 → 归还/到期失效。
 * 一致性：申请、审批、授权均在写事务内完成；重复/并发审批通过条件更新（status='pending'）拦截。
 * 权限：审核角色由控制器守卫（borrowReview）落实；本层对归属、状态与有效期做二次复核。
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SqliteTransaction } from '../db/transaction';
import { ArchiveRepository, BorrowCatalogItem } from '../archives/archive.repositories';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { ROLE_ADMIN, UserView } from '../common/roles';
import { hasPermission } from '../common/permissions';
import {
  BorrowGrantRepository,
  BorrowRequestRepository,
  BorrowRequestRow,
  BorrowStatus,
} from './borrowing.repositories';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, AUDIT_OBJECT, AuditAction, AuditEvent } from '../audit/audit.types';

export type BorrowScope = 'view' | 'download';

export interface BorrowRequestView {
  id: number;
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  applicantId: number;
  applicantName: string;
  purpose: string;
  days: number;
  startAt: string | null;
  dueAt: string | null;
  status: BorrowStatus;
  statusLabel: string;
  reviewNote: string;
  reviewerName: string | null;
  reviewedAt: string | null;
  createdAt: string;
  canReturn: boolean;
}

const STATUS_LABELS: Record<BorrowStatus, string> = {
  pending: '待审核',
  approved: '已批准（借阅中）',
  rejected: '已拒绝',
  returned: '已归还',
  expired: '已过期',
  cancelled: '已取消',
};

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

@Injectable()
export class BorrowingService {
  constructor(
    @Inject(BorrowRequestRepository) private readonly requests: BorrowRequestRepository,
    @Inject(BorrowGrantRepository) private readonly grants: BorrowGrantRepository,
    @Inject(ArchiveRepository) private readonly archives: ArchiveRepository,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 借阅目录：受限且未授权的档案（仅目录级信息）。 */
  borrowableCatalog(viewer: UserView): BorrowCatalogItem[] {
    return this.archives.listBorrowCatalog(viewer.id);
  }

  createRequest(
    input: { archiveId?: number; purpose?: string; days?: number },
    applicant: UserView,
  ): BorrowRequestView {
    const archiveId = Number(input.archiveId);
    if (!Number.isInteger(archiveId) || archiveId <= 0) throw new BadRequestException('请选择要借阅的档案');
    const archive = this.archives.findById(archiveId);
    if (!archive) throw new NotFoundException('档案不存在');

    const purpose = String(input.purpose ?? '').trim();
    if (!purpose || purpose.length > 500) throw new BadRequestException('借阅用途需为 1-500 个字符');
    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new BadRequestException('借阅期限需为 1-90 天');
    }

    // 事务内查重 + 插入：杜绝并发下产生两条待处理申请（另有部分唯一索引兜底）。
    return this.tx.run(() => {
      const pending = this.requests.findPending(archiveId, applicant.id);
      if (pending) throw new ConflictException('您对该档案已有待处理的借阅申请，请等待审核');
      const created = this.requests.insert({
        archiveId,
        applicantId: applicant.id,
        purpose,
        days,
      });
      this.audit.logTx(
        this.event(applicant, AUDIT_ACTION.BORROW_REQUEST, created.id, {
          archiveId,
          archiveNo: created.archiveNo,
          days,
        }),
      );
      return this.toView(created, applicant);
    });
  }

  listMine(applicant: UserView): BorrowRequestView[] {
    return this.requests.listByApplicant(applicant.id).map((r) => this.toView(r, applicant));
  }

  /** 审核视图：待处理或全部已处理记录（控制器已按 borrowReview 守卫）。 */
  listForReview(status: 'pending' | 'processed' | ''): BorrowRequestView[] {
    if (status === 'pending') {
      return this.requests.listByStatus('pending').map((r) => this.toView(r, null));
    }
    const all = this.requests.listByStatus('');
    return all.filter((r) => r.status !== 'pending').map((r) => this.toView(r, null));
  }

  /** Agent 统一检索专用只读查询：普通角色仅本人，审核角色按审核视角查询；身份绝不来自请求参数。 */
  searchForAgent(
    input: { keyword?: string; status?: string; from?: string; to?: string; scope?: 'mine' | 'review'; page: number; pageSize: number },
    viewer: UserView,
  ): { items: BorrowRequestView[]; total: number; scope: 'mine' | 'review' } {
    const canRequest = hasPermission(viewer.role, 'borrowRequest');
    const canReview = hasPermission(viewer.role, 'borrowReview');
    if (!canRequest && !canReview) throw new ForbiddenException('当前角色无权检索借阅记录');
    const statuses: BorrowStatus[] = ['pending', 'approved', 'rejected', 'returned', 'expired', 'cancelled'];
    const status = statuses.includes(input.status as BorrowStatus) ? (input.status as BorrowStatus) : undefined;
    if (input.scope === 'review' && !canReview) throw new ForbiddenException('当前角色无权查看他人的借阅申请');
    const scope = input.scope ?? (canReview ? 'review' : 'mine');
    const page = this.requests.search({
      applicantId: scope === 'review' ? undefined : viewer.id,
      status,
      keyword: input.keyword,
      from: input.from,
      to: input.to,
      page: input.page,
      pageSize: input.pageSize,
    });
    return { items: page.items.map((row) => this.toView(row, viewer)), total: page.total, scope };
  }

  /** Read-only detail; no client/model applicantId is accepted. */
  detailForAgent(id: number, viewer: UserView): BorrowRequestView {
    if (!hasPermission(viewer.role, 'borrowRequest')) throw new ForbiddenException('当前角色无权查看借阅记录');
    const row = this.requireRequest(id);
    if (row.applicantId !== viewer.id && !hasPermission(viewer.role, 'borrowReview')) throw new ForbiddenException('只能查看本人的借阅记录');
    return this.toView(row, viewer);
  }

  approve(id: number, reviewer: UserView, note: string): BorrowRequestView {
    return this.tx.run(() => {
      const req = this.requireRequest(id);
      this.assertNotApplicant(req, reviewer);
      if (req.status !== 'pending') throw new ConflictException('该申请已处理，不能重复审批');
      const now = new Date().toISOString();
      const dueAt = daysFromNow(req.days);
      // 条件更新（status='pending'）失败 = 并发已被他人处理。
      const ok = this.requests.transition(req.id, 'pending', {
        status: 'approved',
        reviewerId: reviewer.id,
        reviewedAt: now,
        reviewNote: note,
        startAt: now,
        dueAt,
      });
      if (!ok) throw new ConflictException('该申请已被处理，请刷新后查看');
      // 同事务建立档案级受控借阅授权（view + download）。
      this.grants.insert({
        borrowId: req.id,
        archiveId: req.archiveId,
        userId: req.applicantId,
        canView: 1,
        canDownload: 1,
        expiresAt: dueAt,
      });
      this.audit.logTx(
        this.event(reviewer, AUDIT_ACTION.BORROW_APPROVE, req.id, {
          archiveId: req.archiveId,
          applicantId: req.applicantId,
          dueAt,
        }),
      );
      return this.toView(this.requests.findById(req.id)!, reviewer);
    });
  }

  reject(id: number, reviewer: UserView, note: string): BorrowRequestView {
    return this.tx.run(() => {
      const req = this.requireRequest(id);
      this.assertNotApplicant(req, reviewer);
      if (req.status !== 'pending') throw new ConflictException('该申请已处理，不能重复审批');
      const ok = this.requests.transition(req.id, 'pending', {
        status: 'rejected',
        reviewerId: reviewer.id,
        reviewedAt: new Date().toISOString(),
        reviewNote: note,
      });
      if (!ok) throw new ConflictException('该申请已被处理，请刷新后查看');
      this.audit.logTx(
        this.event(reviewer, AUDIT_ACTION.BORROW_REJECT, req.id, {
          archiveId: req.archiveId,
          applicantId: req.applicantId,
        }),
      );
      return this.toView(this.requests.findById(req.id)!, reviewer);
    });
  }

  /** 归还：申请人本人或管理员；置请求 returned 并撤销授权，此后受限下载立即失效。 */
  returnBorrow(id: number, user: UserView): BorrowRequestView {
    return this.tx.run(() => {
      const req = this.requireRequest(id);
      if (user.role !== ROLE_ADMIN && req.applicantId !== user.id) {
        throw new ForbiddenException('只能归还本人的借阅申请');
      }
      if (req.status !== 'approved') throw new BadRequestException('仅借阅中的申请可归还');
      const ok = this.requests.transition(req.id, 'approved', { status: 'returned' });
      if (!ok) throw new ConflictException('借阅状态已变更，请刷新后重试');
      this.grants.setStatusByBorrow(req.id, 'returned');
      this.audit.logTx(
        this.event(user, AUDIT_ACTION.BORROW_RETURN, req.id, {
          archiveId: req.archiveId,
          applicantId: req.applicantId,
        }),
      );
      return this.toView(this.requests.findById(req.id)!, user);
    });
  }

  private requireRequest(id: number): BorrowRequestRow {
    const req = this.requests.findById(id);
    if (!req) throw new NotFoundException('借阅申请不存在');
    return req;
  }

  /** 借阅事件一律在业务事务内以 logTx 落库，成功审计与状态变更原子提交。 */
  private event(
    actor: UserView,
    action: AuditAction,
    borrowId: number,
    detail: Record<string, unknown>,
  ): AuditEvent {
    return {
      actorUserId: actor.id,
      actorRole: actor.role,
      action,
      objectType: AUDIT_OBJECT.BORROW,
      objectId: borrowId,
      result: 'success',
      detail,
      ip: null,
    };
  }

  /** 申请人不得自助把自己的申请改为已批准/已拒绝。 */
  private assertNotApplicant(req: BorrowRequestRow, reviewer: UserView): void {
    if (req.applicantId === reviewer.id) {
      throw new ForbiddenException('不能审核本人提交的借阅申请');
    }
  }

  private toView(row: BorrowRequestRow, actor: UserView | null): BorrowRequestView {
    return {
      id: row.id,
      archiveId: row.archiveId,
      archiveTitle: row.archiveTitle ?? '（档案已删除）',
      archiveNo: row.archiveNo ?? '',
      applicantId: row.applicantId,
      applicantName: row.applicantName ?? '未知用户',
      purpose: row.purpose,
      days: row.days,
      startAt: row.startAt,
      dueAt: row.dueAt,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] ?? row.status,
      reviewNote: row.reviewNote,
      reviewerName: row.reviewerName ?? null,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      canReturn:
        row.status === 'approved' &&
        (!!actor && (actor.role === ROLE_ADMIN || actor.id === row.applicantId)),
    };
  }
}
