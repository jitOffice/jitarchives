import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import type {AgentToolResult} from './tool.types';

export type AgentTraceId='understand'|'archives'|'attachments'|'content'|'evidence'|'answer';
export interface AgentTraceStep {
  id:AgentTraceId; label:string; status:'waiting'|'running'|'completed'|'empty'|'failed'|'skipped';
  hitCount:number; durationMs:number; note?:string;
}
const labels:Record<AgentTraceId,string>={understand:'理解用户问题',archives:'检索档案元数据（标题 / 档号 / 分类）',attachments:'检索附件标题',content:'检索附件正文（全文检索 / 顺序读取）',evidence:'整理相关证据',answer:'生成 AI 回答'};
interface AgentTraceContext {
  started: number;
  steps: Map<AgentTraceId, AgentTraceStep>;
  onUpdate?: (steps: AgentTraceStep[]) => void;
}
const storage = new AsyncLocalStorage<AgentTraceContext>();
function publishTrace(state: AgentTraceContext): void {
  if (!state.onUpdate) return;
  try { state.onUpdate([...state.steps.values()].map((step) => ({ ...step }))); } catch { /* Progress reporting must never affect the Agent request. */ }
}
export function withAgentTrace<T>(run: () => Promise<T>, onUpdate?: (steps: AgentTraceStep[]) => void): Promise<T> {
  const state: AgentTraceContext = { started: performance.now(), steps: new Map(), onUpdate };
  return storage.run(state, async () => {
    try { return await run(); }
    finally { publishTrace(state); }
  });
}
export function understood(matched = true): void {
  const state = storage.getStore();
  if (!state) return;
  const previous = state.steps.get('understand');
  if (previous && previous.status !== 'running') return;
  recordStep('understand', matched ? 'completed' : 'failed', 0, performance.now() - state.started,
    matched ? '意图识别完成' : '未能识别明确意图');
}
export function recordStep(id: AgentTraceId, status: AgentTraceStep['status'], hitCount: number, durationMs: number, note?: string): void {
  const state = storage.getStore();
  if (!state) return;
  const previous = state.steps.get(id);
  state.steps.set(id, {
    id, label: labels[id], status, hitCount,
    durationMs: Math.max(0, Math.round(durationMs || previous?.durationMs || 0)),
    ...(note ? { note } : {}),
  });
  publishTrace(state);
}
export async function tracedAnswer<T>(run:()=>Promise<T>):Promise<T>{
  const start=performance.now();recordStep('answer','running',0,0);
  // The callback must encompass parsing, grounding and final rendering. A bare
  // model request must not use this helper (the content orchestrator records its final state).
  try{const result=await run();recordStep('answer','completed',0,performance.now()-start);return result;}
  catch(error){recordStep('answer','failed',0,performance.now()-start,'模型执行失败，已保留真实检索结果');throw error;}
}
export function finishAgentTrace(tools:AgentToolResult[]=[],_evidenceCount=0):AgentTraceStep[]|undefined{
  const state=storage.getStore();if(!state)return undefined;understood();
  const groups:Array<[AgentTraceId,RegExp]>=[['archives',/^archive\./u],['attachments',/^attachment\./u],['content',/^content\./u]];
  for(const [id,pattern] of groups){
    const results=tools.filter(tool=>pattern.test(tool.toolName));if(!results.length)continue;
    const executed=results.filter(result=>result.status!=='skipped');
    const rows=new Set<string>();for(const result of executed)for(const item of result.data?.items??[])
      rows.add(String(item.chunkId??item.fileId??item.id??JSON.stringify(item)));
    const failed=results.some(result=>result.status==='error');
    const modeLabels:Record<string,string>={ordered:'按原文顺序读取当前版本全部分块',fts5:'SQLite FTS5 / CJK Bigram / BM25',like:'LIKE 关键词降级检索'};
    const mode=results.map(result=>result.data?.keywordMode??result.data?.retrievalMode).find(mode=>modeLabels[mode]);
    const skipped=results.filter(result=>result.status==='skipped').map(result=>result.error?.message).filter(Boolean);
    const indexNotes=id==='content'?results.flatMap(result=>result.data?.notes??[]):[];
    const channels = id === 'archives' ? [['title:', '档案标题'], ['number', '档号'], ['metadata:', '元数据']].flatMap(([prefix, label]) => {
      const channel = results.filter(r => r.callId?.startsWith(prefix));
      if (!channel.length) return [];
      const ids = new Set(channel.flatMap(r => (r.data?.items ?? []).map((row: { id: number }) => row.id)));
      return [`${label}：${ids.size} 条${channel.some(r => r.status === 'error') ? '（查询异常）' : ''}`];
    }) : [];
    const note=[failed?'查询失败或部分失败，请重试':mode?modeLabels[mode]:undefined,...channels,...skipped,...indexNotes].filter(Boolean).join('；');
    recordStep(id,failed?'failed':!executed.length?'skipped':rows.size?'completed':'empty',rows.size,
      results.reduce((sum,result)=>sum+(result.durationMs??0),0),note);
  }
  // Evidence count records actual assembly, independent of how many sources the answer cites.
  if(!state.steps.has('answer')){
    const content=state.steps.get('content'), evidence=state.steps.get('evidence');
    recordStep('answer',content?.status==='empty'||evidence?.status==='empty'?'empty':'skipped',0,0,
      content?.status==='failed'?'正文检索失败，未执行回答':content?.status==='skipped'?'正文检索因依赖条件跳过，未执行回答':
      content?.status==='empty'||evidence?.status==='empty'?'没有找到正文证据，未执行回答':'本轮未安排 AI 回答');
  }
  return (Object.keys(labels) as AgentTraceId[]).map(id=>state.steps.get(id)??{id,label:labels[id],status:'skipped',hitCount:0,durationMs:0,note:'不适用于本次查询（没有对应检索线索或无需正文）'});
}
