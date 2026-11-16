/**
 * 旧版 Word（.doc）→ OOXML（.docx）转换。
 * JitWord 编辑器的 importDocx 只接受 OOXML 包，因此 `.doc` 附件在导入前必须先转换。
 * 使用 reamkit（纯 JS/WASM 无关，无 LibreOffice/Office 依赖）解析二进制 DOC 并写回 DOCX。
 *
 * 注意：本仓库后端编译为 CommonJS，而 reamkit 仅提供 ESM 入口；直接 `import()` 会被
 * TypeScript 降级为 require() 并触发 ERR_PACKAGE_PATH_NOT_EXPORTED。这里用原生动态
 * import 加载一次并缓存，避免引入额外构建步骤或依赖运行时次版本特性。
 */
import { BadRequestException } from '@nestjs/common';

type ReamModule = typeof import('reamkit');

let reamPromise: Promise<ReamModule> | null = null;

function loadReam(): Promise<ReamModule> {
  if (!reamPromise) {
    const nativeImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<ReamModule>;
    reamPromise = nativeImport('reamkit').catch((error) => {
      reamPromise = null;
      throw error;
    });
  }
  return reamPromise;
}

/**
 * 把旧版 .doc 字节转换为 .docx 字节。
 * 转换失败时如实抛出可读原因，不返回空文件或伪造正文。
 */
export async function convertDocToDocx(buffer: Buffer): Promise<Buffer> {
  if (!buffer?.length) throw new BadRequestException('DOC 文件为空，无法转换');
  let Ream: ReamModule['Ream'];
  try {
    ({ Ream } = await loadReam());
  } catch (error) {
    throw new BadRequestException(
      `DOC 转换组件加载失败：${(error as Error)?.message || '未知错误'}`,
    );
  }
  try {
    const parsed = Ream.parse(new Uint8Array(buffer));
    // 扩展名为 .doc、真实字节却是 OOXML 的文件：直接按 DOCX 使用，避免误报转换失败。
    if (parsed.format === 'docx') return buffer;
    if (parsed.format !== 'doc') {
      throw new Error(`文件真实格式为 ${parsed.format || '未知'}，不是旧版 DOC`);
    }
    const converted = await parsed.convert('docx');
    const out = Buffer.from(converted);
    if (!out.length) throw new Error('转换结果为空');
    return out;
  } catch (error) {
    throw new BadRequestException(
      `旧版 .doc 转换失败：${(error as Error)?.message || '文档结构无法解析'}`,
    );
  }
}
