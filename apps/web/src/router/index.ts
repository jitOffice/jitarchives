/**
 * 路由：登录页独立；系统内页面统一挂在 AppLayout 下。
 * 导航守卫：未登录只允许 /login；非管理员禁止 /users；著录/编辑页限 archiveManage 角色。
 * 真实权限一律后端独立校验，前端守卫仅控制入口。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { can } from '../perms';
import AppLayout from '../layouts/AppLayout.vue';
import LoginView from '../views/LoginView.vue';
import RegisterView from '../views/RegisterView.vue';
import DashboardView from '../views/DashboardView.vue';
import UsersView from '../views/UsersView.vue';
import ArchivesView from '../views/ArchivesView.vue';
import AgentView from '../views/AgentView.vue';
import CategoriesView from '../views/CategoriesView.vue';
import ArchiveFormView from '../views/ArchiveFormView.vue';
import ArchiveDetailView from '../views/ArchiveDetailView.vue';
import KnowledgeGraphView from '../views/KnowledgeGraphView.vue';
import ArchiveEditorView from '../views/ArchiveEditorView.vue';
import MetadataTemplatesView from '../views/MetadataTemplatesView.vue';
import BorrowCatalogView from '../views/BorrowCatalogView.vue';
import MyBorrowView from '../views/MyBorrowView.vue';
import BorrowReviewView from '../views/BorrowReviewView.vue';
import AuditLogView from '../views/AuditLogView.vue';
import SystemInfoView from '../views/SystemInfoView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/register', name: 'register', component: RegisterView, meta: { public: true } },
  {
    path: '/',
    component: AppLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: DashboardView, meta: { title: '工作台' } },
      {
        path: 'users',
        name: 'users',
        component: UsersView,
        meta: { title: '用户管理', roles: ['admin'] },
      },
      {
        path: 'archives',
        name: 'archives',
        component: ArchivesView,
        meta: { title: '档案资源管理' },
      },
      {
        path: 'archives/search',
        name: 'archive-search',
        component: AgentView,
        meta: { title: '档案 Agent 助理' },
      },
      {
        path: 'archives/categories',
        name: 'archive-categories',
        component: CategoriesView,
        meta: { title: '档案分类管理' },
      },
      {
        // 知识图谱（第二阶段）：只读展示，入口与后端一致要求 archiveView；flush = 内容区去内边距给画布整幅空间
        path: 'knowledge-graph',
        name: 'knowledge-graph',
        component: KnowledgeGraphView,
        meta: { title: '档案知识图谱', perms: 'archiveView', flush: true },
      },
      {
        path: 'archives/new',
        name: 'archive-create',
        component: ArchiveFormView,
        meta: { title: '新建档案', perms: 'archiveManage' },
      },
      {
        path: 'archives/:id',
        name: 'archive-detail',
        component: ArchiveDetailView,
        props: true,
        meta: { title: '档案详情' },
      },
      {
        path: 'archives/:id/edit',
        name: 'archive-edit',
        component: ArchiveFormView,
        props: true,
        meta: { title: '编辑档案', perms: 'archiveManage' },
      },
      {
        path: 'archives/:id/edit-online',
        name: 'archive-edit-online',
        component: ArchiveEditorView,
        props: true,
        meta: { title: '在线编辑', perms: 'documentEdit' },
      },
      {
        path: 'templates',
        name: 'templates',
        component: MetadataTemplatesView,
        meta: { title: '元数据模板', perms: 'templateManage' },
      },
      {
        path: 'borrow',
        name: 'borrow-catalog',
        component: BorrowCatalogView,
        meta: { title: '借阅管理', perms: 'borrowRequest' },
      },
      {
        path: 'borrow/mine',
        name: 'borrow-mine',
        component: MyBorrowView,
        meta: { title: '我的借阅', perms: 'borrowRequest' },
      },
      {
        path: 'borrow/review',
        name: 'borrow-review',
        component: BorrowReviewView,
        meta: { title: '借阅审核', perms: 'borrowReview' },
      },
      {
        path: 'audit',
        name: 'audit',
        component: AuditLogView,
        meta: { title: '操作审计', roles: ['admin'] },
      },
      {
        path: 'system',
        name: 'system',
        component: SystemInfoView,
        meta: { title: '系统信息', roles: ['admin'] },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.bootstrap(); // 幂等：仅首次真正请求后端

  if (to.meta.public) {
    return auth.isAuthenticated && to.name === 'login' ? '/dashboard' : true;
  }
  if (!auth.isAuthenticated) {
    return { name: 'login', query: to.fullPath === '/dashboard' ? {} : { next: to.fullPath } };
  }
  const roles = to.meta.roles as string[] | undefined;
  if (roles && auth.user && !roles.includes(auth.user.role)) {
    return '/dashboard'; // 越权访问直接回工作台，不给进入也不报错页
  }
  const perm = to.meta.perms as Parameters<typeof can>[1] | undefined;
  if (perm && !can(auth.user?.role, perm)) {
    return '/dashboard';
  }
  return true;
});
