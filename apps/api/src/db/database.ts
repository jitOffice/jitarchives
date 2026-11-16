/**
 * 数据库接入层：SQLite（Node 22.5+ 内置 node:sqlite，零原生依赖）。
 *
 * 扩展边界说明（PRD 6.2）：
 * - 上层业务只通过 UserRepository / SessionRepository 接口访问数据；
 * - 本批提供 SQLite 实现；后续切换 PostgreSQL 时新增实现类并替换 DI Provider 即可，
 *   不改动 service / controller 代码。
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { appOptions } from '../app-options';
import { buildCjkBigramTerms } from '../search/cjk-bigram';

/** Nest DI Token：共享数据库连接。 */
export const DATABASE = 'JIT_DATABASE';

/** 迁移清单：按顺序执行，已记录的跳过。这是本批唯一的建表/迁移入口。 */
const MIGRATIONS: ReadonlyArray<{ id: string; sql: string; foreignKeysOff?: boolean }> = [
  {
    id: '001-init',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE,
        display_name  TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK (role IN ('admin','cataloger','reviewer','borrower','guest')),
        status        TEXT    NOT NULL CHECK (status IN ('active','disabled')) DEFAULT 'active',
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT    NOT NULL,
        expires_at INTEGER NOT NULL,
        ip         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `,
  },
  {
    // 阶段二第二批：档案核心业务表（分类 / 档案 / 附件）。
    // 字段集合以 PRD 5.1/5.2 为基线；档号规则与状态集属于补充工程设计（已在验收报告声明）。
    id: '002-archive-core',
    sql: `
      CREATE TABLE IF NOT EXISTS archive_categories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
        code        TEXT    NOT NULL CHECK (length(code) BETWEEN 1 AND 20),
        description TEXT    NOT NULL DEFAULT '',
        parent_id   INTEGER REFERENCES archive_categories(id),
        created_by  INTEGER REFERENCES users(id),
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      );
      -- 同级分类名称/编码唯一（部分索引：NULL 父级表示顶层，用哨兵值 -1 参与唯一约束）
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_category_name
        ON archive_categories (COALESCE(parent_id, -1), name);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_category_code
        ON archive_categories (COALESCE(parent_id, -1), code);

      CREATE TABLE IF NOT EXISTS archives (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        archive_no      TEXT    NOT NULL UNIQUE,
        category_id     INTEGER NOT NULL REFERENCES archive_categories(id),
        archive_type    TEXT    NOT NULL DEFAULT '文书档案',
        keywords        TEXT    NOT NULL DEFAULT '',
        formation_date  TEXT,
        responsible     TEXT    NOT NULL DEFAULT '',
        remarks         TEXT    NOT NULL DEFAULT '',
        status          TEXT    NOT NULL CHECK (status IN ('draft','archived')) DEFAULT 'draft',
        created_by      INTEGER NOT NULL REFERENCES users(id),
        updated_by      INTEGER NOT NULL REFERENCES users(id),
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_archives_category ON archives(category_id);
      CREATE INDEX IF NOT EXISTS idx_archives_status ON archives(status);
      CREATE INDEX IF NOT EXISTS idx_archives_created ON archives(created_at DESC);

      CREATE TABLE IF NOT EXISTS archive_files (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id     INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        original_name  TEXT    NOT NULL,
        stored_name    TEXT    NOT NULL UNIQUE,
        extension      TEXT    NOT NULL,
        file_size      INTEGER NOT NULL CHECK (file_size >= 0),
        content_type   TEXT    NOT NULL DEFAULT '',
        sha256         TEXT    NOT NULL DEFAULT '',
        uploaded_by    INTEGER NOT NULL REFERENCES users(id),
        uploaded_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_archive ON archive_files(archive_id);
    `,
  },
  {
    // 阶段二第三批：档案 ↔ JitWord 在线文档关联 + 在线编辑成果的文件版本。
    // 最小扩展，不改动 001/002 既有表与数据；一档案最多一条关联（UNIQUE 保证幂等）。
    id: '003-jitword-docs',
    sql: `
      CREATE TABLE IF NOT EXISTS archive_documents (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id        INTEGER NOT NULL UNIQUE REFERENCES archives(id) ON DELETE CASCADE,
        doc_id            TEXT    NOT NULL,
        doc_name          TEXT    NOT NULL,
        external_subject  TEXT    NOT NULL,
        creator_user_id   INTEGER NOT NULL REFERENCES users(id),
        edit_state        TEXT    NOT NULL CHECK (edit_state IN ('linked','editing','saved','unsupported')) DEFAULT 'linked',
        source_file_id    INTEGER REFERENCES archive_files(id),
        created_at        TEXT    NOT NULL,
        last_saved_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_documents_archive ON archive_documents(archive_id);

      CREATE TABLE IF NOT EXISTS archive_file_versions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id      INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        document_id     INTEGER REFERENCES archive_documents(id),
        source_file_id  INTEGER REFERENCES archive_files(id),
        stored_name     TEXT    NOT NULL UNIQUE,
        version_no      INTEGER NOT NULL,
        sha256          TEXT    NOT NULL,
        file_size       INTEGER NOT NULL CHECK (file_size >= 0),
        origin          TEXT    NOT NULL CHECK (origin IN ('upload','jitword_export_reupload')),
        created_by      INTEGER NOT NULL REFERENCES users(id),
        created_at      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_versions_archive ON archive_file_versions(archive_id);
    `,
  },
  {
    // 阶段二第四批 · 功能一：可配置元数据模板。
    // 独立新表，不改动 001/002/003 既有表与数据；字段按 field_id 引用并冗余 field_key，
    // 保证模板字段改名/停用后历史著录值不丢失（变更保护）。
    id: '004-metadata-templates',
    sql: `
      CREATE TABLE IF NOT EXISTS metadata_templates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL CHECK (status IN ('active','disabled')) DEFAULT 'active',
        created_by  INTEGER NOT NULL REFERENCES users(id),
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_template_name ON metadata_templates(name);

      CREATE TABLE IF NOT EXISTS template_fields (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id     INTEGER NOT NULL REFERENCES metadata_templates(id) ON DELETE CASCADE,
        field_key       TEXT    NOT NULL CHECK (length(field_key) BETWEEN 1 AND 40),
        label           TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 50),
        type            TEXT    NOT NULL CHECK (type IN ('text','textarea','number','date','select','bool','tags')),
        required        INTEGER NOT NULL CHECK (required IN (0,1)) DEFAULT 0,
        options_json    TEXT    NOT NULL DEFAULT '[]',
        validation_json TEXT    NOT NULL DEFAULT '{}',
        sort_no         INTEGER NOT NULL DEFAULT 0,
        active          INTEGER NOT NULL CHECK (active IN (0,1)) DEFAULT 1,
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL,
        UNIQUE (template_id, field_key)
      );
      CREATE INDEX IF NOT EXISTS idx_fields_template ON template_fields(template_id, sort_no);

      -- 分类 ↔ 模板绑定：一个分类至多绑定一个模板（主键即唯一约束）。
      CREATE TABLE IF NOT EXISTS archive_category_templates (
        category_id INTEGER PRIMARY KEY REFERENCES archive_categories(id) ON DELETE CASCADE,
        template_id INTEGER NOT NULL REFERENCES metadata_templates(id),
        updated_at  TEXT    NOT NULL
      );

      -- 档案动态著录值：按 field_id 引用，冗余 field_key 以便字段停用后仍可展示历史值。
      CREATE TABLE IF NOT EXISTS archive_field_values (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        field_id   INTEGER NOT NULL REFERENCES template_fields(id),
        field_key  TEXT    NOT NULL,
        value_text TEXT    NOT NULL DEFAULT '',
        updated_at TEXT    NOT NULL,
        UNIQUE (archive_id, field_id)
      );
      CREATE INDEX IF NOT EXISTS idx_field_values_archive ON archive_field_values(archive_id);
    `,
  },
  {
    // 阶段二第四批 · 功能二/三/四/五：档案级访问控制 + 借阅闭环。
    // archives 追加 access_level（默认 public → 存量档案向后兼容，不改动既有行数据语义）。
    id: '005-borrowing',
    sql: `
      ALTER TABLE archives
        ADD COLUMN access_level TEXT NOT NULL DEFAULT 'public'
        CHECK (access_level IN ('public','restricted'));

      CREATE TABLE IF NOT EXISTS borrow_requests (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id   INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        applicant_id INTEGER NOT NULL REFERENCES users(id),
        purpose      TEXT    NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
        days         INTEGER NOT NULL CHECK (days BETWEEN 1 AND 90),
        start_at     TEXT,
        due_at       TEXT,
        status       TEXT    NOT NULL CHECK (status IN ('pending','approved','rejected','returned','expired','cancelled')) DEFAULT 'pending',
        review_note  TEXT    NOT NULL DEFAULT '',
        reviewer_id  INTEGER REFERENCES users(id),
        reviewed_at  TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );
      -- 服务端硬性阻止同一用户对同一档案重复创建待处理申请（部分唯一索引）。
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_borrow
        ON borrow_requests(archive_id, applicant_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_borrow_applicant ON borrow_requests(applicant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_borrow_status ON borrow_requests(status, created_at DESC);

      -- 审核通过后建立的档案级受控借阅授权（view/download 范围 + 有效期 + 状态）。
      CREATE TABLE IF NOT EXISTS borrow_grants (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        borrow_id     INTEGER NOT NULL REFERENCES borrow_requests(id) ON DELETE CASCADE,
        archive_id    INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        user_id       INTEGER NOT NULL REFERENCES users(id),
        can_view      INTEGER NOT NULL CHECK (can_view IN (0,1)) DEFAULT 1,
        can_download  INTEGER NOT NULL CHECK (can_download IN (0,1)) DEFAULT 1,
        granted_at    TEXT    NOT NULL,
        expires_at    TEXT    NOT NULL,
        status        TEXT    NOT NULL CHECK (status IN ('active','revoked','expired','returned')) DEFAULT 'active',
        updated_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_grants_user_archive
        ON borrow_grants(user_id, archive_id, status, expires_at);
    `,
  },
  {
    // 阶段二第五批 · 功能一：基础操作审计日志。
    // 独立追加式审计表（单库内逻辑独立存储），与业务写入共享同一 SQLite 连接，
    // 使关键状态变更可在同一事务内一并落审计（见 db/transaction.ts 与 audit 模块）。
    // 仅追加、无删除入口：V1.0 以「不清理」天然满足 PRD 第八章「保留不少于 6 个月」。
    id: '006-audit',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER REFERENCES users(id),
        actor_role    TEXT,
        action        TEXT    NOT NULL,
        object_type   TEXT    NOT NULL,
        object_id     TEXT,
        result        TEXT    NOT NULL CHECK (result IN ('success','failure')),
        detail        TEXT    NOT NULL DEFAULT '',
        ip            TEXT,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_logs(action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_logs(object_type, object_id);
    `,
  },
  {
    // 保存后自动入库：archive_file_versions.origin 新增 'jitword_auto_export'。
    // SQLite 无法就地修改 CHECK 约束，按官方表重建步骤处理：建新表 → 全量拷贝 → 换名 → 重建索引。
    // 仅放宽取值集，既有行数据与版本号保持不变。
    id: '007-jitword-auto-export-origin',
    sql: `
      PRAGMA foreign_keys = OFF;

      CREATE TABLE archive_file_versions_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id      INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        document_id     INTEGER REFERENCES archive_documents(id),
        source_file_id  INTEGER REFERENCES archive_files(id),
        stored_name     TEXT    NOT NULL UNIQUE,
        version_no      INTEGER NOT NULL,
        sha256          TEXT    NOT NULL,
        file_size       INTEGER NOT NULL CHECK (file_size >= 0),
        origin          TEXT    NOT NULL CHECK (origin IN ('upload','jitword_export_reupload','jitword_auto_export')),
        created_by      INTEGER NOT NULL REFERENCES users(id),
        created_at      TEXT    NOT NULL
      );

      INSERT INTO archive_file_versions_new
        (id, archive_id, document_id, source_file_id, stored_name, version_no, sha256, file_size, origin, created_by, created_at)
        SELECT id, archive_id, document_id, source_file_id, stored_name, version_no, sha256, file_size, origin, created_by, created_at
          FROM archive_file_versions;

      DROP TABLE archive_file_versions;
      ALTER TABLE archive_file_versions_new RENAME TO archive_file_versions;
      CREATE INDEX IF NOT EXISTS idx_versions_archive ON archive_file_versions(archive_id);

      PRAGMA foreign_keys = ON;
    `,
  },
  {
    // 在线编辑首次载入正文：记录「附件正文已灌入远端文档」的时间。
    // 仅新增可空列，存量行默认 NULL（= 尚未导入过），不改动既有列与数据。
    // 用途：前端据此判断是否需要在打开编辑器时自动 importDocx，避免覆盖用户已有编辑内容。
    id: '008-doc-seeded-at',
    sql: `
      ALTER TABLE archive_documents ADD COLUMN seeded_at TEXT;
    `,
  },
  {
    // 在线编辑按源文件区分：同一档案可分别对多个 .doc/.docx 附件建立关联，
    // 由用户选择要编辑哪一个；原 UNIQUE(archive_id) 升级为 UNIQUE(archive_id, source_file_id)。
    // archive_file_versions.document_id 仍引用本表，重建时需临时关闭外键约束。
    id: '009-doc-per-source-file',
    foreignKeysOff: true,
    sql: `
      CREATE TABLE archive_documents_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id        INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        doc_id            TEXT    NOT NULL,
        doc_name          TEXT    NOT NULL,
        external_subject  TEXT    NOT NULL,
        creator_user_id   INTEGER NOT NULL REFERENCES users(id),
        edit_state        TEXT    NOT NULL CHECK (edit_state IN ('linked','editing','saved','unsupported')) DEFAULT 'linked',
        source_file_id    INTEGER REFERENCES archive_files(id),
        created_at        TEXT    NOT NULL,
        last_saved_at     TEXT,
        seeded_at         TEXT,
        UNIQUE (archive_id, source_file_id)
      );

      INSERT INTO archive_documents_new
        (id, archive_id, doc_id, doc_name, external_subject, creator_user_id,
         edit_state, source_file_id, created_at, last_saved_at, seeded_at)
        SELECT id, archive_id, doc_id, doc_name, external_subject, creator_user_id,
               edit_state, source_file_id, created_at, last_saved_at, seeded_at
          FROM archive_documents;

      DROP TABLE archive_documents;
      ALTER TABLE archive_documents_new RENAME TO archive_documents;
      CREATE INDEX IF NOT EXISTS idx_documents_archive ON archive_documents(archive_id);
      CREATE INDEX IF NOT EXISTS idx_documents_source ON archive_documents(archive_id, source_file_id);
    `,
  },
  {
    // 档案 Agent 助理（第一阶段）：对话式查档的会话与消息持久化。
    // 独立新表，不改动既有档案/用户表；会话按用户隔离（所有读取一律带 user_id 条件），
    // 消息只存结构化检索结果引用（archiveId / 快照字段），不存附件正文。
    // client_request_id：前端提交幂等键，同一会话内重复提交返回已生成的回复，不产生重复消息；
    // 允许 NULL（部分唯一索引仅约束非空值）。
    id: '104-agent-conversations',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT    NOT NULL DEFAULT '新对话',
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_conv_user ON agent_conversations(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_messages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        role             TEXT    NOT NULL CHECK (role IN ('user','assistant')),
        content          TEXT    NOT NULL DEFAULT '',
        payload_json     TEXT,
        client_request_id TEXT,
        created_at       TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_msg_conv ON agent_messages(conversation_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_client_request
        ON agent_messages(conversation_id, client_request_id) WHERE client_request_id IS NOT NULL;
    `,
  },
  {
    // 第二阶段：附件正文索引（全文检索 + AI 内容问答的证据来源）。
    // 设计要点：
    // - archive_content_units 以「物理文件 stored_name」为唯一索引单元：一次上传/一次在线入库/
    //   一次在线版本入库都会产生新的物理文件名，因此 UNIQUE(stored_name) 天然避免重复索引同一版本；
    // - status 明确区分 indexed / no_text / unsupported / corrupt / encrypted / scanned / failed，
    //   对扫描件与不支持格式给出可读原因（不做 OCR，绝不拿文件名或档案标题冒充正文）；
    // - archive_content_chunks 保存切分后的正文片段与来源位置（段落号 / 行号 / 页码），
    //   仅随 unit 级联删除；全文倒排索引由 FTS5（trigram 分词，支持中文）单独承载，见 ensureContentFts。
    // 新表不参与既有业务写入，档案删除时由 purge 一并清理（不建外键级联到 archives，
    // 与既有 generated_document_records 等引用表保持一致的显式清理策略）。
    id: '105-content-index',
    sql: `
      CREATE TABLE IF NOT EXISTS archive_content_units (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id  INTEGER NOT NULL,
        file_id     INTEGER NOT NULL,
        version_id  INTEGER,
        version_no  INTEGER,
        stored_name TEXT    NOT NULL UNIQUE,
        sha256      TEXT    NOT NULL DEFAULT '',
        extension   TEXT    NOT NULL DEFAULT '',
        extractor   TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL CHECK (status IN ('indexed','no_text','unsupported','corrupt','encrypted','scanned','failed')),
        message     TEXT    NOT NULL DEFAULT '',
        char_count  INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        truncated   INTEGER NOT NULL DEFAULT 0,
        indexed_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_content_units_archive ON archive_content_units(archive_id);
      CREATE INDEX IF NOT EXISTS idx_content_units_file ON archive_content_units(file_id);

      CREATE TABLE IF NOT EXISTS archive_content_chunks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id    INTEGER NOT NULL REFERENCES archive_content_units(id) ON DELETE CASCADE,
        archive_id INTEGER NOT NULL,
        file_id    INTEGER NOT NULL,
        chunk_no   INTEGER NOT NULL,
        locator    TEXT    NOT NULL,
        page_no    INTEGER,
        pos_from   INTEGER,
        pos_to     INTEGER,
        text       TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_chunk ON archive_content_chunks(unit_id, chunk_no);
      CREATE INDEX IF NOT EXISTS idx_content_chunks_archive ON archive_content_chunks(archive_id);
      CREATE INDEX IF NOT EXISTS idx_content_chunks_file ON archive_content_chunks(file_id);
    `,
  },
  {
    // 第三阶段：Agent 待确认业务动作（智能借阅申请 / 智能辅助著录）。
    // 设计要点：
    // - 待执行内容由服务端生成并保存（token 定位），确认接口只接受 token + 会话归属，
    //   不接受大模型直接给出的 archiveId / userId / 角色，避免「模型说提交就提交」；
    // - status 单向流转 pending → running → executed / cancelled / failed，
    //   其中 running 由条件更新（WHERE status='pending'）抢占，重复点击影响 0 行，天然防重复申请；
    // - 本表只存「待办草稿」，不存借阅/档案业务数据本身：业务事实仍以 borrow_requests / archives 为准；
    // - 随会话级联删除（会话是草稿的唯一归属），不影响既有业务表结构。
    id: '106-agent-pending-actions',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_pending_actions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        token           TEXT    NOT NULL UNIQUE,
        conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL,
        tool            TEXT    NOT NULL CHECK (tool IN ('borrow.request','archive.catalog_save')),
        payload_json    TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','running','executed','cancelled','failed')),
        result_json     TEXT,
        error           TEXT    NOT NULL DEFAULT '',
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_pending_conv ON agent_pending_actions(conversation_id, status);
      CREATE INDEX IF NOT EXISTS idx_agent_pending_user ON agent_pending_actions(user_id, status);
    `,
  },
  {
    // 个人 AI 设置：每个用户可保存多个服务商配置，但同一时间最多启用一个。
    // API Key 只保存 AES-256-GCM 密文；user_id 外键保证用户删除时级联清理。
    id: '107-user-ai-provider-settings',
    sql: `
      CREATE TABLE IF NOT EXISTS user_ai_provider_configs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider          TEXT    NOT NULL CHECK (provider IN ('deepseek','kimi','qwen')),
        api_base          TEXT    NOT NULL,
        model             TEXT    NOT NULL,
        api_key_encrypted TEXT    NOT NULL,
        enabled           INTEGER NOT NULL CHECK (enabled IN (0,1)) DEFAULT 0,
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL,
        UNIQUE (user_id, provider)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_ai_active_provider
        ON user_ai_provider_configs(user_id) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_user_ai_provider_user
        ON user_ai_provider_configs(user_id, updated_at DESC);
    `,
  },
  {
    // 个人 AI 温度参数：每个服务商配置独立保存，兼容旧配置默认值 0.7。
    id: '108-user-ai-provider-temperature',
    sql: `
      ALTER TABLE user_ai_provider_configs
        ADD COLUMN temperature REAL NOT NULL DEFAULT 0.7
        CHECK (temperature >= 0 AND temperature <= 2);
    `,
  },
  {
    // 知识库 RAG 索引：为附件正文生成向量嵌入，支撑语义检索。
    // knowledge_index_jobs 跟踪每个文件的索引/嵌入状态与重试；knowledge_embeddings 按 chunk+model 存储向量。
    // pipeline_version 记录内容单元的处理流水线版本，便于后续升级时重跑。
    // 清理触发器：删除物理文件时级联清理对应的内容单元与片段。
    id: '109-knowledge-rag',
    sql: `
      ALTER TABLE archive_content_units ADD COLUMN pipeline_version TEXT NOT NULL DEFAULT '';
      CREATE TABLE knowledge_index_jobs (
        file_id INTEGER PRIMARY KEY REFERENCES archive_files(id) ON DELETE CASCADE,
        stored_name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','indexed','failed','unsupported')),
        attempts INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        embedding_status TEXT NOT NULL DEFAULT 'pending',
        embedding_attempts INTEGER NOT NULL DEFAULT 0,
        embedding_retry_at INTEGER NOT NULL DEFAULT 0,
        embedding_error TEXT NOT NULL DEFAULT '',
        embedding_model TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_knowledge_jobs_status ON knowledge_index_jobs(status, next_attempt_at);
      CREATE TABLE knowledge_embeddings (
        chunk_id INTEGER NOT NULL REFERENCES archive_content_chunks(id) ON DELETE CASCADE,
        model_key TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        text_hash TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        PRIMARY KEY(chunk_id, model_key)
      );
      CREATE INDEX idx_knowledge_embedding_model ON knowledge_embeddings(model_key);
      CREATE TRIGGER knowledge_file_cleanup BEFORE DELETE ON archive_files BEGIN
        DELETE FROM archive_content_chunks WHERE file_id = OLD.id;
        DELETE FROM archive_content_units WHERE file_id = OLD.id;
      END;
    `,
  },
  {
    // 知识库索引任务恢复：claim_token + lease 机制防止多实例重复处理；
    // knowledge_scan_state 记录扫描游标，支持增量扫描。
    id: '110-knowledge-job-recovery',
    sql: `
      ALTER TABLE knowledge_index_jobs ADD COLUMN claim_token TEXT NOT NULL DEFAULT '';
      ALTER TABLE knowledge_index_jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE knowledge_index_jobs ADD COLUMN embedding_lease_until INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE knowledge_scan_state (
        scan_key TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        high_watermark INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // 轻量 CJK Bigram 全文检索：为现有正文块增加可复用的词法 token 列。
    // 向量/Embedding 不属于 Agent 检索链路；索引词由统一 tokenizer 在应用层生成。
    id: '112-content-bigram-search-terms',
    sql: `
      ALTER TABLE archive_content_chunks ADD COLUMN search_terms TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // 登录注册与邀请码系统完善：
    // 1. users 表新增 email 字段（可空，向后兼容既有用户数据）。
    // 2. 建立 invitation_codes 邀请码主表：安全随机码、有效期、最大使用次数、状态管理。
    // 3. 建立 invitation_code_uses 使用记录表：追溯每次使用的用户与时间。
    // SQLite 不支持 ALTER TABLE ADD COLUMN + UNIQUE 约束一步到位，分两步：先加列再建唯一索引。
    id: '200-invitation-and-email',
    sql: `
      ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email ON users(email) WHERE email != '';

      CREATE TABLE IF NOT EXISTS invitation_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT    NOT NULL UNIQUE,
        created_at  TEXT    NOT NULL,
        expires_at  TEXT    NOT NULL,
        max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
        use_count   INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','exhausted')),
        created_by  INTEGER REFERENCES users(id),
        note        TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_invitation_codes_status ON invitation_codes(status);

      CREATE TABLE IF NOT EXISTS invitation_code_uses (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        invitation_code_id INTEGER NOT NULL REFERENCES invitation_codes(id) ON DELETE CASCADE,
        user_id           INTEGER NOT NULL REFERENCES users(id),
        username          TEXT    NOT NULL DEFAULT '',
        used_at           TEXT    NOT NULL,
        ip                TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invitation_uses_code ON invitation_code_uses(invitation_code_id);
      CREATE INDEX IF NOT EXISTS idx_invitation_uses_user ON invitation_code_uses(user_id);
    `,
  },
  {
    // 固定邀请码 + 浏览器指纹设备注册限制：
    // 1. registration_device_uses 记录每次成功注册的设备指纹摘要，UNIQUE 约束同一设备只能注册一次。
    // 2. fingerprint_hash 存储服务端 HMAC-SHA256 摘要，不存原始指纹（隐私保护）。
    id: '201-device-registration',
    sql: `
      CREATE TABLE IF NOT EXISTS registration_device_uses (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint_hash TEXT    NOT NULL UNIQUE,
        user_id          INTEGER NOT NULL REFERENCES users(id),
        created_at       TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reg_device_user ON registration_device_uses(user_id);
    `,
  },
  {
    // 知识图谱第一阶段 · 数据模型：两张核心表（节点 + 关系）。
    // 设计原则：
    // - 图谱只是「可重建的索引」，不重复保存档案/分类/附件的权威业务数据：节点通过
    //   node_type + biz_key（幂等键）与 ref_id 回指业务行，meta_json 仅存展示与溯源字段；
    // - 四类节点：category（分类）/ archive（档案）/ file（附件）/ chunk（附件正文知识块）；
    //   chunk 的 biz_key 取「物理文件名 + 片段序号」，同一物理版本重跑不会翻倍；
    // - 关系区分结构关系（category_contains_archive / archive_contains_file / file_contains_chunk，
    //   来自真实业务外键）与内容关系（chunk_similar_to / archive_related_to，来自 TF-IDF 余弦），
    //   外加基于真实著录字段等值命中的 archive_shared_reference；每条关系带权重、计算依据与证据；
    // - 节点不建到业务表的外键（与 archive_content_units 同一策略：业务数据不因图谱受限，
    //   图谱可整库重建），但业务行删除时由下方触发器即时清理，避免残留指向已删档案的幽灵节点；
    //   关系对节点保留 ON DELETE CASCADE，删节点即删关系，不留悬挂边。
    id: '210-knowledge-graph',
    sql: `
      CREATE TABLE IF NOT EXISTS kg_graph_nodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        node_type    TEXT    NOT NULL CHECK (node_type IN ('category','archive','file','chunk')),
        biz_key      TEXT    NOT NULL UNIQUE,
        ref_id       INTEGER NOT NULL,
        archive_id   INTEGER,
        file_id      INTEGER,
        name         TEXT    NOT NULL,
        meta_json    TEXT    NOT NULL DEFAULT '{}',
        source       TEXT    NOT NULL,
        content_hash TEXT    NOT NULL DEFAULT '',
        built_at     TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_archive ON kg_graph_nodes(archive_id, node_type);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_file ON kg_graph_nodes(file_id, node_type);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_ref ON kg_graph_nodes(node_type, ref_id);

      CREATE TABLE IF NOT EXISTS kg_graph_edges (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        edge_type       TEXT    NOT NULL CHECK (edge_type IN
                        ('category_contains_archive','archive_contains_file','file_contains_chunk',
                         'chunk_similar_to','archive_related_to','archive_shared_reference')),
        from_node       INTEGER NOT NULL REFERENCES kg_graph_nodes(id) ON DELETE CASCADE,
        to_node         INTEGER NOT NULL REFERENCES kg_graph_nodes(id) ON DELETE CASCADE,
        weight          REAL    NOT NULL DEFAULT 0,
        basis           TEXT    NOT NULL DEFAULT '',
        evidence_json   TEXT    NOT NULL DEFAULT '{}',
        from_archive_id INTEGER,
        to_archive_id   INTEGER,
        built_at        TEXT    NOT NULL,
        UNIQUE (edge_type, from_node, to_node),
        CHECK (from_node <> to_node)
      );
      CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_graph_edges(from_node, edge_type);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_to ON kg_graph_edges(to_node, edge_type);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_archive ON kg_graph_edges(from_archive_id, to_archive_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_rank ON kg_graph_edges(edge_type, weight DESC);

      -- 业务行删除即清理对应节点（关系由外键级联清理）：档案 / 附件 / 分类。
      CREATE TRIGGER IF NOT EXISTS kg_archive_cleanup AFTER DELETE ON archives BEGIN
        DELETE FROM kg_graph_nodes WHERE archive_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS kg_file_cleanup AFTER DELETE ON archive_files BEGIN
        DELETE FROM kg_graph_nodes WHERE file_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS kg_category_cleanup AFTER DELETE ON archive_categories BEGIN
        DELETE FROM kg_graph_nodes WHERE node_type = 'category' AND ref_id = OLD.id;
      END;
    `,
  },
  {
    // 第四阶段：图谱构建任务日志（轻量级可观测性，保留最近 100 条记录）。
    id: '211-kg-build-log',
    sql: `
      CREATE TABLE IF NOT EXISTS kg_build_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        build_type    TEXT NOT NULL CHECK (build_type IN ('full','incremental','cleanup')),
        status        TEXT NOT NULL CHECK (status IN ('running','success','failed')),
        archives      INTEGER NOT NULL DEFAULT 0,
        nodes         INTEGER NOT NULL DEFAULT 0,
        edges         INTEGER NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        started_at    TEXT NOT NULL,
        finished_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kg_build_log_time ON kg_build_log(started_at DESC);
    `,
  },
  {
    // 第四阶段：图谱查询性能索引（加速节点类型筛选、关系边类型查询、档案归属聚合）。
    id: '212-kg-perf-indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_graph_nodes(node_type);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_type_from_to ON kg_graph_edges(edge_type, from_node, to_node);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_from_archive ON kg_graph_edges(from_archive_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_to_archive ON kg_graph_edges(to_archive_id, edge_type);
    `,
  },
];

/**
 * 正文全文索引表（FTS5 + trigram 分词，可匹配中文子串）。
 * 不进 MIGRATIONS：部分 Node 内置 SQLite 构建未启用 FTS5，迁移失败会导致整个系统无法启动；
 * 这里以最佳努力创建，失败时由仓储层退回 LIKE 检索（功能可用，仅性能/排序降级）。
 * rowid 显式取 archive_content_chunks.id，删片段时按 rowid 精确同步，不留幽灵命中。
 */
export function ensureContentFts(db: DatabaseSync): boolean {
  // DDL, repair and marker commit together. A failed repair is never marked applied.
  db.exec('BEGIN IMMEDIATE');
  try {
    const existed = hasContentFts(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS archive_content_fts USING fts5(body, tokenize = 'trigram');
      CREATE TRIGGER IF NOT EXISTS content_fts_insert AFTER INSERT ON archive_content_chunks
      WHEN trim(NEW.text) <> '' AND EXISTS(SELECT 1 FROM archive_content_units WHERE id=NEW.unit_id AND status='indexed') BEGIN
        INSERT INTO archive_content_fts(rowid,body) VALUES(NEW.id,NEW.text);
      END;
      CREATE TRIGGER IF NOT EXISTS content_fts_update AFTER UPDATE ON archive_content_chunks BEGIN
        DELETE FROM archive_content_fts WHERE rowid=OLD.id;
        INSERT INTO archive_content_fts(rowid,body) SELECT NEW.id,NEW.text
          WHERE trim(NEW.text) <> '' AND EXISTS(SELECT 1 FROM archive_content_units WHERE id=NEW.unit_id AND status='indexed');
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_cleanup AFTER DELETE ON archive_content_chunks BEGIN
        DELETE FROM archive_content_fts WHERE rowid=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS content_fts_unit_status AFTER UPDATE OF status ON archive_content_units BEGIN
        DELETE FROM archive_content_fts WHERE rowid IN (SELECT id FROM archive_content_chunks WHERE unit_id=NEW.id);
        INSERT INTO archive_content_fts(rowid,body) SELECT id,text FROM archive_content_chunks
          WHERE unit_id=NEW.id AND NEW.status='indexed' AND trim(text) <> '';
      END;`);
    const marker = '111-content-fts-backfill';
    if (!existed || !db.prepare('SELECT 1 FROM _migrations WHERE id=?').get(marker)) {
      db.exec(`DELETE FROM archive_content_fts;
        INSERT INTO archive_content_fts(rowid,body)
        SELECT c.id,c.text FROM archive_content_chunks c JOIN archive_content_units u ON u.id=c.unit_id
          WHERE u.status='indexed' AND trim(c.text) <> '';`);
      db.prepare('INSERT OR REPLACE INTO _migrations(id,applied_at) VALUES(?,?)').run(marker,new Date().toISOString());
    }
    db.exec('COMMIT');
    return true;
  } catch {
    db.exec('ROLLBACK');
    console.warn('[db] 正文全文索引不可用，降级为 LIKE 匹配');
    return false;
  }
}

/** 正文全文索引是否可用（archive_content_fts 是否真实存在）。 */
export function hasContentFts(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = 'archive_content_fts'`)
    .get() as { ok?: number } | undefined;
  return !!row;
}

/**
 * Primary Agent lexical index: SQLite FTS5 over application-generated CJK bigrams.
 * search_terms is generated by the same tokenizer for both ingestion and query.
 * The legacy trigram table is retained for backward compatibility, but Agent search
 * uses this index exclusively and never calls an Embedding/vector service.
 */
export function ensureContentBigramFts(db: DatabaseSync): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existed = hasContentBigramFts(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS archive_content_fts_bigram
      USING fts5(terms, tokenize = 'unicode61 remove_diacritics 2');`);

    const marker = '113-content-bigram-fts-backfill';
    if (!existed || !db.prepare('SELECT 1 FROM _migrations WHERE id=?').get(marker)) {
      const rows = db.prepare('SELECT id, text, search_terms FROM archive_content_chunks').all() as Array<{
        id: number; text: string; search_terms: string;
      }>;
      const update = db.prepare('UPDATE archive_content_chunks SET search_terms=? WHERE id=?');
      for (const row of rows) {
        const terms = buildCjkBigramTerms(row.text ?? '');
        if (terms !== String(row.search_terms ?? '')) update.run(terms, Number(row.id));
      }
      db.exec(`DELETE FROM archive_content_fts_bigram;
        INSERT INTO archive_content_fts_bigram(rowid, terms)
        SELECT c.id, c.search_terms
          FROM archive_content_chunks c
          JOIN archive_content_units u ON u.id = c.unit_id
         WHERE u.status = 'indexed' AND trim(c.search_terms) <> '';`);
      db.prepare('INSERT OR REPLACE INTO _migrations(id,applied_at) VALUES(?,?)')
        .run(marker, new Date().toISOString());
    }

    db.exec(`CREATE TRIGGER IF NOT EXISTS content_bigram_insert
      AFTER INSERT ON archive_content_chunks
      WHEN trim(NEW.search_terms) <> '' AND EXISTS(
        SELECT 1 FROM archive_content_units WHERE id=NEW.unit_id AND status='indexed'
      ) BEGIN
        INSERT INTO archive_content_fts_bigram(rowid,terms) VALUES(NEW.id,NEW.search_terms);
      END;
      CREATE TRIGGER IF NOT EXISTS content_bigram_update
      AFTER UPDATE OF search_terms ON archive_content_chunks BEGIN
        DELETE FROM archive_content_fts_bigram WHERE rowid=OLD.id;
        INSERT INTO archive_content_fts_bigram(rowid,terms)
          SELECT NEW.id,NEW.search_terms
           WHERE trim(NEW.search_terms) <> '' AND EXISTS(
             SELECT 1 FROM archive_content_units WHERE id=NEW.unit_id AND status='indexed'
           );
      END;
      CREATE TRIGGER IF NOT EXISTS content_bigram_delete
      AFTER DELETE ON archive_content_chunks BEGIN
        DELETE FROM archive_content_fts_bigram WHERE rowid=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS content_bigram_unit_status
      AFTER UPDATE OF status ON archive_content_units BEGIN
        DELETE FROM archive_content_fts_bigram
         WHERE rowid IN (SELECT id FROM archive_content_chunks WHERE unit_id=NEW.id);
        INSERT INTO archive_content_fts_bigram(rowid,terms)
          SELECT id,search_terms FROM archive_content_chunks
           WHERE unit_id=NEW.id AND NEW.status='indexed' AND trim(search_terms) <> '';
      END;`);

    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    console.warn('[db] Bigram FTS5 不可用，正文检索将降级为 LIKE', (error as Error)?.message ?? error);
    return false;
  }
}

export function hasContentBigramFts(db: DatabaseSync): boolean {
  const row = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = 'archive_content_fts_bigram'`,
  ).get() as { ok?: number } | undefined;
  return !!row;
}

export function openDatabase(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  applyPendingMigrations(db);
  ensureContentFts(db);
  ensureContentBigramFts(db);
  return db;
}

function applyPendingMigrations(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  const applied = new Set<string>(
    (db.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>).map((r) => r.id),
  );
  const mark = db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // 表重建迁移需在事务外关闭外键约束（PRAGMA 在事务内不生效）。
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      mark.run(m.id, new Date().toISOString());
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    finally { if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON'); }
    console.log(`[db] 已应用迁移 ${m.id}`);
  }
}

/** DI Provider：按运行时选项打开（或创建）SQLite 数据库。 */
export const DatabaseProvider = {
  provide: DATABASE,
  useFactory: () => openDatabase(appOptions.dbFile),
};
