import { Inject, Injectable } from '@nestjs/common';
import { ContentIndexRepository, EvidenceRow, ViewerScope } from '../archives/content/content-index.repositories';
import { extractLexicalTokens } from './cjk-bigram';

export interface ContentKeywordQuery {
  query: string;
  scope: ViewerScope;
  archiveIds?: number[];
  fileIds?: number[];
  archiveNo?: string;
  archiveTitle?: string;
  extension?: string;
  referenceFileIds?: number[];
  perFile?: number;
}

/**
 * One lexical implementation for UnifiedSearch and Agent evidence.
 *
 * Retrieval is deliberately lightweight: application-generated CJK bigrams,
 * SQLite FTS5 BM25, an AND-first candidate pass and an OR fallback. It does not
 * call Embedding, a vector database or a business-specific keyword dictionary.
 */
@Injectable()
export class ContentKeywordSearchService {
  constructor(@Inject(ContentIndexRepository) private readonly units: ContentIndexRepository) {}

  search(p: ContentKeywordQuery) {
    const question = String(p.query ?? '').normalize('NFKC').trim().slice(0, 1000);
    const tokens = extractLexicalTokens(question, 48);
    const referenceFileIds = p.referenceFileIds ?? [];
    const referenceTokens = this.referenceTokens(referenceFileIds, p.scope);
    const referenceArchiveIds = new Set(referenceFileIds.flatMap(fileId =>
      this.units.listUnitsOfFile(fileId).map(unit => unit.archiveId),
    ));
    const allTokens = [...new Set([...tokens, ...referenceTokens])].slice(0, 48);
    const candidates = new Map<number, { row: EvidenceRow; weight: number; matched: Set<string> }>();
    let topKTruncated = false;

    for (const token of allTokens) {
      const rows = this.units.searchChunks(token, p.scope, 500, p.archiveIds, p.archiveNo, p.archiveTitle, p.fileIds);
      if (rows.length >= 500) topKTruncated = true;
      rows.forEach((row, rank) => {
        // A reference-based "find similar" search must not return the seed archive itself.
        if (referenceArchiveIds.has(row.archiveId)) return;
        if (p.extension && row.extension.toLowerCase() !== p.extension.toLowerCase()) return;
        const prior = candidates.get(row.chunkId);
        const matched = prior?.matched ?? new Set<string>();
        matched.add(token);
        candidates.set(row.chunkId, {
          row,
          weight: (prior?.weight ?? 0) + 1 / (60 + rank + 1),
          matched,
        });
      });
    }

    // Explicit-query search favors multiple independent bigrams. When finding
    // *other* documents like a reference, score overlap with the authorized
    // reference's signature instead: the user's short follow-up ("付款") must
    // not force every similar result to literally contain that one word.
    const queryTerms = tokens.slice(0, Math.min(3, tokens.length));
    const similarity = referenceTokens.length > 0;
    const allCandidates = [...candidates.values()];
    const stronglyMatched = allCandidates.filter(item => similarity
      ? referenceTokens.filter(token => item.matched.has(token)).length >= Math.min(2, referenceTokens.length)
      : queryTerms.filter(token => item.matched.has(token)).length >= Math.min(2, queryTerms.length),
    );
    // Prefer multi-term AND-like evidence, but retain OR recall when all
    // documents share only the meaningful part of an unfamiliar natural query.
    // Reference similarity never falls back to a single unrelated token.
    const selected = stronglyMatched.length || similarity ? stronglyMatched : allCandidates;

    const counts = new Map<number, number>();
    const seen = new Set<string>();
    const items = selected
      .sort((a, b) => {
        if (similarity) {
          const overlap = (entry: typeof a) => referenceTokens.filter(token => entry.matched.has(token)).length;
          const difference = overlap(b) - overlap(a);
          if (difference) return difference;
        }
        return b.matched.size - a.matched.size || b.weight - a.weight || a.row.chunkId - b.row.chunkId;
      })
      .filter(({ row }) => {
        const key = `${row.fileId}:${row.unitId}:${row.text.replace(/\s+/gu, ' ')}`;
        const count = counts.get(row.fileId) ?? 0;
        if (seen.has(key) || count >= (p.perFile ?? 3)) return false;
        seen.add(key);
        counts.set(row.fileId, count + 1);
        return true;
      })
      .map(({ row, weight, matched }) => ({ ...row, score: weight + matched.size }));

    return {
      items,
      total: items.length,
      tokens: allTokens,
      truncated: topKTruncated,
      retrievalMode: this.units.ftsAvailable() ? ('fts5' as const) : ('like' as const),
      degradedReason: !this.units.ftsAvailable() ? 'FTS5 Bigram 不可用，使用 LIKE 关键词检索' : null,
    };
  }

  /** Build a bounded lexical signature from authorized reference attachments. */
  private referenceTokens(fileIds: number[], scope: ViewerScope): string[] {
    if (!fileIds.length) return [];
    const archiveIds = [...new Set(fileIds.flatMap(fileId =>
      this.units.listUnitsOfFile(fileId).map(unit => unit.archiveId),
    ))];
    if (!archiveIds.length) return [];
    const rows = this.units.listChunksOfArchives(archiveIds, scope, 1200, fileIds);
    const frequency = new Map<string, number>();
    for (const row of rows) {
      for (const token of extractLexicalTokens(row.text, 256)) {
        if (Array.from(token).length < 2) continue;
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }
    return [...frequency.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 16)
      .map(([token]) => token);
  }
}
