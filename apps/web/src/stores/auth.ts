/**
 * 认证状态 store（Pinia）：登录状态一律以后端 /auth/me 校验结果为准，
 * 前端本地不做任何"伪登录"判断。
 */
import { defineStore } from 'pinia';
import { api, ApiError } from '../api/client';
import type { UserView } from '../types';

type SessionStatus = 'unknown' | 'loading' | 'authenticated' | 'anonymous';

interface AuthStatusResponse {
  initialized: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    status: 'unknown' as SessionStatus,
    initialized: true,
    user: null as UserView | null,
  }),
  getters: {
    isAdmin: (s) => s.user?.role === 'admin',
    isAuthenticated: (s) => s.status === 'authenticated',
  },
  actions: {
    /** 首次进入应用：查初始化状态 + 恢复会话。 */
    async bootstrap() {
      if (this.status !== 'unknown') return;
      const st = await api.get<AuthStatusResponse>('/auth/status');
      this.initialized = st.initialized;
      await this.fetchMe();
    },

    /** 后端校验当前会话。 */
    async fetchMe() {
      try {
        const res = await api.get<{ user: UserView }>('/auth/me');
        this.user = res.user;
        this.status = 'authenticated';
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          this.user = null;
          this.status = 'anonymous';
        } else {
          throw e;
        }
      }
    },

    async initAdmin(username: string, displayName: string, password: string, email?: string) {
      const res = await api.post<{ user: UserView }>('/auth/init-admin', {
        username,
        displayName,
        email,
        password,
      });
      this.user = res.user;
      this.status = 'authenticated';
      this.initialized = true;
    },

    async login(username: string, password: string) {
      const res = await api.post<{ user: UserView }>('/auth/login', { username, password });
      this.user = res.user;
      this.status = 'authenticated';
    },

    /** 邀请码注册：固定邀请码 + 浏览器指纹设备限制，成功后自动登录。 */
    async register(username: string, email: string, password: string, invitationCode: string, fingerprint: string) {
      const res = await api.post<{ user: UserView }>('/auth/register', {
        username,
        email,
        password,
        invitationCode,
        fingerprint,
      });
      this.user = res.user;
      this.status = 'authenticated';
    },

    /** 退出：服务端删除会话，原 Cookie 立即失效。 */
    async logout() {
      try {
        await api.post('/auth/logout');
      } finally {
        this.user = null;
        this.status = 'anonymous';
      }
    },
  },
});
