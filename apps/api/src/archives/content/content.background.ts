import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extractFileContent } from './content.extract';
import { ExtractResult } from './content.types';

export interface PreparedContent { actualHash: string; result: ExtractResult }

export function extractInBackground(filePath: string | null, extension: string): Promise<PreparedContent> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {workerData: {filePath,extension}, resourceLimits: {maxOldGenerationSizeMb:128}});
    let delivered=false;
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Extraction timeout')); },30000);
    worker.once('message', (result: PreparedContent) => { delivered=true;clearTimeout(timer); resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0 || !delivered) reject(new Error('Extraction worker failed')); });
  });
}

if (!isMainThread) {
  const {filePath,extension} = workerData as {filePath: string | null; extension: string};
  if (!filePath) parentPort!.postMessage({actualHash:'',result:{status:'failed',message:'文件实体缺失，无法提取正文',extractor:'',blocks:[],truncated:false}});
  else {
    if (statSync(filePath).size > 40 * 1024 * 1024)
      parentPort!.postMessage({actualHash:'',result:{status:'unsupported',message:'文件超过40MB正文提取上限',extractor:'',blocks:[],truncated:false}} satisfies PreparedContent);
    else {
      const actualHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      parentPort!.postMessage({actualHash,result:extractFileContent(filePath,extension)} satisfies PreparedContent);
    }
  }
}
