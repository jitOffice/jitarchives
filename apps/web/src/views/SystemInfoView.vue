<script setup lang="ts">
/**
 * 系统信息（管理员专用页）。
 * 原工作台中的技术栈、开发阶段、数据库版本等信息从工作台移除后，
 * 真实运行信息集中在此页展示，避免混入业务数据大盘。
 */
import { onMounted, ref } from 'vue';
import { api, ApiError } from '../api/client';
import type { SystemInfo } from '../types';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppLoading from '../components/ui/AppLoading.vue';

const info = ref<SystemInfo | null>(null);
const loading = ref(false);
const loadError = ref('');

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    info.value = await api.get<SystemInfo>('/system/info');
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '系统信息加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h2 class="page-title">系统信息</h2>
    <p class="page-desc">真实运行信息与账号概况，仅管理员可见。</p>

    <div v-if="loading" class="state-card">
      <AppLoading text="正在加载系统信息…" />
    </div>
    <AppEmpty
      v-else-if="loadError"
      class="state-card"
      variant="error"
      title="系统信息未能加载"
      :description="loadError"
    >
      <template #action>
        <button class="btn btn-sm btn-primary" type="button" @click="load">重新加载</button>
      </template>
    </AppEmpty>

    <div v-else-if="info" class="grid">
      <section class="card">
        <div class="card-title">运行信息</div>
        <div class="desc-grid">
          <div class="desc-item"><span class="k">系统名称</span><span class="v">{{ info.productName }}</span></div>
          <div class="desc-item"><span class="k">版本</span><span class="v">v{{ info.version }}</span></div>
          <div class="desc-item"><span class="k">本次启动</span><span class="v">{{ fmtTime(info.runtime.startedAt) }}</span></div>
          <div class="desc-item"><span class="k">运行环境</span><span class="v">{{ info.runtime.node }}</span></div>
          <div class="desc-item"><span class="k">数据库</span><span class="v">{{ info.runtime.database }}</span></div>
          <div class="desc-item"><span class="k">服务端口</span><span class="v">{{ info.runtime.apiPort }}</span></div>
        </div>
      </section>

      <section class="card" v-if="info.userOverview">
        <div class="card-title">账号概况</div>
        <div class="total">系统账号总数：<strong>{{ info.userOverview.total }}</strong></div>
        <ul class="role-list">
          <li v-for="r in info.userOverview.byRole" :key="r.role">
            <span>{{ r.roleLabel }}</span><strong>{{ r.count }}</strong>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 22px; }
.page-desc { margin: 0 0 20px; font-size: 13px; color: var(--text-muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 20px; }
.total { font-size: 14px; color: var(--text-body); margin-bottom: 8px; }
.total strong { color: var(--color-primary); font-size: 18px; }
.role-list { list-style: none; margin: 0; padding: 0; }
.role-list li {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border-light);
  font-size: 14px;
  color: var(--text-body);
}
.role-list li strong { color: var(--color-primary); }
.state-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  padding: 20px 24px;
  font-size: 14px;
  color: var(--text-body);
}
@media (max-width: 767px) {
  .grid { gap: 14px; }
  .state-card { padding: 16px 14px; }
}
</style>
