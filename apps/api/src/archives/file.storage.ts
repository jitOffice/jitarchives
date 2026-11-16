/**
 * 档案附件受控文件存储（阶段二第二批）。
 * 安全设计：
 * - 物理文件名一律使用服务端随机标识（crypto 32hex + 白名单扩展名），用户输入不参与路径拼接；
 * - 所有读写先经 resolveInside() 校验 realpath 仍位于受控目录内，防路径穿越/符号链接逃逸；
 * - 上传流式落盘（Web Stream → File），内存占用与文件大小无关，超限即中止并清理临时文件；
 * - 目录不在任何静态资源托管范围内，只能经授权下载接口读取。
 */
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { appOptions } from '../app-options';
import { MAX_UPLOAD_MB } from '../config';

/**
 * 允许归档的基础格式（PRD 5.1「docx/doc/pdf/图片/压缩包等主流格式」的最小安全集合 + 纯文本）。
 * 其中 docx/xlsx/pptx/ofd/pdf/txt/md/html 与 JitWord-Preview 的预览能力对齐；
 * doc/xls/ppt/tif/tiff/zip 仅允许归档下载，不在线预览。
 */
export const ALLOWED_EXTENSIONS = [
  'docx',
  'doc',
  'pdf',
  'txt',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'ofd',
  'md',
  'html',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'zip',
] as const;

export interface StoredFileResult {
  storedName: string;
  size: number;
  sha256: string;
}

@Injectable()
export class FileStorage {
  private readonly maxBytes = MAX_UPLOAD_MB * 1024 * 1024;

  /** 受控存储根目录（运行时从 appOptions 读取，便于测试隔离）。 */
  get root(): string {
    const root = path.resolve(appOptions.fileStoreDir);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  get maxUploadBytes(): number {
    return this.maxBytes;
  }

  /** 生成服务端物理文件名：32 位随机 hex + 白名单扩展名。 */
  createStoredName(extension: string): string {
    const ext = extension.toLowerCase().replace(/[^a-z0-9]/g, '');
    return ext ? `${randomBytes(16).toString('hex')}.${ext}` : randomBytes(16).toString('hex');
  }

  isAllowedExtension(extension: string): boolean {
    const e = (extension || '').toLowerCase();
    return (ALLOWED_EXTENSIONS as readonly string[]).includes(e);
  }

  /**
   * 流式保存请求体：先写入 .uploading 临时文件并实时限流，
   * 成功后原子重命名进入正式目录；任何失败路径都会清理临时文件。
   */
  async saveStream(
    source: ReadableStream<Uint8Array>,
    extension: string,
  ): Promise<StoredFileResult> {
    const storedName = this.createStoredName(extension);
    const root = this.root;
    const tmp = path.join(root, `${storedName}.uploading`);
    const finalPath = path.join(root, storedName);
    try {
      const fileHandle = await fs.promises.open(tmp, 'w');
      const hash = createHash('sha256');
      let size = 0;
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value as Uint8Array;
          size += chunk.byteLength;
          if (size > this.maxBytes) {
            throw new FileStoreError(
              'too-large',
              `文件大小超出上限（${MAX_UPLOAD_MB}MB），上传已取消`,
            );
          }
          hash.update(chunk);
          await fileHandle.writeFile(chunk);
        }
      } finally {
        await fileHandle.close();
      }
      if (size === 0) {
        throw new FileStoreError('empty', '上传内容为空文件，已取消');
      }
      fs.renameSync(tmp, finalPath); // 同目录原子重命名，正式文件立即可用
      return { storedName, size, sha256: hash.digest('hex') };
    } catch (err) {
      this.tryDelete(tmp); // 失败清理临时文件，不留垃圾
      throw err;
    }
  }

  /** 校验并返回物理文件绝对路径；越出受控目录或文件缺失一律 null。 */
  resolveStored(storedName: string): string | null {
    if (!/^[0-9a-f]{32}(\.[a-z0-9]{1,10})?$/.test(storedName)) return null; // 严格白名单格式
    const root = this.root;
    const candidate = path.resolve(root, storedName);
    if (!candidate.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(candidate)) return null;
    const real = fs.realpathSync(candidate);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null; // 防符号链接逃逸
    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    return real;
  }

  /** 物理文件是否存在（授权下载前复核元数据一致性）。 */
  exists(storedName: string): boolean {
    return this.resolveStored(storedName) !== null;
  }

  tryDelete(storedNameOrPath: string): void {
    try {
      fs.rmSync(storedNameOrPath, { force: true });
    } catch {
      /* Windows 句柄未释放等场景容错 */
    }
  }

  /**
   * 按受控命名规则删除物理文件（档案删除后的清场）。
   * 只接受服务端生成的 32hex(+白名单扩展名) 名称：脏数据/被篡改的名字直接跳过，
   * 绝不把外部字符串拼进路径，避免误删存储目录外的文件。
   */
  deleteStored(storedName: string): void {
    if (!/^[0-9a-f]{32}(\.[a-z0-9]{1,10})?$/.test(String(storedName ?? ''))) return;
    this.tryDelete(path.join(this.root, storedName));
  }
}

/** 文件存储层业务错误（由 service 映射为 HTTP 语义）。 */
export class FileStoreError extends Error {
  constructor(
    public readonly reason: 'too-large' | 'empty',
    message: string,
  ) {
    super(message);
  }
}
