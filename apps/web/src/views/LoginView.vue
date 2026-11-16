<script setup lang="ts">
/**
 * 登录页：未初始化时展示“管理员初始化”表单（由用户自行设置账号密码，无默认密码）；
 * 已初始化时展示标准登录表单。
 */
import { reactive, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { ApiError } from '../api/client';
import BrandMark from '../components/BrandMark.vue';
import { useFlash } from '../toast';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const initMode = computed(() => !auth.initialized);
const loading = ref(false);
const copyrightYear = new Date().getFullYear();
/** 登录/初始化失败走右上角浮层，与全站提示体系一致。 */
const { error } = useFlash();
const form = reactive({ username: '', displayName: '', email: '', password: '' });

const canSubmit = computed(
  () => form.username.trim().length >= 3 && form.password.length >= 6 && !loading.value,
);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    if (initMode.value) {
      await auth.initAdmin(form.username.trim(), form.displayName.trim(), form.password, form.email.trim() || undefined);
    } else {
      await auth.login(form.username.trim(), form.password);
    }
    const next = typeof route.query.next === 'string' ? route.query.next : '/dashboard';
    router.replace(next);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card card">
      <div class="brand-area">
        <BrandMark :size="60" />
        <h1 class="brand-solid">JitArchives</h1>
        <p class="text-muted">智能电子档案管理系统</p>
      </div>

      <div v-if="initMode" class="alert alert-info">
        系统尚未初始化：请设置首位管理员账号与密码（保存于服务器数据库，之后登录使用）。
      </div>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="f-username">登录账号</label>
          <input
            id="f-username"
            v-model="form.username"
            autocomplete="username"
            placeholder="3-32 位字母、数字、._-"
          />
        </div>
        <div class="field" v-if="initMode">
          <label for="f-display">姓名（可选，默认与账号相同）</label>
          <input id="f-display" v-model="form.displayName" placeholder="例如：系统管理员" />
        </div>
        <div class="field" v-if="initMode">
          <label for="f-email">邮箱（可选）</label>
          <input id="f-email" v-model="form.email" type="email" placeholder="your@example.com" />
        </div>
        <div class="field">
          <label for="f-password">{{ initMode ? '管理密码' : '登录密码' }}</label>
          <input
            id="f-password"
            v-model="form.password"
            type="password"
            :autocomplete="initMode ? 'new-password' : 'current-password'"
            placeholder="至少 6 位"
          />
        </div>
        <button class="btn btn-primary btn-block" type="submit" :disabled="!canSubmit">
          {{ loading ? '处理中…' : initMode ? '初始化管理员并进入系统' : '登录' }}
        </button>
      </form>

      <p class="register-link text-muted">
        还没有账号？<router-link to="/register">使用邀请码注册</router-link>
      </p>
    </div>
    <footer class="login-footer" aria-label="版权信息">
      © {{ copyrightYear }} JitArchives 版权所有 · 本系统由 JitWord 协同 AI 文档引擎驱动
    </footer>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 15% 20%, rgba(22, 93, 255, 0.06), transparent 40%),
    radial-gradient(circle at 85% 80%, rgba(54, 207, 201, 0.07), transparent 40%),
    var(--bg-page);
  padding: 24px;
}
.login-card { width: 400px; max-width: 100%; padding: 36px 40px; margin-block: auto; }
.login-footer {
  flex: 0 0 auto;
  max-width: 100%;
  padding-top: 18px;
  color: var(--text-muted, #8a97a9);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}
.brand-area { text-align: center; margin-bottom: 24px; }
.brand-area h1 { font-size: 26px; margin: 8px 0 2px; }
.footnote { text-align: center; margin-top: 18px; margin-bottom: 0; }
.register-link { text-align: center; margin-top: 14px; margin-bottom: 0; font-size: 13px; }
.register-link a { color: var(--color-primary, #165dff); text-decoration: none; }
.register-link a:hover { text-decoration: underline; }

/* 移动端：缩小外围留白，避免软键盘弹出后表单被遮挡 */
@media (max-width: 767px) {
  .login-page {
    align-items: center;
    justify-content: flex-start;
    padding: calc(24px + env(safe-area-inset-top)) 14px calc(24px + env(safe-area-inset-bottom));
  }
  .login-card { padding: 26px 18px; margin-block: 0; }
  .login-footer { margin-top: auto; padding-top: 24px; }
  .brand-area { margin-bottom: 18px; }
  .brand-area h1 { font-size: 22px; }
}
</style>
