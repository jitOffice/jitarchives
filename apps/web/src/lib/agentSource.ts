import type {AgentSource,AgentAttachmentCard} from '../types.ts';

export function sourceRoute(source:Pick<AgentSource,'archiveId'|'fileId'> & Partial<AgentSource> | AgentAttachmentCard) {
  if(!Number.isSafeInteger(source.archiveId)||source.archiveId<=0||!Number.isSafeInteger(source.fileId)||source.fileId<=0)return null;
  const query:Record<string,string>={fileId:String(source.fileId)};
  if('chunkId' in source && source.chunkId)query.chunkId=String(source.chunkId);
  if('pageNo' in source && source.pageNo)query.pageNo=String(source.pageNo);
  if('locator' in source && source.locator)query.locator=source.locator;
  return {path:`/archives/${source.archiveId}`,query};
}

export function routePositiveId(raw:unknown):number|null{
  if(typeof raw!=='string'||!/^\d+$/u.test(raw))return null;
  const id=Number(raw);return Number.isSafeInteger(id)&&id>0?id:null;
}

import type { AgentGraphCitation, AgentPayload } from '../types.ts';
import type { KgGraphNodeView, KgEdgeEvidence } from './knowledge-graph/types.ts';

export function graphNodeRoute(node: Pick<KgGraphNodeView,'type'|'refId'>) {
  if(!['category','archive','file','chunk'].includes(node.type)||!Number.isSafeInteger(node.refId)||node.refId<=0)return null;
  return {path:'/knowledge-graph',query:{nodeType:node.type,refId:String(node.refId)}};
}
export function graphEdgeRoute(c: AgentGraphCitation) {
  if(!Number.isSafeInteger(c.edgeId)||c.edgeId<=0)return null;
  return {path:'/knowledge-graph',query:{edgeId:String(c.edgeId),...(c.edge ? {fromId:String(c.edge.fromId),toId:String(c.edge.toId)}:{})}};
}
export function answerCitationParts(content: string, payload?: AgentPayload | null) {
  return content.split(/(\[[EG]\d+\])/giu).filter(Boolean).map(text=>{
    const ref=/^\[([EG]\d+)\]$/iu.exec(text)?.[1]?.toUpperCase();
    const source=payload?.sources?.find(item=>item.ref.toUpperCase()===ref);
    const graph=payload?.graphCitations?.find(item=>item.ref.toUpperCase()===ref);
    const metadata=payload?.metadataSources?.some(item=>item.ref.toUpperCase()===ref);
    return {text:ref?(source||graph||metadata?'['+ref+']':''):text,source,graph};
  });
}
/** 按真实档案 + 附件 + 版本归并来源；同一附件的多个知识块只显示一条附件入口。 */
export interface AgentSourceGroup {
  key: string;
  archiveId: number;
  fileId: number;
  versionNo: number | null;
  archiveTitle: string;
  archiveNo: string;
  fileName: string;
  detailPath: string;
  sources: AgentSource[];
  refs: string[];
}

export function groupAgentSources(sources?: AgentSource[] | null): AgentSourceGroup[] {
  const groups = new Map<string, AgentSourceGroup>();
  for (const source of sources ?? []) {
    if (!source || !Number.isSafeInteger(source.archiveId) || source.archiveId <= 0 ||
      !Number.isSafeInteger(source.fileId) || source.fileId <= 0) continue;
    const version = source.versionId ?? source.versionNo ?? 'original';
    const key = `${source.archiveId}:${source.fileId}:${version}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, archiveId: source.archiveId, fileId: source.fileId, versionNo: source.versionNo,
        archiveTitle: source.archiveTitle, archiveNo: source.archiveNo, fileName: source.fileName,
        detailPath: source.detailPath, sources: [], refs: [] };
      groups.set(key, group);
    }
    group.sources.push(source);
    if (source.ref && !group.refs.includes(source.ref)) group.refs.push(source.ref);
  }
  return [...groups.values()];
}

export function graphEvidenceRows(e: KgEdgeEvidence): Array<{label:string;value:string}> {
  switch(e.basis){
    case 'business_structure':
      return [{label:'关联依据',value:'档案之间的业务归属关系'}];
    case 'tfidf_cosine':
      return [
        {label:'关联依据',value:'两处正文内容存在相似之处'},
        {label:'共同关键词',value:e.sharedTerms.slice(0, 6).join('、') || '暂无'},
        {label:'原文位置',value:e.from.locator+' ↔ '+e.to.locator}
      ];
    case 'tfidf_cosine_aggregated':
      return [{label:'关联依据',value:'多个正文位置存在相似内容'}];
    case 'metadata_exact_match':
      return [{label:'匹配字段',value:e.fieldLabel},{label:'相同内容',value:e.value}];
    default:
      return [{label:'关联依据',value:'当前无法确认具体关联原因'}];
  }
}
