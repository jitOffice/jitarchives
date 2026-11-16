<script setup lang="ts">
/**
 * 系统统一布局：顶栏（品牌 + 当前用户 + 退出）+ 左侧导航。
 * 导航只列出当前版本已实现的入口，规划中的功能不出现在菜单中。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { can } from '../perms';
import BrandMark from '../components/BrandMark.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 窄屏（≤1023px）下侧栏收起为抽屉，由顶栏汉堡按钮控制 */
const menuOpen = ref(false);
/** 退出请求进行中：禁用按钮并显示进度，避免重复点击。 */
const loggingOut = ref(false);
/** 顶部产品生态下拉菜单。 */
const productMenuOpen = ref(false);
/** 左侧栏底部的公众号二维码，仅点击按钮时展示。 */
const sidebarFollowOpen = ref(false);

const ecosystemProducts = [
  {
    key: 'jitword',
    name: 'JitWord 即时文档',
    description: '在线协同文档编辑器',
    icon: '/images/ecosystem/product-word.svg',
    url: 'https://jitword.com/index.html',
  },
  {
    key: 'pxcharts',
    name: 'PxCharts AI表格',
    description: 'AI驱动的多维表格平台',
    icon: '/images/ecosystem/product-charts.svg',
    url: 'https://pxcharts.jitword.com/',
  },
  {
    key: 'jitofd',
    name: 'JitOFD',
    description: 'Web端高性能OFD编辑器',
    icon: '/images/ecosystem/product-ofd.svg',
    url: 'https://jitword.com/ofd-editor/',
  },
  {
    key: 'jitknow',
    name: 'JitKnow',
    description: '企业级AI知识库',
    icon: '/images/ecosystem/product-know.svg',
    url: 'https://know.jitword.com/',
  },
];

// 路由切换后自动收起抽屉和产品菜单，避免遮挡页面内容
watch(() => route.fullPath, () => {
  menuOpen.value = false;
  productMenuOpen.value = false;
  sidebarFollowOpen.value = false;
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    menuOpen.value = false;
    productMenuOpen.value = false;
    sidebarFollowOpen.value = false;
  }
}

function onDocumentPointerdown(e: PointerEvent) {
  const target = e.target;
  if (target instanceof Element && !target.closest('.product-menu')) {
    productMenuOpen.value = false;
  }
  if (target instanceof Element && !target.closest('.sidebar-follow')) {
    sidebarFollowOpen.value = false;
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerdown', onDocumentPointerdown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('pointerdown', onDocumentPointerdown);
});

const enabledItems = [
  { path: '/dashboard', label: '工作台' },
  { path: '/archives', label: '档案资源管理', perm: 'archiveView' as const },
  { path: '/archives/search', label: '档案 Agent 助理', perm: 'archiveView' as const },
  { path: '/knowledge-graph', label: '档案知识图谱', perm: 'archiveView' as const },
  { path: '/archives/categories', label: '档案分类管理', perm: 'categoryView' as const },
  { path: '/templates', label: '元数据模板', perm: 'templateManage' as const },
  { path: '/borrow', label: '借阅管理', perm: 'borrowRequest' as const },
  { path: '/borrow/review', label: '借阅审核', perm: 'borrowReview' as const },
  { path: '/audit', label: '操作审计', perm: 'auditView' as const },
  { path: '/system', label: '系统信息', adminOnly: true },
  { path: '/users', label: '用户管理', adminOnly: true },
];

function visible(item: { perm?: string; adminOnly?: boolean }): boolean {
  if (item.adminOnly) return auth.isAdmin;
  if (item.perm) return can(auth.user?.role, item.perm as Parameters<typeof can>[1]);
  return true;
}

async function onLogout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await auth.logout();
    router.replace({ name: 'login' });
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <div class="layout">
    <header class="header">
      <div class="header-left">
        <button
          class="menu-btn"
          type="button"
          :aria-expanded="menuOpen"
          aria-label="打开或关闭导航菜单"
          @click="menuOpen = !menuOpen"
        >
          <span class="menu-bar"></span>
          <span class="menu-bar"></span>
          <span class="menu-bar"></span>
        </button>
        <div class="brand">
          <BrandMark :size="28" />
          <span class="brand-name">JitArchives</span>
          <span class="brand-sub">智能电子档案管理系统</span>
        </div>
        <div class="product-menu">
          <button
            class="product-menu-trigger"
            type="button"
            :aria-expanded="productMenuOpen"
            aria-controls="product-ecosystem-menu"
            @click="productMenuOpen = !productMenuOpen"
          >
            <span>产品生态</span>
            <svg
              class="product-menu-chevron"
              :class="{ 'is-open': productMenuOpen }"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
          <div v-if="productMenuOpen" id="product-ecosystem-menu" class="product-menu-panel">
            <div class="product-menu-heading">Jit 产品生态</div>
            <a
              v-for="product in ecosystemProducts"
              :key="product.key"
              class="product-menu-item"
              :href="product.url"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span class="product-menu-icon" :class="`product-menu-icon--${product.key}`" aria-hidden="true">
                <img :src="product.icon" alt="" loading="lazy" decoding="async" />
              </span>
              <span class="product-menu-copy">
                <strong>{{ product.name }}</strong>
                <small>{{ product.description }}</small>
              </span>
            </a>
          </div>
        </div>
      </div>
      <div class="user-zone" v-if="auth.user">
        <span class="badge">{{ auth.user.roleLabel }}</span>
        <span class="user-name">{{ auth.user.displayName }}（{{ auth.user.username }}）</span>
        <button class="btn btn-sm" :disabled="loggingOut" @click="onLogout">
          {{ loggingOut ? '退出中…' : '退出登录' }}
        </button>
      </div>
    </header>
    <div class="body">
      <div class="nav-mask" v-if="menuOpen" @click="menuOpen = false"></div>
      <nav class="sidebar" :class="{ open: menuOpen }">
        <ul>
          <li
            v-for="item in enabledItems"
            :key="item.path"
            v-show="visible(item)"
          >
            <RouterLink :to="item.path" :class="{ active: route.path === item.path }">
              {{ item.label }}
            </RouterLink>
          </li>
        </ul>
        <div class="sidebar-follow">
          <Transition name="sidebar-follow-popover">
            <div
              v-if="sidebarFollowOpen"
              id="sidebar-follow-popover"
              class="sidebar-follow-panel"
              role="group"
              aria-label="关注获取更多AI项目二维码"
            >
              <div class="sidebar-follow-heading">关注获取更多AI项目</div>
              <img
                src="/images/qutan-ai-official-account-qr.png"
                alt="趣谈 AI 公众号二维码"
                decoding="async"
              />
            </div>
          </Transition>
          <button
            type="button"
            class="sidebar-follow-trigger"
            :aria-expanded="sidebarFollowOpen"
            aria-controls="sidebar-follow-popover"
            @click="sidebarFollowOpen = !sidebarFollowOpen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m12 1.5 2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z" />
              <path d="m19 16 .9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z" />
            </svg>
            <span>关注获取更多AI项目</span>
          </button>
        </div>
      </nav>
      <main class="content" :class="{ 'content--flush': route.meta.flush === true }">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100%; }
.header {
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: #fff;
  border-bottom: 1px solid var(--border-light);
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-name { font-size: 17px; font-weight: 700; color: #2583f5; }
.brand-sub { font-size: 13px; color: var(--text-muted); }
.user-zone { display: flex; align-items: center; gap: 10px; }
.user-name { font-size: 13px; color: var(--text-body); }

.product-menu { position: relative; flex: none; }
.product-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.18s ease;
}
.product-menu-trigger:hover,
.product-menu-trigger[aria-expanded='true'] {
  border: 0;
  background: transparent;
  color: var(--text-muted);
}
.product-menu-trigger:focus-visible {
  outline: 2px solid rgba(22, 93, 255, 0.42);
  outline-offset: 4px;
  border-radius: 3px;
  box-shadow: none;
}
.product-menu-chevron {
  width: 12px;
  height: 12px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.product-menu-chevron { transition: transform 0.18s ease; }
.product-menu-chevron.is-open { transform: rotate(180deg); }
.product-menu-panel {
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  z-index: 300;
  width: 320px;
  max-width: calc(100vw - 24px);
  padding: 10px;
  border: 1px solid #e8edf5;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 14px 38px rgba(30, 55, 90, 0.16);
}
.product-menu-heading {
  padding: 7px 10px 10px;
  color: #8a97a9;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.product-menu-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 62px;
  padding: 9px 10px;
  border-radius: 10px;
  color: #26364b;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.16s ease, transform 0.16s ease;
}
.product-menu-item:hover { background: #f4f7fc; }
.product-menu-item:focus-visible {
  outline: none;
  background: #f0f5ff;
  box-shadow: inset 0 0 0 1px #b8d2ff;
}
.product-menu-icon {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border-radius: 7px;
}
.product-menu-icon img {
  display: block;
  width: 20px;
  height: 20px;
  filter: brightness(0) invert(1);
}
.product-menu-icon--jitword,
.product-menu-icon--jitofd {
  background: linear-gradient(135deg, #165dff, #4080ff);
}
.product-menu-icon--pxcharts {
  background: linear-gradient(135deg, #00c9a7, #00e5b8);
}
.product-menu-icon--jitknow {
  background: linear-gradient(135deg, #f59e0b, #fbbf24);
}
.product-menu-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.product-menu-copy strong { color: #25364d; font-size: 13px; font-weight: 700; }
.product-menu-copy small { color: #8a96a8; font-size: 12px; line-height: 1.4; }

/* 汉堡按钮：仅窄屏显示（见下方媒体查询） */
.header-left { display: flex; align-items: center; gap: 16px; min-width: 0; }
.menu-btn {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  width: 34px;
  height: 34px;
  padding: 0 7px;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}
.menu-btn:hover { border-color: var(--color-primary); }
.menu-bar { display: block; height: 2px; border-radius: 1px; background: var(--text-body); }
.nav-mask { display: none; }

.body { flex: 1; display: flex; min-height: 0; }
.sidebar {
  width: 200px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #fff;
  border-right: 1px solid var(--border-light);
  padding: 16px 12px;
}
.sidebar ul {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}
/* 左下角关注入口：默认只显示按钮，点击时在按钮正上方展示二维码。 */
.sidebar-follow {
  position: relative;
  flex: 0 0 auto;
  padding-top: 12px;
}
.sidebar-follow-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 38px;
  padding: 9px 12px;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(115deg, #2878ff, #165dff);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 5px 15px rgba(22, 93, 255, 0.2);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.sidebar-follow-trigger:hover,
.sidebar-follow-trigger[aria-expanded='true'] {
  background: linear-gradient(115deg, #1d6cf5, #0e4fe8);
  box-shadow: 0 6px 18px rgba(22, 93, 255, 0.27);
}
.sidebar-follow-trigger:focus-visible {
  outline: 2px solid #165dff;
  outline-offset: 3px;
}
.sidebar-follow-trigger svg {
  display: block;
  flex: 0 0 17px;
  width: 17px;
  height: 17px;
  fill: currentColor;
}
.sidebar-follow-panel {
  position: absolute;
  z-index: 130;
  bottom: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  width: 184px;
  max-width: calc(100vw - 32px);
  padding: 15px 12px 13px;
  border: 1px solid #e8edf5;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 12px 30px rgba(36, 56, 92, 0.18);
  text-align: center;
}
.sidebar-follow-panel::after {
  content: '';
  position: absolute;
  bottom: -7px;
  left: calc(50% - 7px);
  width: 13px;
  height: 13px;
  transform: rotate(45deg);
  border-right: 1px solid #e8edf5;
  border-bottom: 1px solid #e8edf5;
  background: #fff;
}
.sidebar-follow-heading {
  margin-bottom: 10px;
  color: #27354a;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.sidebar-follow-panel img {
  display: block;
  width: 146px;
  height: 146px;
  max-width: 100%;
  margin: 0 auto;
  object-fit: contain;
}
.sidebar-follow-popover-enter-active,
.sidebar-follow-popover-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.sidebar-follow-popover-enter-from,
.sidebar-follow-popover-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-follow-trigger,
  .sidebar-follow-popover-enter-active,
  .sidebar-follow-popover-leave-active {
    transition: none;
  }
}
.sidebar a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 8px;
  color: var(--text-body);
  text-decoration: none;
  font-size: 14px;
  margin-bottom: 4px;
}
.sidebar a:hover { background: var(--color-primary-soft); color: var(--color-primary); }
.sidebar a.active { background: var(--color-primary-soft); color: var(--color-primary); font-weight: 600; }
.sidebar a:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  color: var(--color-primary);
}

.content { flex: 1; overflow: auto; padding: 24px; }

/* 图谱等需要整幅画布的页面：去掉内边距并禁用页面滚动，滚动与缩放都交给页内区域 */
.content--flush { padding: 0; overflow: hidden; }

/* ===== 平板 / 手机：侧栏改为抽屉，顶栏腾出空间 ===== */
@media (max-width: 1023px) {
  .header {
    height: calc(52px + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) 12px 0;
  }
  .menu-btn {
    display: flex;
    width: 44px;
    height: 44px;
    padding: 0 12px;
  }
  .header-left { gap: 10px; }
  .user-name { display: none; }

  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 120;
    width: min(78vw, 280px);
    overflow-y: auto;
    padding: calc(16px + env(safe-area-inset-top)) 12px calc(20px + env(safe-area-inset-bottom));
    box-shadow: 0 8px 30px rgba(29, 33, 41, 0.18);
    transform: translateX(-100%);
    transition: transform 0.24s ease;
  }
  .sidebar.open { transform: translateX(0); }
  .nav-mask {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 110;
    background: rgba(0, 0, 0, 0.35);
  }
  .content {
    padding: 16px 12px calc(20px + env(safe-area-inset-bottom));
    -webkit-overflow-scrolling: touch;
  }
  .content--flush { padding: 0; }
}

@media (max-width: 767px) {
  .header { padding-right: 8px; padding-left: 8px; }
  .header-left { gap: 6px; }
  .brand { gap: 6px; }
  .brand-name { font-size: 15px; }
  .brand-sub { display: none; }
  .product-menu-panel { right: 0; left: auto; }
  .user-zone { gap: 6px; }
  .header .btn { padding: 7px 8px; }
  .sidebar a { padding: 12px 14px; }
}
</style>
