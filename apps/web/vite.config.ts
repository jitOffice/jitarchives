import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 开发模式：5173 端口，/api 代理到正式系统后端 5006（避免跨域 Cookie 问题）。
 * 生产构建：产物 apps/web/dist，由 NestJS 同端口托管。
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5006',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
