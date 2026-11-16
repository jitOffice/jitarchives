import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvidence,verifyCitations} from '../dist/agent/content.evidence.js';

const evidence=buildEvidence([
 {chunkId:1,unitId:1,archiveId:1,fileId:1,archiveTitle:'采购合同',fileName:'甲.pdf',text:'验收合格后30日内完成付款。金额为1.5万元。不得提前支付。',locator:'PDF 第1页'},
 {chunkId:2,unitId:2,archiveId:2,fileId:2,archiveTitle:'销售合同',fileName:'乙.txt',text:'交付后15日内完成付款。签署日期为2026年10月30日。',locator:'TXT 第2行'},
]);
const claim=(text,evidenceQuote,citations=['E1'])=>({text,evidenceQuote,citations});
const answer=claims=>JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims});

test('结构化引用允许真实自然语言改写，日与天等价且精确摘录可追溯',()=>{
 const c=claim('合同约定，验收通过后30天内完成付款。','验收合格后30日内完成付款。');
 const result=verifyCitations(answer([c]),evidence);assert.equal(result.valid,true);assert.equal(result.citations[0].row.fileId,1);assert.deepEqual(result.claims[0].citations,['E1']);
});
test('逐项拒绝伪造编号、原文、数值、日期、否定反转、遗漏条件和额外事实',()=>{
 const invalid=[
  answer([claim('验收合格后30日内完成付款。','验收合格后30日内完成付款。',['E99'])]),
  answer([claim('验收合格后30日内完成付款。','验收合格后30日内完成付款（伪造）。')]),
  answer([claim('验收合格后99日内完成付款。','验收合格后30日内完成付款。')]),
  answer([claim('金额为15万元。','金额为1.5万元。')]),
  answer([claim('签署日期为2027年10月30日。','签署日期为2026年10月30日。',['E2'])]),
  answer([claim('可以提前支付。','不得提前支付。')]),
  answer([claim('30日内完成付款。','验收合格后30日内完成付款。')]),
  answer([claim('30日内完成付款。','30日内完成付款。')]),
  // 伪造事实必须落在 claims 里才会被逐条核验拦住（protectedFacts）；answer 字段不展示、不进入语义复核，被忽略。
  JSON.stringify({answer:'验收合格后30日内完成付款。另外支付99万元。',claims:[claim('金额为99万元。','金额为1.5万元。')]}),
  answer([claim('交付后30日内完成付款。','交付后15日内完成付款。',['E2'])]),
 ];
 for(const raw of invalid)assert.equal(verifyCitations(raw,evidence).valid,false,raw);
});
test('多档案每项事实分别核对自己的来源，并由服务端标明档案附件名称',()=>{
 const result=verifyCitations(answer([
  claim('合同约定，验收通过后30天内完成付款。','验收合格后30日内完成付款。'),
  claim('交付后15天内完成付款。','交付后15日内完成付款。',['E2'])]),evidence);
 assert.equal(result.valid,true);assert.match(result.cleaned,/采购合同.*甲.pdf/s);assert.match(result.cleaned,/销售合同.*乙.txt/s);assert.equal(result.citations.length,2);
});
