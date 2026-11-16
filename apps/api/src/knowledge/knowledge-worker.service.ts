import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DATABASE } from '../db/database';
import { ContentIndexService } from '../archives/content/content-index.service';
import { CURRENT_CONTENT_SQL } from '../archives/content/content-index.repositories';
import { EMBEDDING_CLIENT, EmbeddingClient, validVector } from './embedding.client';
import { appOptions } from '../app-options';
import { CONTENT_PIPELINE_VERSION } from '../archives/content/content.chunk';

@Injectable()
export class KnowledgeWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private active?: Promise<void>;
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(ContentIndexService) private readonly content: ContentIndexService,
    @Inject(EMBEDDING_CLIENT) private readonly embeddings: EmbeddingClient) {}

  onModuleInit(): void {
    this.recoverExpired();
    if (appOptions.knowledgeWorker === false) return;
    this.timer = setInterval(() => { if (!this.busy) this.active = this.tick().catch(() => { /* no body/keys in logs */ }); }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  /** Bounded history scan, durable retry and at most one worker tick at a time. */
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      this.recoverExpired();
      this.scanHistory();
      const now = Date.now();
      this.db.prepare(`UPDATE knowledge_index_jobs SET status='pending', next_attempt_at=0
        WHERE status='failed' AND attempts < 3 AND next_attempt_at < ?`).run(now);
      const pending = this.db.prepare("SELECT file_id FROM knowledge_index_jobs WHERE status='pending' AND next_attempt_at<=? ORDER BY updated_at LIMIT 4").all(now);
      for (const row of pending) await this.content.indexFileInBackground(Number(row.file_id));
      if (!this.embeddings.available) {
        this.db.prepare("UPDATE knowledge_index_jobs SET embedding_status='disabled' WHERE status='indexed' AND embedding_status='pending'").run();
        return;
      }
      const model = this.embeddings.modelKey;
      const job = this.db.prepare(`SELECT * FROM knowledge_index_jobs WHERE status='indexed' AND
        (embedding_model<>? OR embedding_status IN ('pending','disabled') OR
          (embedding_status='failed' AND embedding_attempts<3 AND embedding_retry_at<=?)) ORDER BY updated_at LIMIT 1`).get(model, now);
      if (!job) return;
      const fileId = Number(job.file_id), stored = String(job.stored_name);
      const claim = this.db.prepare(`UPDATE knowledge_index_jobs SET embedding_status='processing', embedding_lease_until=?,
        embedding_attempts=CASE WHEN embedding_model<>? THEN 0 ELSE embedding_attempts END, embedding_model=?
        WHERE file_id=? AND embedding_status<>'processing' AND stored_name=?`).run(now+60000,model,model,fileId,stored);
      if (!claim.changes) return;
      try {
        // Current-content join prevents generating/searching stale-version vectors.
        const chunks = this.db.prepare(`SELECT c.id,c.text FROM archive_content_chunks c
          JOIN archive_content_units u ON u.id=c.unit_id
          JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id=c.file_id AND cur.stored_name=u.stored_name AND cur.sha256=u.sha256
          WHERE c.file_id=? AND u.status='indexed' AND NOT EXISTS(
            SELECT 1 FROM knowledge_embeddings e WHERE e.chunk_id=c.id AND e.model_key=?) ORDER BY c.id LIMIT 16`).all(fileId, model);
        const hashes = chunks.map(c => createHash('sha256').update(String(c.text)).digest('hex'));
        const vectors: number[][] = [];
        const missing: number[] = [];
        chunks.forEach((c, i) => {
          const cached = this.db.prepare('SELECT vector_json FROM knowledge_embeddings WHERE text_hash=? AND model_key=? LIMIT 1').get(hashes[i], model);
          if (cached) vectors[i] = JSON.parse(String(cached.vector_json)); else missing.push(i);
        });
        if (missing.length) {
          const generated = await this.embeddings.embed(missing.map(i => String(chunks[i].text)));
          if (generated.length !== missing.length) throw new Error('invalid count');
          missing.forEach((index, i) => { vectors[index] = generated[i]; });
        }
        if (this.stopped) return;
        const dimension = this.db.prepare('SELECT dimensions FROM knowledge_embeddings WHERE model_key=? LIMIT 1').get(model)?.dimensions;
        if (vectors.some(v => !validVector(v) || v.length !== (dimension ? Number(dimension) : vectors[0].length))) throw new Error('invalid embedding dimensions');
        const fresh = this.db.prepare('SELECT stored_name, sha256 FROM knowledge_index_jobs WHERE file_id=?').get(fileId);
        if (!fresh || fresh.stored_name !== stored || fresh.sha256 !== job.sha256 || this.embeddings.modelKey !== model) return;
        const insert = this.db.prepare(`INSERT OR REPLACE INTO knowledge_embeddings(chunk_id,model_key,dimensions,text_hash,vector_json)
          SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM archive_content_chunks WHERE id=?)`);
        chunks.forEach((c, i) => insert.run(c.id!, model, vectors[i].length, hashes[i], JSON.stringify(vectors[i]), c.id!));
        const remaining = this.db.prepare(`SELECT 1 FROM archive_content_chunks c WHERE c.file_id=? AND NOT EXISTS(
          SELECT 1 FROM knowledge_embeddings e WHERE e.chunk_id=c.id AND e.model_key=?) LIMIT 1`).get(fileId, model);
        this.db.prepare("UPDATE knowledge_index_jobs SET embedding_status=?, embedding_error='', embedding_attempts=0, updated_at=? WHERE file_id=? AND stored_name=?")
          .run(remaining ? 'pending' : 'indexed', new Date().toISOString(), fileId, stored);
      } catch {
        this.db.prepare(`UPDATE knowledge_index_jobs SET embedding_status='failed', embedding_error='Embedding 失败，可重试；关键词索引仍可使用',
          embedding_attempts=embedding_attempts+1, embedding_retry_at=? WHERE file_id=? AND stored_name=?`)
          .run(Date.now() + 30000, fileId, stored);
      }
    } finally { this.busy = false; }
  }

  private recoverExpired(): void {
    const now = Date.now();
    this.db.prepare(`UPDATE knowledge_index_jobs SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,
      claim_token='', lease_until=0, next_attempt_at=0, message='提取任务中断，已恢复等待或达到重试上限'
      WHERE status='processing' AND lease_until<=?`).run(now);
    this.db.prepare(`UPDATE knowledge_index_jobs SET embedding_status='pending', embedding_lease_until=0
      WHERE embedding_status='processing' AND embedding_lease_until<=?`).run(now);
  }

  private scanHistory(): void {
    // Fixed high-water mark and durable checkpoint. New uploads/version intake enqueue themselves.
    // A pipeline version change starts one new bounded scan; completed scans never restart on a timer.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_scan_state(scan_key,high_watermark,updated_at)
        SELECT ?,COALESCE(MAX(id),0),? FROM archive_files`).run(CONTENT_PIPELINE_VERSION,new Date().toISOString());
      const state = this.db.prepare('SELECT * FROM knowledge_scan_state WHERE scan_key=?').get(CONTENT_PIPELINE_VERSION)!;
      if (!state.completed) {
        const rows = this.db.prepare('SELECT id FROM archive_files WHERE id>? AND id<=? ORDER BY id LIMIT 50').all(state.cursor!,state.high_watermark!);
        for (const row of rows) this.content.ensureJob(Number(row.id));
        const cursor = rows.length ? Number(rows[rows.length-1].id) : Number(state.high_watermark);
        this.db.prepare('UPDATE knowledge_scan_state SET cursor=?,completed=?,updated_at=? WHERE scan_key=?')
          .run(cursor,rows.length<50 || cursor>=Number(state.high_watermark)?1:0,new Date().toISOString(),CONTENT_PIPELINE_VERSION);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
