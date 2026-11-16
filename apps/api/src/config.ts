/**
 * JitArchives 正式系统后端运行配置。
 * 所有路径以编译产物 apps/api/dist 为基准解析，与启动目录无关。
 * 可通过环境变量覆盖：JIT_PORT / JIT_HOST / JIT_DB_FILE。
 */
import * as path from 'path';

/** 正式系统 API + 静态页面端口（避开阶段一验证页占用的 3000）。 */
export const PORT = Number(process.env.JIT_PORT || 5006);

/** 监听地址：默认仅本机。 */
export const HOST = process.env.JIT_HOST || '127.0.0.1';

/** SQLite 数据库文件路径（放入 storage/，已在 .gitignore 中排除）。 */
export const DB_FILE =
  process.env.JIT_DB_FILE || path.resolve(__dirname, '..', 'storage', 'jitarchives.db');

/**
 * 档案附件受控存储目录（阶段二第二批）：
 * - 绝不通过 useStaticAssets 公开为静态资源，只能经授权下载接口读取；
 * - 目录不存在时由文件服务自动创建；已在 .gitignore 的 storage/ 范围内排除。
 */
export const FILE_STORE_DIR =
  process.env.JIT_FILE_STORE || path.resolve(__dirname, '..', 'storage', 'file-store');

/**
 * 单文件上传上限（MB）。PRD 第八章性能需求为「单文档支持100MB」；
 * 采用流式落盘实现，内存占用与文件大小无关，默认按 100MB 目标落实，可用环境变量下调。
 */
export const MAX_UPLOAD_MB = Math.max(1, Number(process.env.JIT_MAX_UPLOAD_MB || 100));

/** 前端构建产物目录（apps/web/dist），存在时由本服务托管为正式系统页面。 */
export const WEB_DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');

/** 阶段一接入验证页地址（独立进程，仅用于启动横幅提示，防止端口混淆）。 */
export const LEGACY_DEMO_URL = 'http://127.0.0.1:3000';

/** 会话 Cookie 名与有效期。 */
export const SESSION_COOKIE = process.env.JIT_SESSION_COOKIE || 'jit_sid';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 小时

/** 系统展示信息（工作台使用，不含虚构统计）。 */
export const SYSTEM_INFO = {
  productName: 'JitArchives 智能电子档案管理系统',
  stage: '阶段二第三批：JitWord 正式档案在线编辑与归档集成',
  version: '0.2.0',
  techStack: {
    frontend: 'Vue 3 + TypeScript + Pinia',
    backend: 'NestJS + TypeScript',
    database: 'SQLite（node:sqlite，数据访问层已为 PostgreSQL 扩展保留接口边界）',
  },
};

/** 获取邀请码的公众号二维码图片 URL。 */
export const INVITATION_QR_URL =
  process.env.JIT_INVITATION_QR_URL || 'https://next.jitword.com/uploads/qrcode_19d716f2d29.jpg';

/** 公众号回复关键字（用户扫码关注公众号后回复此关键字获取邀请码）。 */
export const INVITE_REPLY_KEYWORD = process.env.JIT_INVITE_REPLY_KEYWORD || 'jitword168';

/** 固定注册邀请码：仅在后端校验，不通过任何接口暴露。 */
export const REGISTRATION_INVITE_CODE = process.env.JIT_REGISTRATION_INVITE_CODE || 'jitword168';

/**
 * 浏览器指纹 HMAC 密钥：服务端对前端传来的 visitorId 做 HMAC-SHA256 摘要后存储。
 * 数据库只保存摘要，不保存原始指纹。生产环境应通过环境变量设置随机值。
 */
export const DEVICE_FINGERPRINT_SECRET = process.env.DEVICE_FINGERPRINT_SECRET || 'jitarchives-dev-fp-default-secret';
