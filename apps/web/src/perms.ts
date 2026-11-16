/**
 * 前端档案业务权限判定（与后端 common/permissions.ts 矩阵一一对应）。
 * 仅用于界面隐藏/禁用操作；真实校验一律在后端独立执行。
 */
import type { Role } from './types';

type PermKey =
  | 'categoryView'
  | 'categoryManage'
  | 'archiveView'
  | 'archiveManage'
  | 'archiveTransition'
  | 'fileUpload'
  | 'fileDownload'
  | 'documentEdit'
  | 'templateView'
  | 'templateManage'
  | 'borrowRequest'
  | 'borrowReview'
  | 'auditView';

const PERM: Record<PermKey, Role[]> = {
  categoryView: ['admin', 'cataloger', 'reviewer', 'borrower', 'guest'],
  categoryManage: ['admin', 'cataloger', 'reviewer'],
  archiveView: ['admin', 'cataloger', 'reviewer', 'borrower', 'guest'],
  archiveManage: ['admin', 'cataloger'],
  archiveTransition: ['admin', 'reviewer'],
  fileUpload: ['admin', 'cataloger', 'reviewer'],
  fileDownload: ['admin', 'cataloger', 'reviewer', 'borrower'],
  // 在线编辑入口（仅控制显示）；实际签票仍需后端校验建档者归属与档案状态。
  documentEdit: ['admin', 'cataloger'],
  // 元数据模板：管理仅管理员；查看（供著录表单）管理员/著录员。
  templateView: ['admin', 'cataloger'],
  templateManage: ['admin'],
  // 借阅：发起（不含访客）与审核（管理员/审核员）。真实档案级访问一律后端判定。
  borrowRequest: ['admin', 'cataloger', 'reviewer', 'borrower'],
  borrowReview: ['admin', 'reviewer'],
  // 操作审计：仅管理员可查（与后端 permissions.ts auditView 对应）。
  auditView: ['admin'],
};

export function can(role: Role | undefined | null, perm: PermKey): boolean {
  return !!role && PERM[perm].includes(role);
}

/** 字节数友好显示（上传/附件列表通用）。 */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
