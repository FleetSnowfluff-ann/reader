// Sequential, cancellable and resumable. No rendering/navigation state lives here.
export const characterCount = text => [...text].length;
const check = signal => { if(signal?.aborted)throw signal.reason || new DOMException('Translation stopped','AbortError'); };
async function cacheKey(endpoint,text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`en|zh-CN|${endpoint}|${text}`))),b=>b.toString(16).padStart(2,'0')).join(''); }
export function batches(sources,maximum=4000) {
  const result=[];let current=[],size=0;
  for(const source of sources){const n=characterCount(source.text);if(n>maximum)throw new Error(`Source ${source.id} exceeds the service batch limit. Review and translate it manually.`);if(current.length && (current.length===50 || size+n>maximum)){result.push(current);current=[];size=0;}current.push(source);size+=n;}
  if(current.length)result.push(current);return result;
}
export async function runTranslationJob({pages,extract,getExisting,request,onBatch,onProgress,endpoint,cache={},limit=20000,signal}) {
  if(!Number.isSafeInteger(limit)||limit<100||limit>100000)throw new Error('Choose a character limit between 100 and 100,000.');
  let total=0,skipped=0,completed=0;const work=[];
  for(const page of pages){
    check(signal);onProgress({phase:'Preparing',page,totalPages:pages.length,completed,characters:total,skipped});
    const sources=await extract(page);check(signal);
    const existing=new Set(getExisting(page).flatMap(t=>t.sourceIds));
    const todo=[];
    for(const source of sources){
      if(existing.has(source.id))continue;
      if(source.warnings?.some(w=>/Unreliable|unresolved|ambiguous|Rotated/.test(w))){skipped++;continue;}
      const key=await cacheKey(endpoint,source.text),hit=cache[key];
      const cached=typeof hit?.text==='string' && hit.text.length>0 && hit.text.length<=20000;
      if(!cached)total+=characterCount(source.text);
      todo.push({source,key,cached:cached?hit:null});
    }
    // Reject impossible batches before making ANY network request.
    batches(todo.filter(t=>!t.cached).map(t=>t.source));
    work.push({page,todo});
  }
  if(total>limit)throw new Error(`This job needs ${total.toLocaleString()} uncached characters, above your ${limit.toLocaleString()} limit. No text was sent. Increase the limit or translate selected pages.`);
  let sent=0;
  for(const {page,todo} of work){
    check(signal);
    const cached=todo.filter(t=>t.cached).map(t=>({id:crypto.randomUUID(),text:t.cached.text,sourceIds:[t.source.id],confirmed:false,provenance:{kind:'machine',provider:t.cached.provider||'adapter',cached:true,createdAt:Date.now()}}));
    if(cached.length)await onBatch(page,cached);
    for(const batch of batches(todo.filter(t=>!t.cached).map(t=>t.source))){
      check(signal);onProgress({phase:'Translating',page,totalPages:pages.length,completed,characters:total,sent,skipped});
      const entries=await request(batch,signal);check(signal);
      // Cache only one-to-one responses: never infer mapping for arbitrary adapters.
      for(const entry of entries)if(entry.sourceIds.length===1){const item=todo.find(t=>t.source.id===entry.sourceIds[0]);if(item && entries.filter(t=>t.sourceIds.includes(item.source.id)).length===1)cache[item.key]={text:entry.text,provider:entry.provenance?.provider};}
      await onBatch(page,entries);sent+=batch.reduce((n,s)=>n+characterCount(s.text),0);
    }
    completed++;onProgress({phase:'Saved',page,totalPages:pages.length,completed,characters:total,sent,skipped});
  }
  return {completed,characters:sent,skipped};
}
