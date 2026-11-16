/**
 * 档案级访问控制服务（阶段二第四批）。
 * 唯一权威的「能否查看 / 下载 / 编辑某档案」判定入口，所有业务接口统一复用；
 * 前端隐藏按钮不作为安全控制，未授权一律后端 403。
 *
 * 模型（受限标记 + 借阅授权）：
 * - public 档案：沿用角色矩阵（archiveView / fileDownload / archiveManage）；
 * - restricted 档案：仅管理员、创建者本人，或持有未过期 active 借阅授权者可访问；
 * - 借阅授权撤销 / 到期后（findActive 惰性置 expired），受限档案访问立即关闭。
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ArchiveRepository, ArchiveRow } from './archive.repositories';
import { BorrowGrantRepository } from '../borrowing/borrowing.repositories';
import { ROLE_ADMIN, UserView } from '../common/roles';
import { PermKey, hasPermission } from '../common/permissions';

@Injectable()
export class ArchiveAccessService {
  constructor(
    @Inject(ArchiveRepository) private readonly archives: ArchiveRepository,
    @Inject(BorrowGrantRepository) private readonly grants: BorrowGrantRepository,
  ) {}

  /** 查看权限：见文件头模型说明。 */
  canView(user: UserView, archive: ArchiveRow): boolean {
    if (user.role === ROLE_ADMIN) return true;
    if (!hasPermission(user.role, 'archiveView')) return false;
    if (archive.accessLevel === 'public') return true;
    if (archive.createdBy === user.id) return true;
    const grant = this.grants.findActive(user.id, archive.id);
    return !!grant && grant.canView === 1;
  }

  /** 下载权限：先过查看，再按 public 角色矩阵 / restricted 借阅授权（can_download）判定。 */
  canDownload(user: UserView, archive: ArchiveRow): boolean {
    if (!this.canView(user, archive)) return false;
    if (user.role === ROLE_ADMIN) return true;
    if (archive.createdBy === user.id) return true;
    if (!hasPermission(user.role, 'fileDownload')) return false;
    if (archive.accessLevel === 'public') return true;
    const grant = this.grants.findActive(user.id, archive.id);
    return !!grant && grant.canDownload === 1;
  }

  /**
   * 编辑/著录前置：在角色矩阵之外，还必须通过查看权限（受限档案非授权者不能编辑），
   * 且仅创建者本人或管理员可编辑（与第三批 JitWord 建档者归属一致）。
   */
  canEdit(user: UserView, archive: ArchiveRow, perm: PermKey): boolean {
    if (!hasPermission(user.role, perm)) return false;
    if (user.role === ROLE_ADMIN) return true;
    if (!this.canView(user, archive)) return false;
    return archive.createdBy === user.id;
  }

  /** 断言可查看，否则明确 403（不返回任何档案内容）。 */
  assertView(user: UserView, archive: ArchiveRow): void {
    if (!this.canView(user, archive)) {
      throw new ForbiddenException('无权访问该档案，如需查阅请发起借阅申请');
    }
  }

  /** 断言可下载，否则明确 403。 */
  assertDownload(user: UserView, archive: ArchiveRow): void {
    if (!this.canDownload(user, archive)) {
      throw new ForbiddenException('无权下载该档案附件，如需获取请发起借阅申请');
    }
  }

  /** 加载档案（不存在 404），供上层再做访问判定。 */
  loadArchive(id: number): ArchiveRow {
    const row = this.archives.findById(id);
    if (!row) throw new NotFoundException('档案不存在');
    return row;
  }

  /** 当前用户是否持有对该档案的有效借阅授权（用于前端提示与借阅入口）。 */
  activeGrant(user: UserView, archiveId: number) {
    if (user.role === ROLE_ADMIN) return undefined;
    return this.grants.findActive(user.id, archiveId);
  }
}
