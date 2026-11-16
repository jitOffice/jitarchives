/**
 * 档案在线编辑集成模块（阶段二第三批）。
 * 依赖 ArchivesModule 导出的档案/附件仓储与受控存储；本模块提供 JitWord 客户端与文档服务。
 * 客户端工厂：测试注入 appOptions.jitwordClient（桩，不触网）；否则按配置构建真实客户端，
 * 未配置密钥时为 null，相应接口返回 503（不阻塞其余档案功能）。
 */
import { Module } from '@nestjs/common';
import { ArchivesModule } from '../archives/archives.module';
import { appOptions } from '../app-options';
import { loadJitWordConfig } from './jitword.config';
import { JITWORD_CLIENT, ArchiveDocumentService } from './archive-document.service';
import { RealJitWordClient, JitWordClient } from './jitword.client';
import { ArchiveDocumentController, JitWordStatusController } from './archive-document.controller';

function buildClient(): JitWordClient | null {
  if (appOptions.jitwordClient !== null && appOptions.jitwordClient !== undefined) {
    return appOptions.jitwordClient; // 测试注入的桩实现
  }
  const config = loadJitWordConfig();
  return config ? new RealJitWordClient(config) : null;
}

@Module({
  imports: [ArchivesModule],
  controllers: [JitWordStatusController, ArchiveDocumentController],
  providers: [
    { provide: JITWORD_CLIENT, useFactory: buildClient },
    ArchiveDocumentService,
  ],
})
export class JitWordModule {}
