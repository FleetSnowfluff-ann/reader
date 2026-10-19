import {test} from 'node:test';
import assert from 'node:assert/strict';
import {History} from '../src/history.js';
import {planLayout} from '../src/layout.js';
import {runTranslationJob,batches} from '../src/translation-job.js';
import {createNote,exportBackup,importBackup} from '../src/annotations.js';
import {markdown} from '../src/core.js';
const source=(id='p1-s1',text='A reliable sentence.')=>({id,text,page:1,rects:[{x:.1,y:.1,width:.3,height:.03}],warnings:[]});
test('history reverses edits and removals across navigation without reverting source anchors',()=>{
 const doc={notes:[],translations:{1:[]},lastPage:1,sources:{1:[source()]}};const h=new History(2);
 h.record(doc,'Add',()=>doc.notes.push({id:'n',text:'first'}));h.record(doc,'Edit',()=>doc.notes[0].text='second');doc.lastPage=2;
 assert.equal(h.undo(doc),'Edit');assert.equal(doc.notes[0].text,'first');assert.equal(doc.lastPage,2);assert.equal(doc.sources[1][0].id,'p1-s1');
 h.redo(doc);assert.equal(doc.notes[0].text,'second');h.record(doc,'Delete',()=>doc.notes=[]);h.undo(doc);assert.equal(doc.notes[0].text,'second');
 h.record(doc,'New',()=>doc.notes[0].text='branch');assert.equal(h.redo(doc),null);
 assert.throws(()=>h.record(doc,'Invalid',()=>{doc.notes=[];throw new Error('invalid');}));assert.equal(doc.notes[0].text,'branch');
});
test('mirror plans join overlapping sentence regions without changing IDs; disjoint links stay outside',()=>{
 const a=source(),b={...source('p1-s2'),rects:[{x:.2,y:.11,width:.3,height:.03}]},c={...source('p1-s3'),rects:[{x:.6,y:.1,width:.3,height:.03}]};
 const t={id:'t',sourceIds:[a.id],text:'一句话。'};
 const plan=planLayout([a,b,c],[t]);assert.equal(plan.length,2);assert.equal(plan.find(p=>p.targets.length).sources.length,2);assert.equal(plan.find(p=>p.targets.length).reason,'');
 t.sourceIds=[a.id,c.id];assert.ok(planLayout([a,b,c],[t]).every(p=>p.reason.includes('separate')));
 a.warnings=['Formula, figure or table content'];assert.match(planLayout([a],[{...t,sourceIds:[a.id]}])[0].reason,/Protected/);
});
test('new notes keep fingerprint, English quote and Chinese snapshot in v1 backups and Obsidian export',()=>{
 const id='a'.repeat(64);const note=createNote({page:1,sourceId:'p1-s1',quote:'Original.',translation:'原文。',fingerprint:id,text:'A question'});
 const doc={id,name:'My paper.pdf',pageCount:1,sources:{1:[source()]},translations:{1:[]},notes:[note]};
 const restored=importBackup(JSON.parse(exportBackup(doc)),doc);assert.equal(restored.notes[0].translation,'原文。');assert.equal(restored.notes[0].fingerprint,id);
 const out=markdown(doc,doc.notes);assert.match(out,/My%20paper.pdf#page=1/);assert.match(out,/\^reader-/);assert.match(out,/原文。/);
 const legacy=JSON.parse(exportBackup(doc));delete legacy.document.notes[0].fingerprint;delete legacy.document.notes[0].translation;assert.equal(importBackup(legacy,doc).notes[0].fingerprint,id);
});
test('translation budget is checked for the complete job before any provider call',async()=>{
 let calls=0;await assert.rejects(runTranslationJob({pages:[1,2],extract:async()=>[source('p1-s1','a'.repeat(80))],getExisting:()=>[],request:()=>{calls++;},onBatch:()=>{},onProgress:()=>{},endpoint:'https://example.com',limit:100}),/No text was sent/);assert.equal(calls,0);
 assert.equal(batches(Array.from({length:51},(_,i)=>source(`p1-s${i+1}`))).length,2);
 assert.throws(()=>batches([source('p1-s1','x'.repeat(4001))]),/batch limit/);
});
test('translation cache follows text and endpoint, skips existing edits, resumes without retransmission',async()=>{
 const cache={},saved=[];let calls=0;
 const options={pages:[1],extract:async()=>[source()],getExisting:()=>[],request:async rows=>{calls++;return rows.map(s=>({id:'t',sourceIds:[s.id],text:'一句可靠的话。',provenance:{kind:'machine',provider:'test'}}));},onBatch:async(page,entries)=>saved.push(...entries),onProgress:()=>{},endpoint:'https://example.com',cache};
 await runTranslationJob(options);await runTranslationJob(options);assert.equal(calls,1);assert.equal(saved[1].provenance.cached,true);
 await runTranslationJob({...options,getExisting:()=>[{sourceIds:['p1-s1'],text:'manual edit'}]});assert.equal(calls,1);
 await runTranslationJob({...options,endpoint:'https://different.example'});assert.equal(calls,2);
});
test('cancellation discards pending response and keeps already saved batches',async()=>{
 const control=new AbortController();let batchesSaved=0,requests=0;
 await assert.rejects(runTranslationJob({pages:[1,2],extract:async page=>[source(`p${page}-s1`)],getExisting:()=>[],onProgress:()=>{},onBatch:async()=>{batchesSaved++;},request:async rows=>{if(++requests===2)control.abort();return [{sourceIds:[rows[0].id],text:'译文'}];},endpoint:'https://example.com',signal:control.signal}),/abort/i);
 assert.equal(batchesSaved,1);
});
