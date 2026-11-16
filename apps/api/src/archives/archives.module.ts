/**
 * 档案核心业务模块（阶段二第二批 + 第三批 + 第四批扩展）。
 * 覆盖：分类 / 著录 / 附件 / 检索 / 在线文档关联与版本 / 元数据模板 / 档案级访问 / 借阅闭环。
 * 仓储抽象沿用既有模式：控制器/服务只依赖抽象 Token，SQLite 绑定集中于此，切换 PostgreSQL 替换 useClass 即可。
 * 第四批新增的访问控制服务与借阅/模板仓储一并在此注册；ArchiveAccessService 导出供 JitWordModule 复用。
 * 第二阶段新增的附件正文索引（ContentIndexService / ContentIndexRepository）也归入本模块，
 * 供档案上传、在线版本入库与 Agent 问答共用同一份索引链路。
 * 第三阶段：Agent 受控工具需要复用借阅与模板能力，故一并导出 BorrowingService /
 * BorrowRequestRepository / MetadataTemplatesService（仍由 ArchivesModule 单一实例提供，不重复注册业务链路）。
 */
import { Module } from '@nestjs/common';
import {
  CategoryRepository,
  SqliteCategoryRepository,
  ArchiveRepository,
  SqliteArchiveRepository,
  FileRepository,
  SqliteFileRepository,
} from './archive.repositories';
import { FileStorage } from './file.storage';
import { ArchivesService } from './archives.service';
import { ArchiveAccessService } from './archive-access.service';
import { CategoriesController } from './categories.controller';
import { ArchivesController } from './archives.controller';
import { ArchiveFilesController } from './archive-files.controller';
import {
  DocumentRepository,
  SqliteDocumentRepository,
  VersionRepository,
  SqliteVersionRepository,
} from '../jitword/jitword.repositories';
import {
  TemplateRepository,
  SqliteTemplateRepository,
  TemplateFieldRepository,
  SqliteTemplateFieldRepository,
  CategoryTemplateRepository,
  SqliteCategoryTemplateRepository,
  ArchiveFieldValueRepository,
  SqliteArchiveFieldValueRepository,
} from '../templates/template.repositories';
import { MetadataTemplatesService } from '../templates/metadata-templates.service';
import {
  MetadataTemplatesController,
  CategoryTemplateController,
} from '../templates/metadata-templates.controller';
import {
  BorrowRequestRepository,
  SqliteBorrowRequestRepository,
  BorrowGrantRepository,
  SqliteBorrowGrantRepository,
} from '../borrowing/borrowing.repositories';
import { BorrowingService } from '../borrowing/borrowing.service';
import { BorrowingController } from '../borrowing/borrowing.controller';

import {
  ContentIndexRepository,
  SqliteContentIndexRepository,
} from './content/content-index.repositories';
import { ContentIndexService } from './content/content-index.service';
import { EMBEDDING_CLIENT, HttpEmbeddingClient } from '../knowledge/embedding.client';
import { KnowledgeSearchService } from '../knowledge/knowledge-search.service';
import { KnowledgeWorker } from '../knowledge/knowledge-worker.service';
import { appOptions } from '../app-options';
import { ContentKeywordSearchService } from '../search/content-keyword-search.service';
import { UnifiedSearchService } from '../search/unified-search.service';
import {
  UnifiedSearchRepository,
  SqliteUnifiedSearchRepository,
} from '../search/unified-search.repositories';

@Module({
  controllers: [
    CategoriesController,
    ArchivesController,
    ArchiveFilesController,
    MetadataTemplatesController,
    CategoryTemplateController,
    BorrowingController,
  ],
  providers: [
    ArchivesService,
    ArchiveAccessService,
    FileStorage,
    ContentIndexService,
    ContentKeywordSearchService,
    KnowledgeSearchService,
    KnowledgeWorker,
    { provide: EMBEDDING_CLIENT, useFactory: () => appOptions.embeddingClient ?? new HttpEmbeddingClient() },
    MetadataTemplatesService,
    BorrowingService,
    // 统一检索（第一批）：只调度不重建，复用本模块已有服务与仓储
    UnifiedSearchService,
    { provide: UnifiedSearchRepository, useClass: SqliteUnifiedSearchRepository },
    { provide: CategoryRepository, useClass: SqliteCategoryRepository },
    { provide: ArchiveRepository, useClass: SqliteArchiveRepository },
    { provide: FileRepository, useClass: SqliteFileRepository },
    { provide: DocumentRepository, useClass: SqliteDocumentRepository },
    { provide: VersionRepository, useClass: SqliteVersionRepository },
    { provide: TemplateRepository, useClass: SqliteTemplateRepository },
    { provide: TemplateFieldRepository, useClass: SqliteTemplateFieldRepository },
    { provide: CategoryTemplateRepository, useClass: SqliteCategoryTemplateRepository },
    { provide: ArchiveFieldValueRepository, useClass: SqliteArchiveFieldValueRepository },
    { provide: BorrowRequestRepository, useClass: SqliteBorrowRequestRepository },
    { provide: BorrowGrantRepository, useClass: SqliteBorrowGrantRepository },
    { provide: ContentIndexRepository, useClass: SqliteContentIndexRepository },
  ],
  exports: [
    ArchivesService,
    ArchiveAccessService,
    FileStorage,
    ContentIndexService,
    ContentIndexRepository,
    ContentKeywordSearchService,
    KnowledgeSearchService,
    KnowledgeWorker,
    CategoryRepository,
    ArchiveRepository,
    FileRepository,
    DocumentRepository,
    VersionRepository,
    BorrowingService,
    BorrowRequestRepository,
    MetadataTemplatesService,
    UnifiedSearchService,
  ],
})
export class ArchivesModule {}
