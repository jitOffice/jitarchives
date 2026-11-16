/**
 * Lightweight multilingual lexical tokenizer for archive content.
 *
 * CJK text is indexed as overlapping bigrams; Latin words and numbers remain
 * whole tokens. This is deliberately lexical (not vector/Embedding search).
 * The same implementation is used both when chunks are written and when a
 * user's query is tokenized, so index/query normalization cannot drift.
 */
const TOKEN_RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;
const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Token stream shared by every lexical consumer: one array per run, keeping the
 * run-by-run semantics (CJK run -> overlapping bigrams, Latin/digit run -> one token).
 * Extraction (dedup) and counting (term frequency for TF-IDF) must never drift apart,
 * so both are built on this single generator.
 */
function* lexicalTokenRuns(input: string): Generator<string[]> {
  const normalized = String(input ?? '').normalize('NFKC').toLocaleLowerCase();
  for (const run of normalized.match(TOKEN_RUNS) ?? []) {
    if (EAST_ASIAN.test(run)) {
      const chars = Array.from(run);
      if (chars.length === 1) {
        yield [chars[0]];
      } else {
        const bigrams: string[] = [];
        for (let i = 0; i < chars.length - 1; i += 1) bigrams.push(chars[i] + chars[i + 1]);
        yield bigrams;
      }
    } else if (run) {
      yield [run];
    }
  }
}

export function extractLexicalTokens(input: string, maxTokens = 256): string[] {
  const tokens = new Set<string>();

  for (const group of lexicalTokenRuns(input)) {
    for (const token of group) tokens.add(token);
    if (tokens.size >= maxTokens) break;
  }

  return [...tokens].slice(0, maxTokens);
}

/**
 * Term frequencies over the same tokenizer, for TF-IDF / cosine similarity.
 * Unlike extractLexicalTokens duplicates are counted (not dropped); maxTokens caps
 * the number of analyzed occurrences per document so one oversized attachment
 * cannot dominate the corpus cost.
 */
export function countLexicalTokens(input: string, maxTokens = 8192): Map<string, number> {
  const counts = new Map<string, number>();
  let total = 0;

  for (const group of lexicalTokenRuns(input)) {
    for (const token of group) {
      if (total >= maxTokens) break;
      counts.set(token, (counts.get(token) ?? 0) + 1);
      total += 1;
    }
    if (total >= maxTokens) break;
  }

  return counts;
}

export function buildCjkBigramTerms(input: string): string {
  return extractLexicalTokens(input, 4096).join(' ');
}

/** FTS5 MATCH expression for exact indexed tokens; tokens never contain FTS operators. */
export function buildBigramMatchExpression(tokens: string[], operator: 'AND' | 'OR' = 'OR'): string {
  const safe = [...new Set(tokens.map(token => token.trim()).filter(Boolean))]
    .map(token => `"${token.replace(/"/gu, '""')}"`);
  return safe.length ? safe.join(` ${operator} `) : '';
}
