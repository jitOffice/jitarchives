/**
 * 档案业务基础权限矩阵（PRD 5.4 五级角色的最小落地，补充工程设计）。
 * 说明：
 * - PRD 的档案级/类目级细粒度授权机制尚未实现，本批采用角色级粗粒度规则；
 * - 一律「默认拒绝」：不在允许集合内的角色，后端直接 403，不依赖前端按钮状态；
 * - 借阅者/访客可检索与查看目录级著录信息，但访客不能下载附件原文（安全默认）。
 */
import { ROLE_ADMIN, ROLE_BORROWER, ROLE_CATALOGER, ROLE_GUEST, ROLE_REVIEWER, Role } from './roles';

export const PERM = {
  /** 读取分类目录（含档案数量）。 */
  categoryView: [ROLE_ADMIN, ROLE_CATALOGER, ROLE_REVIEWER, ROLE_BORROWER, ROLE_GUEST],
  /** 创建/修改分类（归档状态约束内的类目维护）。 */
  categoryManage: [ROLE_ADMIN, ROLE_CATALOGER, ROLE_REVIEWER],
  /** 检索与查看档案列表/详情。 */
  archiveView: [ROLE_ADMIN, ROLE_CATALOGER, ROLE_REVIEWER, ROLE_BORROWER, ROLE_GUEST],
  /** 新建/编辑/删除档案著录信息（删除仅限草稿）。 */
  archiveManage: [ROLE_ADMIN, ROLE_CATALOGER],
  /** 归档状态流转（draft → archived）。 */
  archiveTransition: [ROLE_ADMIN, ROLE_REVIEWER],
  /** 上传附件。 */
  fileUpload: [ROLE_ADMIN, ROLE_CATALOGER, ROLE_REVIEWER],
  /** 下载附件原文（访客默认拒绝）。 */
  fileDownload: [ROLE_ADMIN, ROLE_CATALOGER, ROLE_REVIEWER, ROLE_BORROWER],
  /**
   * 在线编辑文档（阶段二第三批）：与档案著录权限同集合。
   * 实际签发编辑票据还要求：档案为 draft、申请人为文档建档者（externalSubject 归属）、用户为 active。
   */
  documentEdit: [ROLE_ADMIN, ROLE_CATALOGER],
  /**
   * 元数据模板（阶段二第四批）：
   * - templateView 供档案著录表单按分类拉取动态字段（管理员/著录员）；
   * - templateManage 为模板本身的管理（增删改、启停、绑定分类），仅管理员（PRD 5.8 系统管理）。
   */
  templateView: [ROLE_ADMIN, ROLE_CATALOGER],
  templateManage: [ROLE_ADMIN],
  /**
   * 借阅（阶段二第四批）：
   * - borrowRequest 发起/查看本人借阅（访客默认拒绝，仅可浏览目录级信息）；
   * - borrowReview 审核通过/拒绝（管理员 + 审核员，与归档流转同集合）。
   * 说明：这些是角色级基线；档案级受限访问另由 ArchiveAccessService 结合借阅授权判定。
   */
  borrowRequest: [ROLE_ADMIN, ROLE_CATALOGER, ROLE_REVIEWER, ROLE_BORROWER],
  borrowReview: [ROLE_ADMIN, ROLE_REVIEWER],
  /**
   * 操作审计（阶段二第五批）：审计日志查询仅管理员（PRD 5.4 操作追溯 + 5.8 系统管理）。
   * 说明：PRD 5.4 的「三员分立（独立安全审计员角色）」属 V1.5，本批以管理员单一受信主体代理审计查询。
   */
  auditView: [ROLE_ADMIN],
} as const satisfies Record<string, readonly Role[]>;

export type PermKey = keyof typeof PERM;

export function hasPermission(role: Role | undefined, perm: PermKey): boolean {
  return !!role && (PERM[perm] as readonly Role[]).includes(role);
}
