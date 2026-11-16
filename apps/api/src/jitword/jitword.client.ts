/**
 * JitWord 服务端接口封装（阶段二第三批，从 jitword-integration/lib/jitword.mjs 平移为 NestJS Service）。
 * 仅用 Node 内置 fetch，零新增依赖。
 *
 * 与阶段一的差异（正式化）：
 *   - 不含任何演示身份默认主体：externalSubject 一律由调用方按真实登录用户传入；
 *   - clientSecret 只在 X-Embed-Client-Secret 头出现，不进入任何返回值；
 *   - 票据每次现签、禁止缓存（官方文档第 08 节第二条）。
 *
 * 能力边界（官方第 06/11 节 + 产品侧 OpenAPI 实测）：
 *   - embed 体系（X-Embed-Client-Secret）只提供换票/建文档/manifest/profile，不含正文与导出字节；
 *   - 产品侧 GET /export/docx/{docId} 需用户 JWT，非建档主体实测 403 → 服务端不能凭 docId 取件；
 *   - 完整导出链路：签 ticket → 换 session token（JWT）→ Bearer 调 GET /export/docx/{docId}；
 *   - 白名单可用的是 POST /export/docx（按正文 JSON 渲染、免鉴权）→ 见 renderDocx；
 *   - exportDocument 已实现（按 docId 取回导出件），autoExportAvailable 为 true，保存即入库正式落地；
 *   - 实测导出件不含页眉/页脚（SDK 能力边界），但正文零丢字，保真度可接受。
 */
import { createHash } from 'node:crypto';
import { JitWordConfig } from './jitword.config';

/** 建文档返回。 */
export interface CreatedDoc {
  docId: string;
  name?: string;
}

/** 换票返回（只暴露可安全下发前端的字段）。 */
export interface IssuedTicket {
  ticket: string;
  expiresAt: string;
  expiresIn: number;
  docId?: string;
  origin?: string;
  scopes?: string[];
}

export interface TicketRequest {
  docId: string;
  origin: string;
  externalSubject: string;
  displayName: string;
  mode: 'edit' | 'view';
  watermarkText: string;
  expiresIn?: number;
}

/** 客户端接口：控制器/服务只依赖该契约，测试可注入桩实现而不触网。 */
export interface JitWordClient {
  readonly available: boolean;
  createDocument(input: { name: string; externalSubject: string }): Promise<CreatedDoc>;
  createTicket(req: TicketRequest): Promise<IssuedTicket>;
  manifest(): Promise<Record<string, unknown>>;
  /** 可选能力：取回文档导出件字节（厂商开放后实现）。未实现即视为能力不可用。 */
  exportDocument?(docId: string, externalSubject: string, origin: string): Promise<{ buffer: Buffer; fileName: string }>;
  /**
   * 可选能力：把正文 JSON（ProseMirror doc）交给厂商服务端渲染为 DOCX 字节。
   * 走白名单开放的 POST /export/docx（按内容渲染，不需用户 JWT）；
   * 请求体绝不带 documentId：实测带上就会触发文档归属校验并返回 403。
   */
  renderDocx?(content: unknown, fileName: string): Promise<{ buffer: Buffer; fileName: string }>;
}

const EDIT_SCOPES = ['document:read', 'document:edit', 'comment:write'];
const VIEW_SCOPES = ['document:read'];

/** 真实客户端：用 clientSecret 与 JitWord 服务端通信。 */
export class RealJitWordClient implements JitWordClient {
  readonly available = true;
  constructor(private readonly config: JitWordConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(
    pathname: string,
    { method = 'GET', body, withSecret = true }: { method?: string; body?: unknown; withSecret?: boolean } = {},
  ) {
    const url = `${this.config.api}${pathname}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(withSecret ? { 'X-Embed-Client-Secret': this.config.clientSecret } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const detail = (error as Error)?.message || '网络错误';
      const wrapped = new Error(`连不上 JitWord 服务（${detail}）`);
      (wrapped as Error & { network?: boolean }).network = true;
      throw wrapped;
    }
    const text = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    return { status: response.status, ok: response.ok, payload };
  }

  async manifest(): Promise<Record<string, unknown>> {
    const res = await this.request('/embed/manifest', { withSecret: false });
    if (!res.ok) throw new Error(`manifest 不可用（HTTP ${res.status}）`);
    return (res.payload?.data as Record<string, unknown>) || {};
  }

  async createDocument(input: { name: string; externalSubject: string }): Promise<CreatedDoc> {
    const res = await this.request('/embed/documents', {
      method: 'POST',
      body: {
        type: 'document',
        name: input.name,
        externalSubject: input.externalSubject,
        tenantKey: this.config.tenantKey,
        providerKey: this.config.providerKey,
      },
    });
    const data = res.payload?.data as { docId?: string; name?: string } | undefined;
    if (!res.ok || res.payload?.code !== 200 || !data?.docId) {
      throw new Error(
        `创建在线文档失败（HTTP ${res.status}）：${String(res.payload?.message || '未知原因')}`,
      );
    }
    return { docId: data.docId, name: data.name };
  }

  async createTicket(req: TicketRequest): Promise<IssuedTicket> {
    const isEdit = req.mode === 'edit';
    const body = {
      tenantKey: this.config.tenantKey,
      providerKey: this.config.providerKey,
      externalSubject: req.externalSubject,
      user: { displayName: req.displayName },
      document: { docId: req.docId },
      permission: { role: isEdit ? 'editor' : 'viewer', scopes: isEdit ? EDIT_SCOPES : VIEW_SCOPES },
      // 票据 ui.readonly 实测恒 false，只读靠 scopes 强制；这里仍显式收紧，正式权限以 scopes 为准。
      ui: { readonly: !isEdit },
      watermark: { text: req.watermarkText, opacity: 0.12 },
      origin: req.origin,
      expiresIn: req.expiresIn ?? 120,
    };
    const res = await this.request('/embed/tickets', { method: 'POST', body });
    const data = res.payload?.data as
      | { ticket?: string; expiresAt?: string; expiresIn?: number; docId?: string; origin?: string; scopes?: string[] }
      | undefined;
    if (!res.ok || res.payload?.code !== 200 || !data?.ticket) {
      const error = new Error(String(res.payload?.message || `换票失败（HTTP ${res.status}）`));
      (error as Error & { status?: number }).status = res.status;
      throw error;
    }
    return {
      ticket: data.ticket,
      expiresAt: data.expiresAt ?? '',
      expiresIn: data.expiresIn ?? (req.expiresIn ?? 120),
      docId: data.docId,
      origin: data.origin,
      scopes: data.scopes,
    };
  }

  /**
   * 正文 JSON → 厂商渲染的 DOCX 字节。
   * 实测：仅送 content（不带任何凭据、不带 documentId）即返回 200 真字节；
   * 一旦请求体带 documentId 就会触发文档归属校验并 403，因此本方法不传 docId、也不带租户密钥；
   * 响应为二进制，故不走返回 JSON 的 request()。
   */
  async renderDocx(content: unknown, fileName: string): Promise<{ buffer: Buffer; fileName: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.api}/export/docx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename: fileName }),
      });
    } catch (error) {
      throw new Error(`连不上 JitWord 导出接口（${(error as Error)?.message || '网络错误'}）`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`导出接口返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 120)}` : ''}`);
    }
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
    if (!buffer.byteLength) throw new Error('导出接口返回空字节');
    return { buffer, fileName };
  }

  /**
   * 按 docId 取回厂商导出件字节（完整链路：签 ticket → 换 session token → Bearer 导出）。
   * 实测：导出件不含页眉/页脚（SDK 能力边界），但正文零丢字，保真度可接受。
   * 本方法只做单次导出；版本新鲜度由上层 syncExportVersion 按 SHA 比对重试保障。
   */
  async exportDocument(docId: string, externalSubject: string, origin: string): Promise<{ buffer: Buffer; fileName: string }> {
    // 1. 签 ticket
    const ticketRes = await this.request('/embed/tickets', {
      method: 'POST',
      body: {
        tenantKey: this.config.tenantKey,
        providerKey: this.config.providerKey,
        externalSubject,
        document: { docId },
        origin,
        permission: { scopes: ['document:read'] },
        ui: { readonly: true },
        watermark: { text: 'auto-export', opacity: 0.1 },
        expiresIn: 60,
      },
    });
    if (!ticketRes.ok || ticketRes.payload?.code !== 200 || !ticketRes.payload?.data) {
      throw new Error(`签 ticket 失败（HTTP ${ticketRes.status}）：${String(ticketRes.payload?.message || '未知原因')}`);
    }
    const ticketData = ticketRes.payload.data as { ticket?: string };
    if (!ticketData.ticket) {
      throw new Error('签 ticket 失败：未返回有效票据');
    }
    const ticket = ticketData.ticket;

    // 2. 换 session token（JWT）
    const sessionRes = await this.request('/embed/session', {
      method: 'POST',
      body: { ticket, origin },
      withSecret: false,
    });
    if (!sessionRes.ok || sessionRes.payload?.code !== 200 || !sessionRes.payload?.data) {
      throw new Error(`换 session token 失败（HTTP ${sessionRes.status}）：${String(sessionRes.payload?.message || '未知原因')}`);
    }
    const sessionData = sessionRes.payload.data as { token?: string };
    if (!sessionData.token) {
      throw new Error('换 session token 失败：未返回有效令牌');
    }
    const sessionToken = sessionData.token;

    // 3. 带 Bearer 调导出
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.api}/export/docx/${docId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
    } catch (error) {
      throw new Error(`连不上 JitWord 导出接口（${(error as Error)?.message || '网络错误'}）`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`导出接口返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 120)}` : ''}`);
    }
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
    if (!buffer.byteLength) throw new Error('导出接口返回空字节');

    // 文件名从 Content-Disposition 解析，回退到 docId.docx
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const fileName = match ? match[1] : `${docId}.docx`;
    return { buffer, fileName };
  }
}
