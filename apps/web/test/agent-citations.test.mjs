import test from 'node:test';import assert from 'node:assert/strict';
import {sourceRoute,graphNodeRoute,graphEdgeRoute,answerCitationParts,graphEvidenceRows,groupAgentSources} from '../src/lib/agentSource.ts';
test('E/G markers preserve exact reference numbers and unknown references have no link',()=>{
 const source={ref:'E7',archiveId:1,fileId:4},graph={ref:'G3',edgeId:9};
 const parts=answerCitationParts('原文[E7]，关系[G3]，伪造[G999]。',{sources:[source],graphCitations:[graph]});
 assert.equal(parts.find(p=>p.source)?.text,'[E7]');assert.equal(parts.find(p=>p.graph)?.text,'[G3]');assert.ok(!parts.some(p=>p.text==='[G999]'));
 assert.deepEqual(answerCitationParts('旧消息',{}),[{text:'旧消息',source:undefined,graph:undefined}]);
});
test('TXT/PDF/DOCX routes keep original attachment and server-verified chunk IDs',()=>{
 for(const locator of ['TXT 第 3 行','PDF 第 2 页','DOCX 第 4 段'])assert.deepEqual(sourceRoute({archiveId:7,fileId:8,chunkId:9,pageNo:2,locator}),{path:'/archives/7',query:{fileId:'8',chunkId:'9',pageNo:'2',locator}});
 assert.equal(sourceRoute({archiveId:-1,fileId:2}),null);
});
test('category/archive/file/chunk references locate by authoritative business ID, edges pin both endpoints',()=>{
 for(const type of ['category','archive','file','chunk'])assert.deepEqual(graphNodeRoute({type,refId:42}),{path:'/knowledge-graph',query:{nodeType:type,refId:'42'}});
 assert.equal(graphNodeRoute({type:'archive',refId:0}),null);
 assert.deepEqual(graphEdgeRoute({edgeId:8,edge:{fromId:10,toId:11}}),{path:'/knowledge-graph',query:{edgeId:'8',fromId:'10',toId:'11'}});
 assert.deepEqual(graphEdgeRoute({edgeId:8}),{path:'/knowledge-graph',query:{edgeId:'8'}});
});
test('64条知识块按真实档案+附件+版本归并为少量附件来源，E编号保持一一对应',()=>{
 const sources=Array.from({length:64},(_,i)=>({ref:'E'+(i+1),archiveId:7,fileId:9,versionNo:2,versionId:22,archiveTitle:'采购档案',archiveNo:'CG-2026-1',fileName:'采购合同.docx',locator:'DOCX 第 '+(i+1)+' 段',excerpt:'正文'+i,detailPath:'/archives/7'}));
 const groups=groupAgentSources(sources);
 assert.equal(groups.length,1);assert.equal(groups[0].sources.length,64);
 assert.deepEqual(groups[0].refs.slice(0,3),['E1','E2','E3']);
 assert.equal(groups[0].fileName,'采购合同.docx');assert.equal(groups[0].archiveId,7);assert.equal(groups[0].fileId,9);
 const versions=[...sources,{...sources[0],ref:'E65',versionNo:3,versionId:33}];
 const split=groupAgentSources(versions);assert.equal(split.length,2,'不同版本必须分开归并');
 assert.equal(split[1].sources[0].ref,'E65');
 assert.deepEqual(groupAgentSources([{ref:'E1',archiveId:0,fileId:1}]),[],'非法来源不得进入展示');
});
test('relationship explanations use Chinese basis labels and uncalibrated values have no percent display',()=>{
 const cases=[{basis:'business_structure',origin:'structure'}, {basis:'tfidf_cosine',similarity:0.96,sharedTerms:['采购'],from:{locator:'第1页'},to:{locator:'第2页'}},
 {basis:'tfidf_cosine_aggregated',supportCount:2,maxChunkSimilarity:0.92},{basis:'metadata_exact_match',fieldLabel:'合同号',value:'HT-1'}];
 const rows=cases.map(e=>graphEvidenceRows(e));assert.match(JSON.stringify(rows),/合同号/u);assert.doesNotMatch(JSON.stringify(rows),/%|tfidf_cosine|business_structure|metadata_exact_match/u);
});
