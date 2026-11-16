<script setup lang="ts">
/**
 * 全站统一品牌标识：使用 public/images 下的正式 Logo 图片。
 * size 控制显示区域，保持正方形容器并通过 object-fit 避免拉伸。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 22 });
</script>

<template>
  <img
    class="brand-mark"
    src="/images/jitarchives-logo.png?v=3"
    :style="{ width: `${size}px`, height: `${size}px` }"
    alt=""
    aria-hidden="true"
  />
</template>

<style scoped>
.brand-mark {
  flex: none;
  display: inline-block;
  object-fit: contain;
  vertical-align: middle;
}
</style>
