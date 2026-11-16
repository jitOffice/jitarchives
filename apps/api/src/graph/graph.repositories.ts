/**
 * 知识图谱仓储（第一阶段）。
 *
 * 沿用项目既有仓储范式：抽象类作为 DI Token，SQLite 实现绑定在 GraphModule。
 * 职责边界：
 * - 只读写 kg_graph_nodes / kg_graph_edges 两张表，以及「只读」业务表与正文索引表；
 * - 业务数据一律从权威表读取（档案 / 分类 / 附件 / 正文片段），图谱表不承载业务事实；
 * - 正文片段只取「当前有效正文」（复用 CURRENT_CONTENT_SQL），旧版本内容不会进入图谱；
 * - 所有 SQL 参数化，节点写入按 biz_key 幂等（ON CONFLICT DO UPDATE），重复执行不翻倍。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { SqliteTransaction } from '../db/transaction';
import { CURRENT_CONTENT_SQL } from '../archives/content/content-index.repositories';
import {
  KgChunkSource,
  KgEdgeDraft,
  KgEdgeRow,
  KgEdgeType,
  KgNodeDraft,
  KgNodeRow,
  KgNodeType,
} from './graph.types';

/** 图谱所需的档案字段（只读投影，不复制业务语义）。 */
export interface KgArchiveSource {
  id: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  archiveType: string;
  status: string;
  accessLevel: string;
  responsible: string;
  formationDate: string | null;
  keywords: string;
}

/** 图谱所需的附件字段。 */
export interface KgFileSource {
  id: number;
  archiveId: number;
  originalName: string;
  storedName: string;
  extension: string;
  fileSize: number;
  sha256: string;
  uploadedAt: string;
}

/** 附件当前有效正文的索引状态（无索引单元时为 pending，由调用方补默认值）。 */
export interface KgUnitStatus {
  fileId: number;
  unitId: number;
  storedName: string;
  sha256: string;
  versionNo: number | null;
  extractor: string;
  status: string;
  message: string;
  charCount: number;
  chunkCount: number;
  truncated: boolean;
}

/** 确定性关联所需的著录字段值（动态元数据模板字段，真实等值比较）。 */
export interface KgFieldValue {
  archiveId: number;
  fieldKey: string;
  fieldLabel: string;
  fieldType: string;
  value: string;
}

export interface KgGraphCounts {
  nodes: number;
  edges: number;
  nodesByType: Partial<Record<KgNodeType, number>>;
  edgesByType: Partial<Record<KgEdgeType, number>>;
}

export abstract class GraphRepository {
  // ---------- 只读：权威业务与正文投影 ----------
  abstract listArchives(archiveIds?: number[]): KgArchiveSource[];
  abstract listFiles(archiveIds: number[]): KgFileSource[];
  /** 单个附件读取（附件更新后反查所属档案用）。 */
  abstract findFile(fileId: number): KgFileSource | undefined;
  abstract listUnitStatuses(archiveIds: number[]): Map<number, KgUnitStatus>;
  /** 当前有效正文的知识块（仅 status='indexed' 且等于文件当前版本）。 */
  abstract listChunkSources(archiveIds?: number[]): KgChunkSource[];
  abstract countIndexableChunks(): number;
  abstract listFieldValues(): KgFieldValue[];
  abstract listCategoryNames(): Map<number, { name: string; code: string; parentId: number | null; description: string }>;

  // ---------- 写入：图谱表 ----------
  /** 幂等写入节点，返回 bizKey → 节点 id。 */
  abstract upsertNodes(nodes: KgNodeDraft[]): Map<string, number>;
  abstract nodeIdsByKeys(keys: string[]): Map<string, number>;
  abstract deleteNodesByKeys(keys: string[]): number;
  abstract deleteAllNodes(): number;
  /** 列出某范围内的节点键（用于清理「业务已不存在」的过期节点）。 */
  abstract listNodeKeys(archiveId: number): Array<{ bizKey: string; nodeType: KgNodeType }>;
  abstract listAllNodeKeys(): Array<{ bizKey: string; nodeType: KgNodeType }>;
  /** 删除与给定节点集合相连的关系（结构上先删边再删节点，避免悬挂边）。 */
  abstract deleteEdgesIncidentToNodes(nodeIds: number[], edgeTypes?: KgEdgeType[]): number;
  /**
   * 删除两端节点都属于给定档案集合的关系（增量重建安全范围）。
   * 跨档案边（一端在集合内、另一端在集合外）不受影响，避免增量重建误删全量构建的跨档案关联。
   */
  abstract deleteEdgesWithinArchives(archiveIds: number[]): number;
  /** 读取与给定档案节点集合相连的所有跨档案边（增量重建后需差量比对用）。 */
  abstract listCrossArchiveEdges(archiveIds: number[]): KgEdgeRow[];
  abstract deleteAllEdges(): number;
  /** 幂等写入关系（同类型同端点只保留一条）。 */
  abstract upsertEdges(edges: KgEdgeDraft[], nodeIdByKey: Map<string, number>): number;
  abstract counts(): KgGraphCounts;
  abstract listNodesByArchive(archiveId: number): KgNodeRow[];
  abstract listEdgesOfArchive(archiveId: number): KgEdgeRow[];
  abstract listEdgesByType(edgeType: KgEdgeType, limit?: number): KgEdgeRow[];
}

const ARCHIVE_SELECT = `
  SELECT a.id, a.title, a.archive_no, a.category_id, a.archive_type, a.status, a.access_level,
         a.responsible, a.formation_date, a.keywords
    FROM archives a`;

const FILE_SELECT = `
  SELECT f.id, f.archive_id, f.original_name, f.stored_name, f.extension, f.file_size, f.sha256, f.uploaded_at
    FROM archive_files f`;

/**
 * 当前有效正文的知识块投影：
 * 与正文检索同口径（unit.status='indexed' 且 stored_name/sha256 命中文件的当前版本），
 * 保证「图谱里的知识块」与「检索/问答能引用的知识块」是同一批内容。
 */
const CHUNK_SOURCE_SELECT = `
  SELECT c.id            AS chunk_id,
         c.unit_id       AS unit_id,
         c.archive_id    AS archive_id,
         c.file_id       AS file_id,
         c.chunk_no      AS chunk_no,
         u.stored_name   AS stored_name,
         u.sha256        AS sha256,
         u.extension     AS extension,
         u.extractor     AS extractor,
         u.status        AS status,
         u.message       AS message,
         u.version_no    AS version_no,
         c.locator       AS locator,
         c.page_no       AS page_no,
         c.pos_from      AS pos_from,
         c.pos_to        AS pos_to,
         c.text          AS text
    FROM archive_content_chunks c
    JOIN archive_content_units u ON u.id = c.unit_id
    JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id = c.file_id AND cur.stored_name = u.stored_name AND cur.sha256 = u.sha256
   WHERE u.status = 'indexed'`;

/** 与 CHUNK_SOURCE_SELECT 完全同口径的计数（构建前判定语料规模）。 */
const CHUNK_SOURCE_COUNT_SELECT = `
  SELECT COUNT(*) AS c
    FROM archive_content_chunks c
    JOIN archive_content_units u ON u.id = c.unit_id
    JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id = c.file_id AND cur.stored_name = u.stored_name AND cur.sha256 = u.sha256
   WHERE u.status = 'indexed'`;

function inClause(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

@Injectable()
export class SqliteGraphRepository implements GraphRepository {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
  ) {}

  listArchives(archiveIds?: number[]): KgArchiveSource[] {
    let sql = ARCHIVE_SELECT;
    const args: number[] = [];
    if (archiveIds) {
      if (!archiveIds.length) return [];
      sql += ` WHERE a.id IN (${inClause(archiveIds.length)})`;
      args.push(...archiveIds);
    }
    sql += ' ORDER BY a.id';
    const rows = this.db.prepare(sql).all(...args) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      archiveNo: String(r.archive_no),
      categoryId: Number(r.category_id),
      archiveType: String(r.archive_type ?? ''),
      status: String(r.status ?? ''),
      accessLevel: String(r.access_level ?? 'public'),
      responsible: String(r.responsible ?? ''),
      formationDate: r.formation_date == null ? null : String(r.formation_date),
      keywords: String(r.keywords ?? ''),
    }));
  }

  findFile(fileId: number): KgFileSource | undefined {
    const row = this.db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(fileId) as unknown as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      archiveId: Number(row.archive_id),
      originalName: String(row.original_name),
      storedName: String(row.stored_name),
      extension: String(row.extension ?? ''),
      fileSize: Number(row.file_size ?? 0),
      sha256: String(row.sha256 ?? ''),
      uploadedAt: String(row.uploaded_at ?? ''),
    };
  }

  listFiles(archiveIds: number[]): KgFileSource[] {
    if (!archiveIds.length) return [];
    const rows = this.db
      .prepare(`${FILE_SELECT} WHERE f.archive_id IN (${inClause(archiveIds.length)}) ORDER BY f.archive_id, f.id`)
      .all(...archiveIds) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      archiveId: Number(r.archive_id),
      originalName: String(r.original_name),
      storedName: String(r.stored_name),
      extension: String(r.extension ?? ''),
      fileSize: Number(r.file_size ?? 0),
      sha256: String(r.sha256 ?? ''),
      uploadedAt: String(r.uploaded_at ?? ''),
    }));
  }

  listUnitStatuses(archiveIds: number[]): Map<number, KgUnitStatus> {
    const byFile = new Map<number, KgUnitStatus>();
    if (!archiveIds.length) return byFile;
    const rows = this.db
      .prepare(`
        SELECT cur.file_id AS file_id, u.id AS unit_id, u.stored_name, u.sha256, u.version_no, u.extractor,
               u.status, u.message, u.char_count, u.chunk_count, u.truncated
          FROM archive_content_units u
          JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id = u.file_id AND cur.stored_name = u.stored_name AND cur.sha256 = u.sha256
         WHERE u.archive_id IN (${inClause(archiveIds.length)})
         ORDER BY u.id`)
      .all(...archiveIds) as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      const status: KgUnitStatus = {
        fileId: Number(r.file_id),
        unitId: Number(r.unit_id),
        storedName: String(r.stored_name),
        sha256: String(r.sha256 ?? ''),
        versionNo: r.version_no == null ? null : Number(r.version_no),
        extractor: String(r.extractor ?? ''),
        status: String(r.status ?? ''),
        message: String(r.message ?? ''),
        charCount: Number(r.char_count ?? 0),
        chunkCount: Number(r.chunk_count ?? 0),
        truncated: Number(r.truncated ?? 0) === 1,
      };
      // 同一附件在同一时刻只应有一个「当前内容」单元；若历史遗留多条，取 id 最大者（最新一次索引）
      byFile.set(status.fileId, status);
    }
    return byFile;
  }

  listChunkSources(archiveIds?: number[]): KgChunkSource[] {
    let sql = CHUNK_SOURCE_SELECT;
    const args: number[] = [];
    if (archiveIds) {
      if (!archiveIds.length) return [];
      sql += ` AND c.archive_id IN (${inClause(archiveIds.length)})`;
      args.push(...archiveIds);
    }
    sql += ' ORDER BY c.archive_id, c.file_id, c.chunk_no';
    const rows = this.db.prepare(sql).all(...args) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      chunkId: Number(r.chunk_id),
      unitId: Number(r.unit_id),
      archiveId: Number(r.archive_id),
      fileId: Number(r.file_id),
      chunkNo: Number(r.chunk_no),
      storedName: String(r.stored_name),
      extension: String(r.extension ?? ''),
      extractor: String(r.extractor ?? ''),
      status: String(r.status ?? ''),
      message: String(r.message ?? ''),
      locator: String(r.locator ?? ''),
      pageNo: r.page_no == null ? null : Number(r.page_no),
      posFrom: r.pos_from == null ? null : Number(r.pos_from),
      posTo: r.pos_to == null ? null : Number(r.pos_to),
      text: String(r.text ?? ''),
      sha256: String(r.sha256 ?? ''),
      versionNo: r.version_no == null ? null : Number(r.version_no),
    }));
  }

  countIndexableChunks(): number {
    const row = this.db.prepare(CHUNK_SOURCE_COUNT_SELECT).get() as unknown as { c: number | bigint };
    return Number(row.c);
  }

  listFieldValues(): KgFieldValue[] {
    // 只取真实存在的动态著录字段值；字段类型过滤（select/bool/date 属类别值）在计算层完成，
    // 仓储层如实投影，不在此处猜测业务含义。
    const rows = this.db
      .prepare(`
        SELECT mv.archive_id AS archive_id, mf.field_key AS field_key, mf.label AS label,
               mf.type AS type, mv.value_text AS value
          FROM archive_field_values mv
          JOIN template_fields mf ON mf.id = mv.field_id
         WHERE trim(mv.value_text) <> ''
         ORDER BY mv.field_key, mv.id`)
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      archiveId: Number(r.archive_id),
      fieldKey: String(r.field_key ?? ''),
      fieldLabel: String(r.label ?? ''),
      fieldType: String(r.type ?? ''),
      value: String(r.value ?? '').trim(),
    }));
  }

  listCategoryNames(): Map<number, { name: string; code: string; parentId: number | null; description: string }> {
    const map = new Map<number, { name: string; code: string; parentId: number | null; description: string }>();
    const rows = this.db
      .prepare('SELECT id, name, code, parent_id, description FROM archive_categories ORDER BY id')
      .all() as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      map.set(Number(r.id), {
        name: String(r.name ?? ''),
        code: String(r.code ?? ''),
        parentId: r.parent_id == null ? null : Number(r.parent_id),
        description: String(r.description ?? ''),
      });
    }
    return map;
  }

  upsertNodes(nodes: KgNodeDraft[]): Map<string, number> {
    if (!nodes.length) return new Map();
    return this.tx.run(() => {
      const now = new Date().toISOString();
      const statement = this.db.prepare(`
        INSERT INTO kg_graph_nodes (node_type, biz_key, ref_id, archive_id, file_id, name, meta_json, source, content_hash, built_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(biz_key) DO UPDATE SET
          node_type = excluded.node_type,
          ref_id = excluded.ref_id,
          archive_id = excluded.archive_id,
          file_id = excluded.file_id,
          name = excluded.name,
          meta_json = excluded.meta_json,
          source = excluded.source,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at`);
      for (const node of nodes) {
        statement.run(
          node.nodeType,
          node.bizKey,
          node.refId,
          node.archiveId,
          node.fileId,
          node.name,
          JSON.stringify(node.meta ?? {}),
          node.source,
          node.contentHash,
          now,
          now,
        );
      }
      return this.nodeIdsByKeys(nodes.map((n) => n.bizKey));
    });
  }

  nodeIdsByKeys(keys: string[]): Map<string, number> {
    const map = new Map<string, number>();
    if (!keys.length) return map;
    // 分批查询，避免超长 IN 列表
    const chunk = 500;
    for (let i = 0; i < keys.length; i += chunk) {
      const slice = keys.slice(i, i + chunk);
      const rows = this.db
        .prepare(`SELECT biz_key, id FROM kg_graph_nodes WHERE biz_key IN (${inClause(slice.length)})`)
        .all(...slice) as unknown as Array<{ biz_key: string; id: number | bigint }>;
      for (const r of rows) map.set(String(r.biz_key), Number(r.id));
    }
    return map;
  }

  deleteNodesByKeys(keys: string[]): number {
    if (!keys.length) return 0;
    return this.tx.run(() => {
      let removed = 0;
      const chunk = 500;
      for (let i = 0; i < keys.length; i += chunk) {
        const slice = keys.slice(i, i + chunk);
        const info = this.db.prepare(`DELETE FROM kg_graph_nodes WHERE biz_key IN (${inClause(slice.length)})`).run(...slice);
        removed += Number(info.changes);
      }
      return removed;
    });
  }

  deleteAllNodes(): number {
    return this.tx.run(() => {
      this.db.prepare('DELETE FROM kg_graph_edges').run();
      const info = this.db.prepare('DELETE FROM kg_graph_nodes').run();
      return Number(info.changes);
    });
  }

  listNodeKeys(archiveId: number): Array<{ bizKey: string; nodeType: KgNodeType }> {
    const rows = this.db
      .prepare('SELECT biz_key, node_type FROM kg_graph_nodes WHERE archive_id = ?')
      .all(archiveId) as unknown as Array<{ biz_key: string; node_type: string }>;
    return rows.map((r) => ({ bizKey: String(r.biz_key), nodeType: r.node_type as KgNodeType }));
  }

  listAllNodeKeys(): Array<{ bizKey: string; nodeType: KgNodeType }> {
    const rows = this.db
      .prepare('SELECT biz_key, node_type FROM kg_graph_nodes')
      .all() as unknown as Array<{ biz_key: string; node_type: string }>;
    return rows.map((r) => ({ bizKey: String(r.biz_key), nodeType: r.node_type as KgNodeType }));
  }

  deleteEdgesIncidentToNodes(nodeIds: number[], edgeTypes?: KgEdgeType[]): number {
    if (!nodeIds.length) return 0;
    return this.tx.run(() => {
      let removed = 0;
      const chunk = 500;
      const typeClause = edgeTypes?.length ? ` AND edge_type IN (${inClause(edgeTypes.length)})` : '';
      for (let i = 0; i < nodeIds.length; i += chunk) {
        const slice = nodeIds.slice(i, i + chunk);
        const placeholders = inClause(slice.length);
        const args: Array<number | string> = edgeTypes?.length ? [...slice, ...slice, ...edgeTypes] : [...slice, ...slice];
        const info = this.db
          .prepare(`DELETE FROM kg_graph_edges WHERE (from_node IN (${placeholders}) OR to_node IN (${placeholders}))${typeClause}`)
          .run(...args);
        removed += Number(info.changes);
      }
      return removed;
    });
  }

  deleteEdgesWithinArchives(archiveIds: number[]): number {
    if (!archiveIds.length) return 0;
    return this.tx.run(() => {
      const holders = inClause(archiveIds.length);
      const info = this.db
        .prepare(
          `DELETE FROM kg_graph_edges
           WHERE from_archive_id IN (${holders}) AND to_archive_id IN (${holders})`,
        )
        .run(...archiveIds, ...archiveIds);
      return Number(info.changes);
    });
  }

  listCrossArchiveEdges(archiveIds: number[]): KgEdgeRow[] {
    if (!archiveIds.length) return [];
    const holders = inClause(archiveIds.length);
    const rows = this.db
      .prepare(
        `SELECT e.* FROM kg_graph_edges e
         WHERE (e.from_archive_id IN (${holders}) OR e.to_archive_id IN (${holders}))
           AND NOT (e.from_archive_id IN (${holders}) AND e.to_archive_id IN (${holders}))
         ORDER BY e.edge_type, e.weight DESC, e.id`,
      )
      .all(...archiveIds, ...archiveIds, ...archiveIds) as unknown as Array<Record<string, unknown>>;
    return rows.map(toEdgeRow);
  }

  deleteAllEdges(): number {
    const info = this.db.prepare('DELETE FROM kg_graph_edges').run();
    return Number(info.changes);
  }

  upsertEdges(edges: KgEdgeDraft[], nodeIdByKey: Map<string, number>): number {
    if (!edges.length) return 0;
    return this.tx.run(() => {
      const now = new Date().toISOString();
      const statement = this.db.prepare(`
        INSERT INTO kg_graph_edges (edge_type, from_node, to_node, weight, basis, evidence_json, from_archive_id, to_archive_id, built_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(edge_type, from_node, to_node) DO UPDATE SET
          weight = excluded.weight,
          basis = excluded.basis,
          evidence_json = excluded.evidence_json,
          from_archive_id = excluded.from_archive_id,
          to_archive_id = excluded.to_archive_id,
          built_at = excluded.built_at`);
      let written = 0;
      for (const edge of edges) {
        const fromNode = nodeIdByKey.get(edge.fromKey);
        const toNode = nodeIdByKey.get(edge.toKey);
        // 端点节点缺失时直接跳过：宁可不建边，也不留下指向未知对象的幽灵关系
        if (!fromNode || !toNode || fromNode === toNode) continue;
        statement.run(edge.edgeType, fromNode, toNode, edge.weight, edge.basis, JSON.stringify(edge.evidence ?? {}), edge.fromArchiveId, edge.toArchiveId, now);
        written += 1;
      }
      return written;
    });
  }

  counts(): KgGraphCounts {
    const nodes = Number((this.db.prepare('SELECT COUNT(*) AS c FROM kg_graph_nodes').get() as unknown as { c: number | bigint }).c);
    const edges = Number((this.db.prepare('SELECT COUNT(*) AS c FROM kg_graph_edges').get() as unknown as { c: number | bigint }).c);
    const nodesByType: Partial<Record<KgNodeType, number>> = {};
    for (const row of this.db.prepare('SELECT node_type, COUNT(*) AS c FROM kg_graph_nodes GROUP BY node_type').all() as unknown as Array<{ node_type: string; c: number | bigint }>) {
      nodesByType[row.node_type as KgNodeType] = Number(row.c);
    }
    const edgesByType: Partial<Record<KgEdgeType, number>> = {};
    for (const row of this.db.prepare('SELECT edge_type, COUNT(*) AS c FROM kg_graph_edges GROUP BY edge_type').all() as unknown as Array<{ edge_type: string; c: number | bigint }>) {
      edgesByType[row.edge_type as KgEdgeType] = Number(row.c);
    }
    return { nodes, edges, nodesByType, edgesByType };
  }

  listNodesByArchive(archiveId: number): KgNodeRow[] {
    const rows = this.db.prepare('SELECT * FROM kg_graph_nodes WHERE archive_id = ? ORDER BY node_type, id').all(archiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toNodeRow);
  }

  listEdgesOfArchive(archiveId: number): KgEdgeRow[] {
    const rows = this.db
      .prepare(`
        SELECT e.* FROM kg_graph_edges e
        JOIN kg_graph_nodes f ON f.id = e.from_node
        LEFT JOIN kg_graph_nodes t ON t.id = e.to_node
         WHERE f.archive_id = ? OR t.archive_id = ?
         ORDER BY e.edge_type, e.weight DESC, e.id`)
      .all(archiveId, archiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toEdgeRow);
  }

  listEdgesByType(edgeType: KgEdgeType, limit = 500): KgEdgeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM kg_graph_edges WHERE edge_type = ? ORDER BY weight DESC, id LIMIT ?')
      .all(edgeType, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(toEdgeRow);
  }
}

function toNodeRow(r: Record<string, unknown>): KgNodeRow {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(String(r.meta_json ?? '{}')) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return {
    id: Number(r.id),
    nodeType: String(r.node_type) as KgNodeType,
    bizKey: String(r.biz_key),
    refId: Number(r.ref_id),
    archiveId: r.archive_id == null ? null : Number(r.archive_id),
    fileId: r.file_id == null ? null : Number(r.file_id),
    name: String(r.name ?? ''),
    meta,
    source: String(r.source ?? ''),
    contentHash: String(r.content_hash ?? ''),
    builtAt: String(r.built_at ?? ''),
  };
}

function toEdgeRow(r: Record<string, unknown>): KgEdgeRow {
  let evidence: Record<string, unknown> = {};
  try {
    evidence = JSON.parse(String(r.evidence_json ?? '{}')) as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  return {
    id: Number(r.id),
    edgeType: String(r.edge_type) as KgEdgeType,
    fromNode: Number(r.from_node),
    toNode: Number(r.to_node),
    weight: Number(r.weight ?? 0),
    basis: String(r.basis ?? ''),
    evidence,
    fromArchiveId: r.from_archive_id == null ? null : Number(r.from_archive_id),
    toArchiveId: r.to_archive_id == null ? null : Number(r.to_archive_id),
  };
}
