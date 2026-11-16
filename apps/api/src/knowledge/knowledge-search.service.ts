import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE } from '../db/database';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { ArchivesService, ArchiveView } from '../archives/archives.service';
import { FileRepository, ARCHIVE_VISIBILITY_SQL } from '../archives/archive.repositories';
import { ContentIndexService } from '../archives/content/content-index.service';
import { ContentIndexRepository, CURRENT_CONTENT_SQL, EVIDENCE_SELECT, EvidenceRow, toEvidence } from '../archives/content/content-index.repositories';
import { UserView, ROLE_ADMIN, roleLabel } from '../common/roles';
import { UserRepository } from '../users/user.repository';
import { ContentKeywordSearchService } from '../search/content-keyword-search.service';
import { EMBEDDING_CLIENT, EmbeddingClient, validVector } from './embedding.client';

export interface KnowledgeQuery {
  extension?: string; referenceFileIds?: number[]; keywordQuery?: string; query?: string; archiveIds?: number[]; fileIds?: number[]; attachmentId?: number;
  mode?: 'keyword' | 'semantic' | 'hybrid'; pageSize?: number; summary?: boolean;
}
export interface KnowledgeEvidence extends EvidenceRow {
  attachmentId: number; attachmentName: string; fileVersion: string;
  relevance: { keywordRank?: number; semanticRank?: number; cosine?: number; fusion: number };
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !validVector(a) || !validVector(b)) return -1;
  let dot=0, aa=0, bb=0;
  for (let i=0; i<a.length; i++) { dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i]; }
  return dot / Math.sqrt(aa*bb);
}

@Injectable()
export class KnowledgeSearchService {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(ContentIndexRepository) private readonly units: ContentIndexRepository,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(FileRepository) private readonly files: FileRepository,
    @Inject(ArchivesService) private readonly archives: ArchivesService,
    @Inject(ContentIndexService) private readonly content: ContentIndexService,
    @Inject(EMBEDDING_CLIENT) private readonly embeddings: EmbeddingClient,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(ContentKeywordSearchService) private readonly keywords: ContentKeywordSearchService) {}

  currentUser(user: UserView): UserView {
    const row = this.users.findById(user.id);
    if (!row || row.status !== 'active') throw new ForbiddenException('当前账号不可访问知识库');
    return { ...user, role: row.role, status: row.status, roleLabel: roleLabel(row.role) };
  }
  private scopes(p: KnowledgeQuery, user: UserView): KnowledgeQuery {
    const query = { ...p };
    for (const id of p.archiveIds ?? []) this.access.assertView(user, this.access.loadArchive(id));
    const ids = p.attachmentId ? [p.attachmentId] : p.fileIds;
    for (const id of p.referenceFileIds ?? []) {
      const file = this.files.findById(id);
      if (!file) throw new NotFoundException('参考附件不存在');
      this.access.assertView(user, this.access.loadArchive(file.archiveId));
    }
    for (const id of ids ?? []) {
      const file = this.files.findById(id);
      if (!file) throw new NotFoundException('附件不存在');
      this.access.assertView(user, this.access.loadArchive(file.archiveId));
      if (p.archiveIds && !p.archiveIds.includes(file.archiveId)) throw new BadRequestException('附件不属于指定档案');
    }
    query.fileIds = ids;
    return query;
  }
  async search(input: KnowledgeQuery, operator: UserView, includeMetadata = false) {
    let user = this.currentUser(operator);
    const p = this.scopes(input, user);
    const question = String(p.query ?? '').trim();
    const scope = { userId: user.id, admin: user.role === ROLE_ADMIN };
    const limit = Math.min(30, p.pageSize ?? 12);
    const mode = p.mode ?? 'hybrid';
    const referenceRows = (p.referenceFileIds ?? []).flatMap(id => {
      const file = this.files.findById(id)!;
      return this.units.listChunksOfArchives([file.archiveId], scope, -1, [id]);
    });
    const referenceArchives = new Set(referenceRows.map(row => row.archiveId));
    const lexicalQuery = [p.keywordQuery ?? question, ...referenceRows.map(row => row.text)].join(' ').slice(0,1000);
    const lexicalResult = this.keywords.search({query: mode==='semantic'?'':lexicalQuery,scope,archiveIds:p.archiveIds,fileIds:p.fileIds,extension:p.extension});
    const tokens = lexicalResult.tokens;
    const lexical = lexicalResult.items;
    let semantic: EvidenceRow[] = [];
    let semanticAvailable = false;
    let degradedReason: string | null = mode === 'keyword' ? null : '未配置独立 Embedding 服务，本次仅关键词检索';
    if (mode !== 'keyword' && question && this.embeddings.available) {
      const model = this.embeddings.modelKey;
      try {
        const vectors = await this.embeddings.embed([question]);
        if (vectors.length !== 1 || !validVector(vectors[0]) || this.embeddings.modelKey !== model) throw new Error('Invalid query vector');
        // Await is an authorization boundary: re-read role, archive grants, attachment membership.
        user = this.currentUser(operator);
        this.scopes(p, user);
        let queryVector = vectors[0];
        if (p.referenceFileIds?.length) {
          const referenceVectors = referenceRows.map(row => this.db.prepare('SELECT vector_json FROM knowledge_embeddings WHERE chunk_id=? AND model_key=?').get(row.chunkId, model))
            .map(row => row ? JSON.parse(String(row.vector_json)) as number[] : null);
          if (!referenceRows.length || referenceVectors.some(v => !v || !validVector(v) || v.length !== queryVector.length)) throw new Error('Reference vector index incomplete');
          const centroid = queryVector.map((_, i) => referenceVectors.reduce((n, v) => n + v![i], 0) / referenceVectors.length);
          queryVector = queryVector.map((v, i) => v * 0.3 + centroid[i] * 0.7);
        }
        const result = this.semantic(queryVector, model, p, user);
        semantic = result.items;
        semanticAvailable = result.indexed;
        degradedReason = semanticAvailable ? null : '当前范围尚无匹配模型的向量索引，本次仅关键词检索';
      } catch { degradedReason = 'Embedding 不可用，本次仅关键词检索'; }
    }
    user = this.currentUser(operator);
    this.scopes(p, user);
    const fused = new Map<number, KnowledgeEvidence>();
    const add = (rows: EvidenceRow[], kind: 'keywordRank' | 'semanticRank') => rows.forEach((row, i) => {
      const previous = fused.get(row.chunkId);
      const score = (previous?.score ?? 0) + 1/(60+i+1);
      fused.set(row.chunkId, { ...row, attachmentId: row.fileId, attachmentName: row.fileName,
        fileVersion: row.versionNo === null ? '上传原件' : `第 ${row.versionNo} 版`, score,
        relevance: { ...previous?.relevance, [kind]: i+1, ...(kind === 'semanticRank' ? { cosine: row.score } : {}), fusion: score } });
    });
    add(lexical, 'keywordRank'); add(semantic, 'semanticRank');
    if (!fused.size && mode !== 'semantic' && p.summary && p.archiveIds?.length) add(this.units.listChunksOfArchives(p.archiveIds,
      { userId: user.id, admin: user.role === ROLE_ADMIN }, 120, p.fileIds), 'keywordRank');
    // Revalidate every candidate immediately before it can reach the model or HTTP response.
    const counts = new Map<number, number>();
    const duplicate = new Set<string>();
    const items = [...fused.values()].sort((a,b) => b.score-a.score || a.chunkId-b.chunkId).filter(row => {
      try {
        this.access.assertView(user, this.access.loadArchive(row.archiveId));
        const file = this.files.findById(row.fileId);
        if (!file || file.archiveId !== row.archiveId || referenceArchives.has(row.archiveId)) return false;
        const current = this.content.currentContentOf(file);
        const unit = this.units.findUnitByStored(current.storedName);
        if (unit?.id !== row.unitId || unit.sha256 !== current.sha256) return false;
        const key = `${row.fileId}:${row.text}`;
        const count = counts.get(row.fileId) ?? 0;
        if (count >= 3 || duplicate.has(key)) return false;
        counts.set(row.fileId, count+1); duplicate.add(key); return true;
      } catch { return false; }
    }).slice(0, limit);
    const metadata = new Map<number, ArchiveView>();
    let metadataTruncated = false;
    if (includeMetadata && question) {
      const fileArchives = p.fileIds?.map(id => this.files.findById(id)!.archiveId);
      const archiveIds = p.archiveIds ? p.archiveIds.filter(id => !fileArchives || fileArchives.includes(id)) : fileArchives;
      for (const token of tokens.filter(t => t.length <= 100).slice(0, 6)) {
        const found = this.archives.searchArchives({ q: token, page: '1', pageSize: String(limit), knowledgeMetadata: true, archiveIds }, user);
        for (const row of found.items) metadata.set(row.id, row);
        metadataTruncated ||= found.total > found.items.length;
      }
    }
    const archives = includeMetadata ? { items: [...metadata.values()].slice(0, limit), returned: Math.min(metadata.size, limit),
      truncated: metadataTruncated || metadata.size > limit, source: 'live_business' as const } : undefined;
    return { items, archives, candidateChunks: fused.size, total: items.length, returned: items.length, truncated: fused.size > items.length,
      retrievalMode: semanticAvailable ? mode === 'semantic' ? 'semantic' : 'hybrid' : mode === 'semantic' ? 'unavailable' : 'keyword',
      semanticAvailable, degradedReason, keywordMode:lexicalResult.retrievalMode, keywordDegradedReason:lexicalResult.degradedReason, ftsAvailable: this.units.ftsAvailable() };
  }

  private semantic(vector: number[], model: string, p: KnowledgeQuery, user: UserView) {
    if (p.archiveIds && !p.archiveIds.length || p.fileIds && !p.fileIds.length) return { items: [], indexed: false };
    const filters: string[] = [], args: Array<string|number> = [model, vector.length];
    if (p.archiveIds) { filters.push(`c.archive_id IN (${p.archiveIds.map(()=>'?').join(',')})`); args.push(...p.archiveIds); }
    if (p.extension) { filters.push('LOWER(f.extension)=?'); args.push(p.extension.toLowerCase()); }
    if (p.fileIds) { filters.push(`c.file_id IN (${p.fileIds.map(()=>'?').join(',')})`); args.push(...p.fileIds); }
    if (user.role !== ROLE_ADMIN) { filters.push(ARCHIVE_VISIBILITY_SQL); args.push(user.id, user.id); }
    const rows = this.db.prepare(`SELECT ${EVIDENCE_SELECT}, e.vector_json FROM knowledge_embeddings e
      JOIN archive_content_chunks c ON c.id=e.chunk_id JOIN archive_content_units u ON u.id=c.unit_id
      JOIN archives a ON a.id=c.archive_id JOIN archive_files f ON f.id=c.file_id
      JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id=f.id AND cur.stored_name=u.stored_name AND cur.sha256=u.sha256
      WHERE e.model_key=? AND e.dimensions=? AND u.status='indexed' ${filters.length ? `AND ${filters.join(' AND ')}` : ''}`).iterate(...args);
    const best: EvidenceRow[] = [];
    let indexed = false;
    for (const raw of rows) {
      indexed = true;
      let similarity = -1;
      try { similarity = cosine(vector, JSON.parse(String(raw.vector_json))); } catch { continue; }
      if (similarity < 0.25) continue;
      best.push(toEvidence(raw, similarity)); best.sort((a,b)=>b.score-a.score || a.chunkId-b.chunkId);
      if (best.length > 120) best.pop();
    }
    return { items: best, indexed };
  }

  sourceLocation(fileId:number,chunkId:number,operator:UserView,archiveId?:number) {
    const user=this.currentUser(operator);
    this.scopes({attachmentId:fileId,...(archiveId?{archiveIds:[archiveId]}:{})},user);
    const file=this.files.findById(fileId)!;
    const row=this.db.prepare(`SELECT ${EVIDENCE_SELECT} FROM archive_content_chunks c
      JOIN archive_content_units u ON u.id=c.unit_id JOIN archives a ON a.id=c.archive_id JOIN archive_files f ON f.id=c.file_id
      JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id=f.id AND cur.stored_name=u.stored_name AND cur.sha256=u.sha256
      WHERE c.id=? AND c.file_id=? AND c.archive_id=? AND f.archive_id=c.archive_id AND u.status='indexed'`).get(chunkId,fileId,file.archiveId);
    if(!row)throw new NotFoundException('来源已失效，请重新检索当前附件');
    return toEvidence(row,0);
  }

  attachmentStatus(id: number, operator: UserView) {
    const user = this.currentUser(operator);
    this.scopes({ attachmentId: id }, user);
    const file = this.files.findById(id)!;
    const status = this.content.describe(file.archiveId).find(f => f.fileId === id)!;
    return { ...status, attachmentId: id, archiveId: file.archiveId };
  }
  isCurrentEvidence(fileId: number, unitId: number): boolean { return this.content.isCurrentEvidence(fileId, unitId); }
  statistics(operator: UserView) {
    const user = this.currentUser(operator);
    const visibility = user.role === ROLE_ADMIN ? '' : `WHERE ${ARCHIVE_VISIBILITY_SQL}`;
    const rows = this.db.prepare(`SELECT f.id FROM archive_files f JOIN archives a ON a.id=f.archive_id ${visibility}`)
      .all(...(user.role === ROLE_ADMIN ? [] : [user.id, user.id]));
    const statuses = this.content.describeVisible({ userId: user.id, admin: user.role === ROLE_ADMIN });
    const counts = { indexed: 0, pending: 0, processing: 0, failed: 0, unsupported: 0, no_text: 0, scanned: 0, corrupt: 0, encrypted: 0 };
    for (const row of statuses) {
      if (row.status in counts) counts[row.status as keyof typeof counts]++;
    }
    const visibleIds = new Set(rows.map(r => Number(r.id)));
    const currentChunks = this.db.prepare(`SELECT c.id, c.file_id, e.model_key FROM archive_content_chunks c
      JOIN archive_content_units u ON u.id=c.unit_id
      JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id=c.file_id AND cur.stored_name=u.stored_name AND cur.sha256=u.sha256
      LEFT JOIN knowledge_embeddings e ON e.chunk_id=c.id AND e.model_key=? WHERE u.status='indexed'`).all(this.embeddings.modelKey);
    const chunks = currentChunks.filter(c => visibleIds.has(Number(c.file_id)));
    const embedded = chunks.filter(c => c.model_key === this.embeddings.modelKey && this.embeddings.available);
    const vectorFiles = new Set(embedded.map(c => Number(c.file_id)));
    const completeFiles = statuses.filter(f => f.status === 'indexed' && !f.truncated);
    const fullyEmbedded = completeFiles.filter(f => embedded.filter(c => Number(c.file_id) === f.fileId).length === f.chunkCount);
    const latest = this.db.prepare('SELECT file_id, updated_at FROM knowledge_index_jobs WHERE status= ?').all('indexed')
      .filter(r => visibleIds.has(Number(r.file_id))).map(r => String(r.updated_at)).sort().at(-1) ?? null;
    return { total: rows.length, ...counts, lastIndexedAt: latest, embeddingConfigured: this.embeddings.available,
      embedding: { configured: this.embeddings.available, modelKey: this.embeddings.modelKey || null,
        apiBaseConfigured: !!process.env.JIT_EMBEDDING_API_BASE, modelConfigured: !!process.env.JIT_EMBEDDING_MODEL,
        apiKeyConfigured: !!process.env.JIT_EMBEDDING_API_KEY, revision: process.env.JIT_EMBEDDING_REVISION ?? '1',
        // Configuration and index coverage are not a network availability probe.
        serviceAvailability: 'not_probed' },
      contentCoverage: { expectedFiles: rows.length, completeFiles: completeFiles.length, truncatedFiles: statuses.filter(f => f.truncated).length,
        indexedChunks: chunks.length, pendingFiles: rows.length - completeFiles.length },
      vectorCoverage: { expectedChunks: chunks.length, indexedChunks: embedded.length, missingChunks: chunks.length - embedded.length,
        indexedFiles: vectorFiles.size, completeFiles: fullyEmbedded.length, pendingFiles: rows.length - fullyEmbedded.length },
      ftsAvailable: this.units.ftsAvailable() };
  }
}
