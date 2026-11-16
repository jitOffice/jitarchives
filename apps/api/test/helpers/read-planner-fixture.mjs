/** Planner double for older read-path integration tests. It returns clues only;
 * actual rows, authorization, file ownership and citations still come from SQLite.
 * These fixtures test execution mechanics, never real model understanding.
 */
import {parseDeterministic,extractAttachmentNames} from '../../dist/agent/intent.parser.js';
import {emptyRetrievalPlan} from '../../dist/agent/retrieval.plan.js';
import {parseReference} from '../../dist/agent/agent.context.js';

export function readPlannerFixture(messages) {
  const system=messages[0]?.content??'';
  if(system.startsWith('EVIDENCE_SUFFICIENCY_V1'))return {content:'{"verdict":"sufficient","note":"读取测试按实际工具结果核对","supplement":[]}',truncated:false};
  if(!system.startsWith('RETRIEVAL_PLAN_V1'))return null;
  const {question,context={}}=JSON.parse(messages[1].content);
  const intent=parseDeterministic({question,categories:[]}).intent;
  const p=emptyRetrievalPlan(question);p.allowExpansion=false;
  p.contentTerms=intent.contentTerms??[];
  p.hardConstraints.archiveNumbers=intent.archiveNo?[intent.archiveNo]:[];
  if(intent.title && !intent.archiveNo && !/\.[a-zA-Z0-9]{1,8}$/u.test(intent.title))p.hardConstraints.archiveTitles=[intent.title];
  p.hardConstraints.attachmentNames=extractAttachmentNames(question);
  if(intent.attachmentFileName && !p.hardConstraints.attachmentNames.length)p.hardConstraints.attachmentNames=[intent.attachmentFileName];
  if(intent.title && /\.[a-zA-Z0-9]{1,8}$/u.test(intent.title))p.hardConstraints.attachmentNames=[intent.title];
  const content=intent.kind==='content_question' || intent.scopes?.includes('content');
  p.responseMode=content?(intent.isSummaryQuestion?'summary':'content_qa'):'find';
  const explicit=p.hardConstraints.archiveNumbers.length || p.hardConstraints.archiveTitles.length || p.hardConstraints.attachmentNames.length;
  const ref=parseReference(question);
  const add=(id,tool,args,expects,extra={})=>p.planSteps.push({id,tool,args,expects,intent:id,...extra});
  let locator;
  if(p.hardConstraints.archiveNumbers.length || p.hardConstraints.archiveTitles.length){locator='owner';add(locator,'archive.search',{},'metadata');}
  if(p.hardConstraints.attachmentNames.length){locator='file';add(locator,'attachment.search',{attachmentFileName:p.hardConstraints.attachmentNames[0]},'attachmentNames');}
  if(content){
    const extra=!explicit && ref && (context.attachmentSlots?.length || context.archiveSlots?.length)?{
      contextRef:{entity:context.attachmentSlots?.length?'attachment':'archive',slot:ref.ordinal??'all'}}:locator?{scope:`step:${locator}`}:{ };
    if(intent.isSummaryQuestion || Object.keys(extra).includes('contextRef'))add('body','content.read',{},'fullText',extra);
    else add('body','content.search',{query:p.contentTerms.join(' ')},'relevantText',extra);
  } else if(intent.scopes?.includes('attachment') || intent.attachmentMode){
    add('files','attachment.search',{},'attachmentNames',locator?{scope:`step:${locator}`}:{ });
  } else add('archives','archive.search',intent.keyword?{keyword:intent.keyword}:{},'metadata');
  const {originalQuestion,normalizedQuestion,...wire}=p;
  return {content:JSON.stringify(wire),truncated:false};
}
