/**
 * JitWord 服务端接口封装（零依赖，仅用 Node 内置 fetch）。
 * 依据官方文档：https://inner.jitword.com/ 第 06 节「服务端换票」
 *
 * 安全约束：
 *   - clientSecret 只在 X-Embed-Client-Secret 头里出现，不进入任何返回值；
 *   - 票据每次现签，禁止缓存（官方文档第 08 节第二条）。
 */

/** 演示环境的默认测试主体：文档创建者与换票主体必须一致（演示环境无 ACL 授权接口） */
export const DEFAULT_TEST_SUBJECT = 'stage1-verification-user';

const IDENTITIES = {
  editor: {
    role: 'editor',
    scopes: ['document:read', 'document:edit', 'comment:write'],
    readonly: false,
  },
  viewer: {
    role: 'viewer',
    scopes: ['document:read'],
    readonly: true,
  },
};

export const IDENTITY_NAMES = Object.keys(IDENTITIES);

export function identityProfile(identity) {
  const profile = IDENTITIES[identity];
  if (!profile) throw new Error(`未知测试身份：${identity}`);
  return profile;
}

export function createJitWordClient(config, { fetchImpl = fetch } = {}) {
  const secret = config.clientSecret;

  async function request(pathname, { method = 'GET', body, withSecret = true, headers = {} } = {}) {
    const url = `${config.api}${pathname}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(withSecret ? { 'X-Embed-Client-Secret': secret } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const detail = error?.cause?.code || error?.code || error?.message || '网络错误';
      const wrapped = new Error(`连不上 ${url}（${detail}）`);
      wrapped.network = true;
      throw wrapped;
    }
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    return { status: response.status, ok: response.ok, payload, text };
  }

  /** 能力清单 / 健康探针，无需鉴权 */
  async function manifest() {
    const res = await request('/embed/manifest', { withSecret: false });
    if (!res.ok) throw new Error(`manifest 不可用（HTTP ${res.status}）`);
    return res.payload?.data || {};
  }

  /** 创建“仅测试”专属文档，返回 docId */
  async function createDocument({ name, externalSubject = DEFAULT_TEST_SUBJECT }) {
    const res = await request('/embed/documents', {
      method: 'POST',
      body: {
        type: 'document',
        name,
        externalSubject,
        tenantKey: config.tenantKey,
        providerKey: config.providerKey,
      },
    });
    if (!res.ok || res.payload?.code !== 200 || !res.payload?.data?.docId) {
      throw new Error(`创建文档失败（HTTP ${res.status}）：${res.payload?.message || '未知原因'}`);
    }
    return res.payload.data;
  }

  /** 用 clientSecret 换一次性票据；每次调用都是一张新票
   *  注意：externalSubject 必须是文档创建者（演示环境未提供 ACL 授权接口），
   *  编辑/只读两种测试身份靠 permission.role + scopes + ui.readonly 区分。
   */
  async function createTicket({ docId, origin, identity, expiresIn = 120, externalSubject = DEFAULT_TEST_SUBJECT }) {
    const profile = identityProfile(identity);
    const body = {
      tenantKey: config.tenantKey,
      providerKey: config.providerKey,
      externalSubject: externalSubject || DEFAULT_TEST_SUBJECT,
      user: { displayName: `阶段一${profile.role === 'editor' ? '编辑' : '只读'}身份` },
      document: { docId },
      permission: { role: profile.role, scopes: profile.scopes },
      ui: { readonly: profile.readonly },
      watermark: { text: `仅测试 · ${profile.role === 'editor' ? '编辑' : '只读'}身份`, opacity: 0.12 },
      origin,
      expiresIn,
    };
    const res = await request('/embed/tickets', { method: 'POST', body });
    if (!res.ok || res.payload?.code !== 200 || !res.payload?.data?.ticket) {
      const error = new Error(res.payload?.message || `换票失败（HTTP ${res.status}）`);
      error.status = res.status;
      throw error;
    }
    return { ...res.payload.data, requestedScopes: profile.scopes, requestedRole: profile.role };
  }

  /** 诊断摘要：用于确认能力清单与存储健康（响应已脱敏） */
  async function diagnostics() {
    const res = await request(`/embed/diagnostics?tenantKey=${encodeURIComponent(config.tenantKey)}&providerKey=${encodeURIComponent(config.providerKey)}`);
    return { status: res.status, data: res.payload?.data ?? null, message: res.payload?.message ?? null };
  }

  /** 当前生效策略（授权域名、能力开关等），用于核对 origin 白名单与能力上限 */
  async function profile() {
    const res = await request(`/embed/profile/${encodeURIComponent(config.tenantKey)}/${encodeURIComponent(config.providerKey)}`);
    return { status: res.status, data: res.payload?.data ?? null, message: res.payload?.message ?? null };
  }

  /** 无密钥换票，用于反向验证（预期 401） */
  async function createTicketWithoutSecret(payload) {
    return request('/embed/tickets', { method: 'POST', body: payload, withSecret: false });
  }

  return { request, manifest, createDocument, createTicket, createTicketWithoutSecret, diagnostics, profile };
}
