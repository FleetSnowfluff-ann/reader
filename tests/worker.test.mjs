import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handle,TranslationBudget,validateRequest} from '../worker/index.js';
const origin='https://fleetsnowfluff-ann.github.io';
const body={sourceLanguage:'en',targetLanguage:'zh-CN',sentences:[{id:'p1-s1',text:'Source one.'},{id:'p1-s2',text:'Source two.'}],challengeToken:'test-only'};
const request=(data=body,headers={})=>new Request('https://proxy.example/translate',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
const environment=()=>({ALLOWED_ORIGINS:origin,DEEPL_API_KEY:'unit-test-only:fx',TURNSTILE_SECRET:'unit-test-only',BUDGET:{idFromName:x=>x,get:()=>({fetch:async()=>new Response('{}')})}});
test('proxy fails closed without secrets, rejects foreign origins and never enables a paid key',async()=>{
 for(const env of [{ALLOWED_ORIGINS:origin},{...environment(),DEEPL_API_KEY:'paid-key'}]){let calls=0;const r=await handle(request(),env,()=>calls++);assert.equal(r.status,503);assert.equal(calls,0);}
 assert.equal((await handle(request(body,{Origin:'https://evil.example'}),environment())).status,403);
 assert.throws(()=>validateRequest({...body,sentences:[...body.sentences,body.sentences[0]]}),/Invalid/);
 assert.throws(()=>validateRequest({...body,sentences:[{id:'p1-s1',text:'x'.repeat(4001)}]}),/4,000/);
});
test('proxy verifies challenge hostname and action before any translation or budget use',async()=>{
 for(const verification of [{success:false},{success:true,hostname:'evil.example',action:'reader-translate'},{success:true,hostname:new URL(origin).hostname,action:'wrong'}]){
  let calls=0;const response=await handle(request(),environment(),async()=>{calls++;return Response.json(verification);});assert.equal(response.status,403);assert.equal(calls,1);
 }
});
test('provider contract maps one result per exact input and provider key never reaches the response',async()=>{
 let provider;
 const response=await handle(request(),environment(),async(url,init)=>{
  if(url.includes('siteverify'))return Response.json({success:true,hostname:new URL(origin).hostname,action:'reader-translate'});
  assert.equal(url,'https://api-free.deepl.com/v2/translate');provider=JSON.parse(init.body);assert.ok(init.headers.Authorization.endsWith(':fx'));return Response.json({translations:[{text:'第一句。'},{text:'第二句。'}]});
 });
 assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.translations.map(t=>t.sourceIds),[['p1-s1'],['p1-s2']]);assert.deepEqual(provider.text,['Source one.','Source two.']);assert.equal(provider.target_lang,'ZH-HANS');assert.ok(!JSON.stringify(result).includes('unit-test-only'));
});
test('retry attempts each reserve quota and budget exhaustion stops further provider calls',async()=>{
 const env=environment();let reservations=0,calls=0;
 env.BUDGET.get=()=>({fetch:async()=>new Response('{}',{status:++reservations<=2?200:429})});
 const response=await handle(request(),env,async url=>url.includes('siteverify')?Response.json({success:true,hostname:new URL(origin).hostname,action:'reader-translate'}):(calls++,new Response('',{status:503})),async()=>{});
 assert.equal(response.status,429);assert.equal(calls,2);assert.equal(reservations,3);assert.equal((await response.json()).retryable,false);
});
test('mismatched provider output is rejected instead of inventing a sentence match',async()=>{
 const r=await handle(request(),environment(),async url=>url.includes('siteverify')?Response.json({success:true,hostname:new URL(origin).hostname,action:'reader-translate'}):Response.json({translations:[{text:'only one result'}]}));assert.equal(r.status,502);
});
test('atomic global budget bounds concurrent requests; stored state contains no original text or raw IP',async()=>{
 const values=new Map();let chain=Promise.resolve();
 const storage={transaction:fn=>{const task=chain.then(()=>fn({get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v))}));chain=task.catch(()=>{});return task;}};
 const gate=new TranslationBudget({storage},{MONTHLY_CHAR_LIMIT:'100',DAILY_CHAR_LIMIT:'100',IP_DAILY_CHAR_LIMIT:'100'});
 const reserve=()=>gate.fetch(new Request('https://budget/reserve',{method:'POST',body:JSON.stringify({characters:60,client:'a'.repeat(64)})}));
 const results=await Promise.all([reserve(),reserve(),reserve()]);assert.deepEqual(results.map(r=>r.status),[200,429,429]);assert.equal(values.get('budget').total,60);assert.ok(!JSON.stringify([...values]).includes('Source one.'));
});
