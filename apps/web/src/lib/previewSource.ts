import type { AgentSourceHit } from '../types.ts';
export function locateRenderedSource(host: HTMLElement, hit: AgentSourceHit, extension: string): boolean {
  const normalized=(s:string)=>s.replace(/\s+/gu,'');
  const excerpt=normalized(hit.text).slice(0,48);
  const elements=Array.from(host.querySelectorAll<HTMLElement>('p,span,div,[data-page-number],[data-page-index]')).slice(0,20000);
  let target=excerpt.length>=8 ? elements.filter(el=>normalized(el.textContent ?? '').includes(excerpt))
    .sort((a,b)=>(a.textContent?.length??0)-(b.textContent?.length??0))[0] : undefined;
  if(!target && extension==='pdf' && hit.pageNo)target=elements.find(el=>el.dataset.pageNumber===String(hit.pageNo) || el.dataset.pageIndex===String(hit.pageNo!-1));
  if(!target)return false;
  target.dataset.sourceHit='true';target.style.outline='2px solid #1677ff';target.scrollIntoView({block:'center'});return true;
}
