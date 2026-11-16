import { BlockUnit, ContentBlock, EXTRACTOR_LABEL, formatLocator } from './content.types';

export const CHUNK_MAX_CHARS = 500;
export const CONTENT_PIPELINE_VERSION = 'rag-v4-2';
export interface ChunkDraft {
  chunkNo: number; text: string; locator: string; unit: BlockUnit; pageNo: number | null;
  posFrom: number; posTo: number;
}

/** Sentence-aware splitting; never merge pages, sheets or distant positions. */
export function chunkBlocks(blocks: ContentBlock[], extractor: string): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  let bucket: ContentBlock | null = null;
  const flush = () => {
    if (!bucket) return;
    drafts.push({ chunkNo: drafts.length + 1, text: bucket.text,
      locator: formatLocator(EXTRACTOR_LABEL[extractor] ?? '正文', bucket), unit: bucket.unit,
      pageNo: bucket.page, posFrom: bucket.from, posTo: bucket.to });
    bucket = null;
  };
  for (const source of blocks) {
    let remaining = source.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    while (remaining) {
      let end = Math.min(CHUNK_MAX_CHARS, remaining.length);
      if (remaining.length > end) {
        const prefix = remaining.slice(0, end);
        const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf('\n'), prefix.lastIndexOf('. '));
        if (boundary > CHUNK_MAX_CHARS / 2) end = boundary + 1;
        if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      }
      const block = { ...source, text: remaining.slice(0, end).trim() };
      remaining = remaining.slice(end).trimStart();
      const prior = bucket as ContentBlock | null;
      if (prior && prior.unit === block.unit && prior.page === block.page && prior.section === block.section &&
          prior.to + 1 === block.from && prior.text.length + block.text.length + 1 <= CHUNK_MAX_CHARS) {
        bucket = { ...prior, text: `${prior.text}\n${block.text}`, to: block.to };
      } else { flush(); bucket = block; }
      if (remaining) flush();
    }
  }
  flush();
  return drafts;
}
