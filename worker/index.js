// Cloudflare Worker, no third-party SDK. This entrypoint is NEVER in dist/.
const json = (body, status=200, headers={}) => new Response(JSON.stringify(body), { status, headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers} });
const count = text => [...text].length;
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export async function boundedJSON(request, maximum=32768) {
  if(Number(request.headers.get('content-length'))>maximum)throw new Error('Request too large');
  const reader=request.body?.getReader();if(!reader)throw new Error('Empty request');
  let length=0;const chunks=[];
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>maximum){await reader.cancel();throw new Error('Request too large');}chunks.push(value);}
  const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(data));
}
export function validateRequest(body) {
  if(body?.sourceLanguage!=='en'||body.targetLanguage!=='zh-CN'||!Array.isArray(body.sentences)||!body.sentences.length||body.sentences.length>50)throw new Error('Expected 1–50 English sentences');
  const ids=new Set();let characters=0;
  for(const s of body.sentences){if(!s||typeof s.id!=='string'||!/^p\d+-s\d+$/.test(s.id)||ids.has(s.id)||typeof s.text!=='string'||!s.text.trim())throw new Error('Invalid sentence');ids.add(s.id);characters+=count(s.text);}
  if(characters>4000)throw new Error('At most 4,000 characters per batch');
  return characters;
}
export async function handle(request,env,fetcher=fetch,sleep=delay) {
  const origin=request.headers.get('Origin');
  const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!origin||!allowed.includes(origin))return json({error:'Origin not allowed'},403);
  const cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST'||new URL(request.url).pathname!=='/translate')return json({error:'Not found'},404,cors);
  // Fail closed. A Pro key cannot accidentally switch this free-only proxy to billing.
  if(!env.DEEPL_API_KEY?.endsWith(':fx')||!env.TURNSTILE_SECRET||!env.BUDGET)return json({error:'Translation service not configured for API Free',retryable:false},503,cors);
  let body,characters;
  try{body=await boundedJSON(request);characters=validateRequest(body);if(typeof body.challengeToken!=='string'||body.challengeToken.length>2048||!body.challengeToken)throw new Error('Human verification required');}
  catch(error){return json({error:error.message,retryable:false},400,cors);}
  try{
    const challenge=await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret:env.TURNSTILE_SECRET,response:body.challengeToken}),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!challenge.ok)return json({error:'Human verification unavailable',retryable:false},503,cors);
    const verified=await challenge.json();
    if(!verified.success||verified.hostname!==new URL(origin).hostname||verified.action!=='reader-translate')return json({error:'Human verification failed',retryable:false},403,cors);
    const client=await digest((request.headers.get('CF-Connecting-IP')||'unknown')+'|'+env.TURNSTILE_SECRET);
    const gate=env.BUDGET.get(env.BUDGET.idFromName('global-free-budget'));
    for(let attempt=0;attempt<3;attempt++){
      const reservation=await gate.fetch('https://budget/reserve',{method:'POST',body:JSON.stringify({characters,client})});
      if(!reservation.ok)return json({error:'Daily or monthly translation budget reached. No further provider request was sent.',retryable:false},429,cors);
      const response=await fetcher('https://api-free.deepl.com/v2/translate',{method:'POST',headers:{'Authorization':`DeepL-Auth-Key ${env.DEEPL_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({text:body.sentences.map(s=>s.text),source_lang:'EN',target_lang:'ZH-HANS',split_sentences:'0',preserve_formatting:true}),redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok){
        await response.body?.cancel();
        if([429,502,503,504].includes(response.status)&&attempt<2){await sleep(1000*2**attempt);continue;}
        return json({error:response.status===456?'DeepL free quota exhausted.':'Translation provider unavailable; retry later.',retryable:false},response.status===456?429:502,cors);
      }
      const result=await boundedJSON(response,262144);
      if(!Array.isArray(result.translations)||result.translations.length!==body.sentences.length||result.translations.some(t=>typeof t.text!=='string'||!t.text.trim()||t.text.length>20000))throw new Error('Provider response mismatch');
      // DeepL's documented contract returns one result per input in input order.
      // This is provenance, NOT a semantic-accuracy or alignment-confidence claim.
      return json({translations:result.translations.map((t,i)=>({sourceIds:[body.sentences[i].id],text:t.text})),provider:'DeepL API Free',characters,attempts:attempt+1},200,cors);
    }
  }catch{return json({error:'Translation failed or timed out. No PDF or note was sent. Retry manually; an uncertain attempt still consumes the safety budget.',retryable:false},502,cors);}
}
export default { fetch(request,env) { return handle(request,env); } };

export class TranslationBudget {
  constructor(state,env){this.state=state;this.env=env;}
  async fetch(request){
    let input;try{input=await request.json();}catch{return json({error:'Bad reservation'},400);}
    const {characters,client}=input;
    if(!Number.isSafeInteger(characters)||characters<1||characters>4000||!/^\w{64}$/.test(client))return json({error:'Bad reservation'},400);
    const now=new Date().toISOString(),day=now.slice(0,10),month=now.slice(0,7);
    const cap=(value,fallback,maximum)=>Number.isSafeInteger(Number(value))&&Number(value)>0?Math.min(Number(value),maximum):fallback;
    const monthly=cap(this.env.MONTHLY_CHAR_LIMIT,100000,500000),daily=cap(this.env.DAILY_CHAR_LIMIT,50000,500000),personal=cap(this.env.IP_DAILY_CHAR_LIMIT,20000,100000);
    const allowed=await this.state.storage.transaction(async tx=>{
      const data=await tx.get('budget')||{month,day,total:0,today:0,clients:{}};
      if(data.month!==month){data.month=month;data.total=0;}
      if(data.day!==day){data.day=day;data.today=0;data.clients={};}
      if(!(client in data.clients)&&Object.keys(data.clients).length>=1000)return false;
      if(data.total+characters>monthly||data.today+characters>daily||(data.clients[client]||0)+characters>personal)return false;
      data.total+=characters;data.today+=characters;data.clients[client]=(data.clients[client]||0)+characters;await tx.put('budget',data);return true;
    });
    return json({allowed},allowed?200:429);
  }
}
