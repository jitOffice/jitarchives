<script setup lang="ts">
import { router } from './router';
import { useAuthStore } from './stores/auth';
import ToastHost from './components/ToastHost.vue';
import DialogHost from './components/ui/DialogHost.vue';

const auth = useAuthStore();

// 会话中遇到 401（如服务端会话过期、被禁用踢出）统一回登录页
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason;
  if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
    auth.user = null;
    auth.status = 'anonymous';
    void router.replace({ name: 'login' });
  }
});
</script>

<template>
  <router-view />
  <!-- 全局瞬时提示：右上角浮层，数秒后自动消失（不再使用页内常驻横幅） -->
  <ToastHost />
  <!-- 全局确认/输入弹窗：替代 window.confirm / window.prompt -->
  <DialogHost />
</template>
