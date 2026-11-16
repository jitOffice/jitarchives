/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** JitWord iframe SDK v1 全局对象（由官方 loader.js 注入，只声明本项目用到的方法）。 */
interface JitWordEditorInstance {
  on(event: string, handler: (payload?: any) => void): void;
  ready(): Promise<unknown>;
  save(): Promise<unknown>;
  getContent(): Promise<{ result?: unknown } | any>;
  importDocx(options: { content: ArrayBuffer | Uint8Array | Blob | string; fileName?: string; mode?: string; timeout?: number }): Promise<any>;
  exportDocx(options?: { timeout?: number }): Promise<{ success?: boolean; filename?: string; size?: number; mimeType?: string } | any>;
  setReadonly(value: boolean): Promise<unknown> | void;
  setWatermark(options: { text: string } | null): Promise<unknown> | void;
  destroy(): void;
}
interface JitWordGlobal {
  version: string;
  createEditor(options: Record<string, unknown>): JitWordEditorInstance;
}
interface Window {
  JitWord?: JitWordGlobal;
}
