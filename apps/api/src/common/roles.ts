/**
 * 角色与用户公共类型定义（PRD 5.4 基础角色）。
 * 本批只落实登录与用户管理需要的基础授权；档案级细粒度权限在后续业务阶段实现。
 */
export const ROLE_ADMIN = 'admin';
export const ROLE_CATALOGER = 'cataloger';
export const ROLE_REVIEWER = 'reviewer';
export const ROLE_BORROWER = 'borrower';
export const ROLE_GUEST = 'guest';

/** 系统预设五类角色（PRD 5.4）。 */
export const ROLES = [ROLE_ADMIN, ROLE_CATALOGER, ROLE_REVIEWER, ROLE_BORROWER, ROLE_GUEST] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  cataloger: '著录员',
  reviewer: '审核员',
  borrower: '借阅者',
  guest: '访客',
};

export type UserStatus = 'active' | 'disabled';

export function isValidRole(role: unknown): role is Role {
  return typeof role === 'string' && (ROLES as readonly string[]).includes(role);
}

/** 运行时角色安全显示（未知角色回退为原值，避免页面空白）。 */
export function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role;
}

/** 对外返回的用户视图：绝不含密码或哈希。 */
export interface UserView {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: Role;
  roleLabel: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}
