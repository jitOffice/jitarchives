<script setup lang="ts">
/**
 * 注册页：用户通过固定邀请码自助创建账号（默认 borrower 角色）。
 * 同一浏览器设备环境仅允许注册一次（通过浏览器指纹识别）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { ApiError } from '../api/client';
import BrandMark from '../components/BrandMark.vue';
import { useFlash } from '../toast';
import FingerprintJS from '@fingerprintjs/fingerprintjs';

const auth = useAuthStore();
const router = useRouter();

const loading = ref(false);
const { error } = useFlash();

/** 浏览器指纹 visitorId（页面初始化时生成，刷新后保持稳定）。 */
const fingerprintId = ref('');
const fingerprintReady = ref(false);

const form = reactive({
  username: '',
  email: '',
  password: '',
  invitationCode: '',
});

const canSubmit = computed(
  () =>
    form.username.trim().length >= 3 &&
    form.password.length >= 6 &&
    form.invitationCode.trim().length > 0 &&
    fingerprintReady.value &&
    !loading.value,
);

// 邀请码二维码弹窗（直接使用固定地址，不调用后端接口）
const QR_URL = 'https://next.jitword.com/uploads/qrcode_19d716f2d29.jpg';
const REPLY_KEYWORD = '电子档案';

const showQrCard = ref(false);
const qrImageLoaded = ref(false);
const qrImageError = ref(false);
const inviteAnchorRef = ref<HTMLElement | null>(null);
const qrCardRef = ref<HTMLElement | null>(null);

function toggleQrCard() {
  if (showQrCard.value) {
    closeQrCard();
  } else {
    openQrCard();
  }
}

function openQrCard() {
  qrImageLoaded.value = false;
  qrImageError.value = false;
  showQrCard.value = true;
  // 等 DOM 更新后校准卡片位置
  nextTick(adjustCardPosition);
}

function closeQrCard() {
  showQrCard.value = false;
}

/** 点击卡片外部关闭 */
function onDocClick(e: MouseEvent) {
  if (!showQrCard.value) return;
  const target = e.target as Node;
  if (inviteAnchorRef.value?.contains(target) || qrCardRef.value?.contains(target)) return;
  closeQrCard();
}

/** 校准卡片位置：确保不超出视口左右边缘 */
function adjustCardPosition() {
  const card = qrCardRef.value;
  if (!card) return;
  // 先重置可能的偏移
  card.style.removeProperty('--card-right-offset');
  // 读取卡片与锚点位置
  const cardRect = card.getBoundingClientRect();
  const vw = window.innerWidth;
  // 右侧溢出：将卡片左移使其完全可见
  if (cardRect.right > vw - 8) {
    const overflow = cardRect.right - (vw - 8);
    card.style.setProperty('--card-right-offset', `${overflow}px`);
  }
  // 左侧溢出：限制右偏移不超过卡片可用空间
  const adjustedRect = card.getBoundingClientRect();
  if (adjustedRect.left < 8) {
    const maxRight = cardRect.width + (cardRect.left - 8);
    card.style.setProperty('--card-right-offset', `${maxRight}px`);
  }
}

onMounted(async () => {
  document.addEventListener('click', onDocClick, true);
  window.addEventListener('resize', adjustCardPosition);
  // 初始化浏览器指纹（FingerprintJS 开源版，仅本地浏览器环境信息，不接入第三方服务）
  try {
    const fp = await FingerprintJS.load();
    const result = await fp.get();
    fingerprintId.value = result.visitorId;
    fingerprintReady.value = true;
  } catch {
    // 指纹加载失败时仍允许填写表单，但提交会被禁用
    fingerprintReady.value = false;
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('resize', adjustCardPosition);
});

function onQrImageLoad() {
  qrImageLoaded.value = true;
  qrImageError.value = false;
}

function onQrImageError() {
  qrImageError.value = true;
  qrImageLoaded.value = false;
}

/** 后端错误码 → 前端友好提示映射 */
function mapRegisterError(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = e.message || '';
    if (e.status === 409) {
      if (msg.includes('激活码已使用') || msg.includes('重复注册')) {
        return '激活码已使用，该设备不能重复注册';
      }
      if (msg.includes('用户名')) return '用户名已存在';
      if (msg.includes('邮箱')) return '邮箱已注册';
      return msg;
    }
    if (e.status === 400) {
      if (msg.includes('邀请码')) return '邀请码不正确，请检查后重试';
      if (msg.includes('设备标识')) return '设备标识异常，请刷新页面重试';
      return msg;
    }
    if (e.status === 429) return '注册频率过高，请稍后重试';
    return msg || '注册失败，请稍后重试';
  }
  return '网络连接失败，请稍后重试';
}

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.register(
      form.username.trim(),
      form.email.trim(),
      form.password,
      form.invitationCode.trim(),
      fingerprintId.value,
    );
    router.replace('/dashboard');
  } catch (e) {
    error.value = mapRegisterError(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card card register-card">
      <div class="brand-area">
        <BrandMark :size="60" />
        <h1 class="brand-solid">创建账号</h1>
        <p class="text-muted">JitArchives · 需要邀请码</p>
      </div>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="r-username">用户名</label>
          <input
            id="r-username"
            v-model="form.username"
            autocomplete="username"
            placeholder="3-32 位字母、数字、._-"
          />
        </div>
        <div class="field">
          <label for="r-email">邮箱（可选）</label>
          <input id="r-email" v-model="form.email" type="email" autocomplete="email" placeholder="your@example.com" />
        </div>
        <div class="field">
          <label for="r-password">密码</label>
          <input
            id="r-password"
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            placeholder="至少 6 位"
          />
        </div>
        <div class="field invite-field">
          <label for="r-invite">邀请码</label>
          <div class="invite-row">
            <input
              id="r-invite"
              v-model="form.invitationCode"
              autocomplete="off"
              placeholder="请输入邀请码"
            />
            <div ref="inviteAnchorRef" class="invite-anchor">
              <button
                type="button"
                class="btn btn-outline invite-btn"
                :class="{ active: showQrCard }"
                @click.stop="toggleQrCard"
              >
                获取邀请码
              </button>
              <!-- 悬浮卡片：锚定在按钮上方 -->
              <Transition name="qr-card">
                <div v-if="showQrCard" ref="qrCardRef" class="qr-card" @click.stop>
                  <button class="qr-close" type="button" aria-label="关闭" @click="closeQrCard">&times;</button>
                  <h4 class="qr-title">扫码获取邀请码</h4>
                  <div class="qr-image-wrap">
                    <img
                      v-show="qrImageLoaded"
                      :src="QR_URL"
                      alt="公众号二维码"
                      class="qr-image"
                      @load="onQrImageLoad"
                      @error="onQrImageError"
                    />
                    <div v-if="qrImageError" class="qr-image-fail">
                      <span class="qr-fail-icon">⚠</span>
                      <p>二维码加载失败</p>
                    </div>
                    <div v-if="!qrImageLoaded && !qrImageError" class="qr-image-loading">
                      加载中…
                    </div>
                  </div>
                  <div class="qr-steps">
                    <p class="qr-step"><strong>1.</strong> 微信扫码关注公众号</p>
                    <p class="qr-step">
                      <strong>2.</strong> 回复口令
                      <code class="qr-keyword">{{ REPLY_KEYWORD }}</code>
                    </p>
                    <p class="qr-step"><strong>3.</strong> 将邀请码填入上方输入框</p>
                  </div>
                </div>
              </Transition>
            </div>
          </div>
        </div>
        <button class="btn btn-primary btn-block" type="submit" :disabled="!canSubmit">
          {{ loading ? '注册中…' : '注册并登录' }}
        </button>
      </form>

      <p class="register-link text-muted">
        已有账号？<router-link to="/login">去登录</router-link>
      </p>
    </div>


  </div>
</template>

<style scoped>
/* 注册页卡片居中（与登录页一致） */
.login-page {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 15% 20%, rgba(22, 93, 255, 0.06), transparent 40%),
    radial-gradient(circle at 85% 80%, rgba(54, 207, 201, 0.07), transparent 40%),
    var(--bg-page);
  padding: 24px;
}

.register-card {
  width: 440px;
  max-width: 100%;
  padding: 36px 40px;
}

.brand-area {
  text-align: center;
  margin-bottom: 24px;
}
.brand-area :deep(.brand-mark) {
  display: inline-block;
}

.invite-field .invite-row {
  display: flex;
  gap: 8px;
}
.invite-field .invite-row input {
  flex: 1;
  min-width: 0;
}
/* 邀请码按钮锚点容器 */
.invite-anchor {
  position: relative;
  flex: none;
}

.invite-btn {
  flex: none;
  white-space: nowrap;
  padding: 8px 14px;
  font-size: 13px;
  border-color: var(--color-primary, #165dff);
  color: var(--color-primary, #165dff);
}
.invite-btn:hover:not(:disabled),
.invite-btn.active {
  background: var(--color-primary, #165dff);
  color: #fff;
}

/* 悬浮卡片：锚定在按钮正上方，右边缘对齐 */
.qr-card {
  --card-right-offset: 0px;
  position: absolute;
  bottom: calc(100% + 8px);
  right: var(--card-right-offset);
  z-index: 100;
  width: 300px;
  padding: 20px 18px 16px;
  background: #fff;
  border-radius: 12px;
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.10),
    0 1px 4px rgba(0, 0, 0, 0.06);
  text-align: center;
}

/* 卡片出现/消失过渡 */
.qr-card-enter-active,
.qr-card-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.qr-card-enter-from,
.qr-card-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.register-link {
  text-align: center;
  margin-top: 14px;
  margin-bottom: 0;
  font-size: 13px;
}
.register-link a {
  color: var(--color-primary, #165dff);
  text-decoration: none;
}
.register-link a:hover {
  text-decoration: underline;
}

.privacy-notice {
  text-align: center;
  margin-top: 10px;
  margin-bottom: 0;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.7;
}

/* 二维码悬浮卡片内部样式 */
.qr-close {
  position: absolute;
  top: 4px;
  right: 8px;
  background: none;
  border: none;
  font-size: 20px;
  line-height: 1;
  color: #999;
  cursor: pointer;
  padding: 4px;
}
.qr-close:hover {
  color: #333;
}
.qr-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
.qr-image-wrap {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 10px;
  min-height: 150px;
}
.qr-image {
  width: 150px;
  height: 150px;
  object-fit: contain;
  border: 1px solid #eee;
  border-radius: 8px;
}
.qr-image-fail {
  width: 150px;
  height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px dashed #ddd;
  border-radius: 8px;
  color: #999;
}
.qr-fail-icon {
  font-size: 28px;
  margin-bottom: 6px;
}
.qr-image-fail p {
  margin: 2px 0;
  font-size: 12px;
}
.qr-image-loading {
  width: 150px;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  font-size: 12px;
  border: 1px dashed #eee;
  border-radius: 8px;
}
.qr-steps {
  text-align: left;
  font-size: 12px;
  line-height: 1.7;
}
.qr-step {
  margin: 3px 0;
}
.qr-keyword {
  display: inline-block;
  background: #f5f5f5;
  color: var(--color-primary, #165dff);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 13px;
  margin: 0 4px;
  user-select: all;
}
.qr-copy-btn {
  display: inline-block;
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--color-primary, #165dff);
  border-radius: 4px;
  background: transparent;
  color: var(--color-primary, #165dff);
  cursor: pointer;
  vertical-align: middle;
  margin-left: 4px;
  transition: all 0.2s;
}
.qr-copy-btn:hover {
  background: var(--color-primary, #165dff);
  color: #fff;
}
.qr-copy-btn.copied {
  border-color: #52c41a;
  color: #52c41a;
}

/* 移动端适配 */
@media (max-width: 767px) {
  .login-page {
    align-items: flex-start;
    padding: calc(24px + env(safe-area-inset-top)) 14px calc(24px + env(safe-area-inset-bottom));
  }
  .register-card { padding: 26px 18px; }
  .qr-card {
    width: calc(100vw - 36px);
    max-width: 300px;
    right: 0 !important;
  }
  .qr-image, .qr-image-fail, .qr-image-loading {
    width: 140px;
    height: 140px;
  }
}
</style>
