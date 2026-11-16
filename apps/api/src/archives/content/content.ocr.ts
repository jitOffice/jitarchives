/** Optional OCR seam for a future deployment adapter. No OCR provider/dependency is bundled. */
import { ExtractResult } from './content.types';
export interface OcrAdapter {
  supports(extension: string): boolean;
  /** Input paths must be resolved by FileStorage; implementations must preserve real page locators. */
  extract(controlledFilePath: string, extension: string): ExtractResult;
}
