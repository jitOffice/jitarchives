import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, ensureContentBigramFts, hasContentBigramFts } from '../dist/db/database.js';
import { buildCjkBigramTerms, buildBigramMatchExpression, extractLexicalTokens } from '../dist/search/cjk-bigram.js';

function insertUnit(db, storedName = 'test-file-v1') {
  const result = db.prepare(`
    INSERT INTO archive_content_units
      (archive_id,file_id,stored_name,status,indexed_at)
    VALUES (1,1,?,'indexed',?)
  `).run(storedName, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function insertChunk(db, unitId, text, searchTerms = buildCjkBigramTerms(text)) {
  const result = db.prepare(`
    INSERT INTO archive_content_chunks
      (unit_id,archive_id,file_id,chunk_no,locator,page_no,pos_from,pos_to,text,search_terms)
    VALUES (?,1,1,0,'page:1',1,0,?, ?, ?)
  `).run(unitId, text.length, text, searchTerms);
  return Number(result.lastInsertRowid);
}

function matches(db, token) {
  return db.prepare(`
    SELECT rowid FROM archive_content_fts_bigram
    WHERE archive_content_fts_bigram MATCH ?
  `).all(buildBigramMatchExpression([token]));
}

test('CJK bigram tokenizer creates identical normalized terms for ingestion and query', () => {
  assert.deepEqual(extractLexicalTokens('付款期限与违约责任'), ['付款', '款期', '期限', '限与', '与违', '违约', '约责', '责任']);
  assert.equal(buildCjkBigramTerms('付款期限'), '付款 款期 期限');
  assert.equal(buildCjkBigramTerms('Contract 2026'), 'contract 2026');
});

test('SQLite FTS5 Bigram indexes short Chinese terms and maintains insert/update/delete/status changes', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(hasContentBigramFts(db), true);
    const unitId = insertUnit(db);
    const chunkId = insertChunk(db, unitId, '本合同约定付款期限为三十日，并明确违约责任。');

    assert.equal(matches(db, '付款').some(row => Number(row.rowid) === chunkId), true);
    assert.equal(matches(db, '违约').some(row => Number(row.rowid) === chunkId), true);
    assert.equal(matches(db, '款期').some(row => Number(row.rowid) === chunkId), true);

    db.prepare('UPDATE archive_content_chunks SET search_terms=? WHERE id=?')
      .run(buildCjkBigramTerms('采购合同验收标准'), chunkId);
    assert.equal(matches(db, '付款').some(row => Number(row.rowid) === chunkId), false);
    assert.equal(matches(db, '采购').some(row => Number(row.rowid) === chunkId), true);

    db.prepare("UPDATE archive_content_units SET status='no_text' WHERE id=?").run(unitId);
    assert.equal(matches(db, '采购').some(row => Number(row.rowid) === chunkId), false);
    db.prepare("UPDATE archive_content_units SET status='indexed' WHERE id=?").run(unitId);
    assert.equal(matches(db, '采购').some(row => Number(row.rowid) === chunkId), true);

    db.prepare('DELETE FROM archive_content_chunks WHERE id=?').run(chunkId);
    assert.equal(matches(db, '采购').some(row => Number(row.rowid) === chunkId), false);
  } finally {
    db.close();
  }
});

test('Bigram FTS can backfill pre-existing chunks with empty search_terms', () => {
  const db = openDatabase(':memory:');
  try {
    const unitId = insertUnit(db, 'legacy-file-v1');
    const chunkId = insertChunk(db, unitId, '历史附件包含付款条款和验收要求', '');
    assert.equal(matches(db, '付款').some(row => Number(row.rowid) === chunkId), false);

    db.prepare("DELETE FROM _migrations WHERE id='113-content-bigram-fts-backfill'").run();
    assert.equal(ensureContentBigramFts(db), true);
    assert.equal(matches(db, '付款').some(row => Number(row.rowid) === chunkId), true);
  } finally {
    db.close();
  }
});
