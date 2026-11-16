/**
 * 统一 API 客户端：同源 /api 前缀，自动携带会话 Cookie。
 * 页面中不展示接口参数与开发日志（PRD 界面要求），错误仅提示 message。
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** 审计列表响应的宽松形态：展示字段按可选处理，用于兼容未升级/未重启的后端。 */
type RawAuditPage = {
  items?: Partial<import('../types').AuditLogItemView>[];
  total: number;
  page: number;
  pageSize: number;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  let data: unknown = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const msg =
      (data as { message?: string } | null)?.message || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, Array.isArray(msg) ? msg.join('；') : String(msg));
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, init: RequestInit = {}) =>
    request<T>(path, { ...init, method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /**
   * 文件流上传：直接把 File/字节作为请求体发送（application/octet-stream），
   * 真实文件名经 ?name= 传递，避免 multipart 缓冲、不将整文件读入内存。
   */
  postStream: <T>(path: string, file: File): Promise<T> => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}name=${encodeURIComponent(file.name)}`;
    return requestRaw<T>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  },

  /** 拉取二进制内容（如在线编辑 seed 返回的源 DOCX，交给 importDocx）。 */
  getBlob: (path: string, init: RequestInit = {}): Promise<Blob> => fetchBlob(path, init),

  /**
   * 原文体提交（application/octet-stream）：正文自检这类大体积 JSON 走该通道，
   * 避开后端全局 JSON 解析器的默认 100KB 上限（不为单一诊断接口放宽全局限制）。
   */
  postRaw: <T>(path: string, raw: string): Promise<T> =>
    requestRaw<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: raw,
    }),

  /**
   * 审计日志分页查询（阶段二第五批）：过滤一律在服务端 SQL 执行，
   * 前端仅提交条件，不接受客户端指定操作人。空条件不拼入 query。
   */
  queryAudit: async (q: Record<string, string | number | undefined>): Promise<import('../types').AuditPage> => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && String(v) !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    const res = await request<RawAuditPage>(`/audit${qs ? `?${qs}` : ''}`);
    // 兼容后端仍运行旧进程（缺展示字段）的情形：缺失字段回退到技术字段，避免整页渲染失败。
    const items = (res.items ?? []).map((it): import('../types').AuditLogItemView => ({
      id: it.id ?? 0,
      actorUserId: it.actorUserId ?? null,
      actorName: it.actorName ?? null,
      actorRole: it.actorRole ?? null,
      action: it.action ?? '',
      objectType: it.objectType ?? '',
      objectId: it.objectId ?? null,
      result: it.result ?? 'success',
      detail: it.detail ?? {},
      ip: it.ip ?? null,
      createdAt: it.createdAt ?? '',
      actionLabel: it.actionLabel ?? it.action ?? '',
      objectTypeLabel: it.objectTypeLabel ?? it.objectType ?? '',
      objectLabel: it.objectLabel ?? null,
      objectRef: it.objectRef ?? null,
      objectResolved: it.objectResolved ?? false,
      summary: Array.isArray(it.summary) ? it.summary : [],
    }));
    return { items, total: res.total, page: res.page, pageSize: res.pageSize };
  },

  /** 审计可选动作常量及中文名（供筛选下拉，与列表展示同源）。 */
  auditActions: (): Promise<{ actions: string[]; labels: Record<string, string> }> =>
    request<{ actions: string[]; labels: Record<string, string> }>('/audit/actions'),
};

/** 不带 JSON 头的原始请求（文件流上传场景）。 */
async function requestRaw<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  let data: unknown = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const msg =
      (data as { message?: string } | null)?.message || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, Array.isArray(msg) ? msg.join('；') : String(msg));
  }
  return data as T;
}

/** 拉取二进制内容；非 2xx 解析 JSON 错误后抛出 ApiError。 */
async function fetchBlob(path: string, init: RequestInit): Promise<Blob> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const data = (await res.json()) as { message?: string | string[] };
      if (data?.message) message = Array.isArray(data.message) ? data.message.join('；') : data.message;
    } catch {
      /* 保留默认提示 */
    }
    throw new ApiError(res.status, message);
  }
  return res.blob();
}

/** 授权下载附件：经 /api 接口携带会话 Cookie，不暴露物理路径。 */
export async function downloadFile(fileId: number): Promise<void> {
  const res = await fetch(`/api/archive-files/${fileId}/download`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `下载失败（HTTP ${res.status}）`;
    try {
      const data = (await res.json()) as { message?: string | string[] };
      if (data?.message) message = Array.isArray(data.message) ? data.message.join('；') : data.message;
    } catch {
      /* 保留默认提示 */
    }
    throw new ApiError(res.status, message);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="([^";]+)"/i);
  const fileName = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `文件-${fileId}`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * 附件在线预览接口路径（受控文件流）：配合 api.getBlob 使用，
 * 携带会话 Cookie；服务端按与下载同级授权与真实字节格式判定后才内联输出。
 */
export function previewUrl(fileId: number): string {
  return `/archive-files/${fileId}/preview`;
}

/**
 * 文件版本在线预览接口路径（受控字节流）：DOCX 由前端 JitWord-Preview SDK 解析，
 * 服务端同样按与下载同级授权 + 档案归属复核后才下发字节。
 */
export function versionPreviewUrl(archiveId: number, versionId: number): string {
  return `/archives/${archiveId}/versions/${versionId}/preview`;
}
