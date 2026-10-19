import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { serve } from '../scripts/serve.mjs';
import { samplePDF } from '../src/sample.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await delay(70);
  }
  throw new Error('Timed out waiting for browser condition' + (lastError ? ': ' + lastError.message : ''));
}
class CDP {
  constructor(socket) { this.socket = socket; this.next = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const task = this.pending.get(message.id); this.pending.delete(message.id); if (message.error) task?.reject(new Error(message.error.message)); else task?.resolve(message.result); } else for (const fn of this.listeners.get(message.method) || []) fn(message.params); });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.next; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  on(event, callback) { const listeners = this.listeners.get(event) || []; listeners.push(callback); this.listeners.set(event, listeners); }
  async eval(expression) { const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (exceptionDetails) throw new Error(exceptionDetails.text + ': ' + (exceptionDetails.exception?.description || '')); return result.value; }
}

test('real browser: PDF, alignment, notes, privacy, export and responsive layout', { timeout: 120000 }, async t => {
  await mkdir('test-results', { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'parallel-browser-'));
  const downloads = await mkdtemp(path.join(os.tmpdir(), 'parallel-downloads-'));
  const server = serve(0, '/reader/');
  await new Promise(resolve => server.on('listening', resolve));
  const appURL = process.env.READER_URL || `http://127.0.0.1:${server.address().port}/reader/`;
  const origin = new URL(appURL).origin;
  const binary = process.env.CHROME_BIN || execFileSync('sh', ['-c', 'command -v chromium || command -v google-chrome || command -v chromium-browser'], { encoding: 'utf8' }).trim();
  const browser = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let cdp;
  t.after(async () => { if (cdp) { await writeFile('test-results/browser-state.json', JSON.stringify(await cdp.eval(`({status:document.querySelector('#status')?.textContent, text:document.body.innerText.slice(0,4000)})`), null, 2)); } cdp?.socket.close(); browser.kill('SIGTERM'); server.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await rm(downloads, { recursive: true, force: true }); });
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]));
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve));
  cdp = new CDP(socket);
  const errors = [], requests = [];
  let adapterMode = 'single', adapterRequests = 0;
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');
  cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  cdp.on('Network.requestWillBeSent', event => requests.push(event.request.url));
  cdp.on('Page.javascriptDialogOpening', () => cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'Edited insight' }));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: appURL });
  await until(() => cdp.eval(`document.querySelector('#library')?.textContent.includes('quiet desk')`));

  await t.test('landing page and genuine PDF.js rendering', async () => {
    const shot = await cdp.send('Page.captureScreenshot'); await writeFile('test-results/welcome.png', Buffer.from(shot.data, 'base64'));
    await cdp.eval(`document.querySelector('#demo').click()`);
    await until(() => cdp.eval(`document.querySelectorAll('.sentence-source').length > 3 && document.querySelectorAll('.textLayer span').length > 3 && document.querySelector('#status').textContent.includes('Paper opened')`));
    assert.equal(await cdp.eval(`document.querySelector('#page-count').textContent`), '/ 2');
    assert.ok(await cdp.eval(`(() => { const c=document.querySelector('canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let count=0; for(let i=0;i<d.length;i+=4) if(d[i]<100&&d[i+3]>0)count++; return count>500; })()`));
  });
  await t.test('bidirectional sentence selection and manual translation', async () => {
    await cdp.eval(`document.querySelector('.sentence-target').click()`);
    assert.equal(await cdp.eval(`document.querySelectorAll('.sentence-source.selected').length`), 1);
    await cdp.eval(`document.querySelector('.sentence-source.selected').click()`);
    assert.ok(await cdp.eval(`document.querySelectorAll('.sentence-target.selected').length > 0`));
    await cdp.eval(`document.querySelector('.sentence-source').click(); document.querySelector('#translation-settings').click(); document.querySelector('#manual-translation').value='测试译文：理解原文。'; document.querySelector('#add-translation').click()`);
    await until(() => cdp.eval(`document.querySelector('#sentences').textContent.includes('测试译文') && !document.querySelector('dialog').open`));
  });
  await t.test('Chinese selection highlights the actual PDF; clicking PDF returns to its translation', async () => {
    await cdp.eval(`document.querySelector('.sentence-target').click()`);
    await until(() => cdp.eval(`document.querySelectorAll('.pdf-linked-mark').length>0`));
    const point = await cdp.eval(`(() => {const r=document.querySelector('.pdf-linked-mark').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.eval(`window.getSelection().removeAllRanges()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    assert.ok(await cdp.eval(`document.querySelector('.sentence-target.selected')!==null`));
  });
  await t.test('highlights, annotation, editing and PDF text selection', async () => {
    await cdp.eval(`document.querySelector('.sentence-actions button').click()`);
    await until(() => cdp.eval(`document.querySelectorAll('.sentence-source.marked').length===1`));
    assert.ok(await cdp.eval(`document.querySelectorAll('.pdf-mark').length>0`), 'Sentence highlighting immediately marks the PDF');
    await cdp.eval(`document.querySelector('#note-text').value='A persistent research question.'; document.querySelector('#save-note').click()`);
    await until(() => cdp.eval(`document.querySelector('#notes-list').textContent.includes('A persistent research question.')`));
    await cdp.eval(`[...document.querySelectorAll('.note-card button')].find(b=>b.textContent==='Edit').click(); document.querySelector('#edit-text').value='Edited insight'; document.querySelector('#save-edit').click()`);
    await until(() => cdp.eval(`document.querySelector('#notes-list').textContent.includes('Edited insight')`));
    await cdp.eval(`(() => {const el=document.querySelector('.textLayer span'); const range=document.createRange(); range.selectNodeContents(el); const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range); document.querySelector('#highlight-selection').click();})()`);
    await until(() => cdp.eval(`document.querySelectorAll('.pdf-mark').length>0`));
    const shot = await cdp.send('Page.captureScreenshot'); await writeFile('test-results/reader.png', Buffer.from(shot.data, 'base64'));
  });
  await t.test('navigation and zoom render the selected page', async () => {
    await cdp.eval(`document.querySelector('#next').click()`);
    await until(() => cdp.eval(`document.querySelector('#sentences').textContent.includes('portable') && document.querySelector('#page-number').value==='2'`));
    assert.ok(await cdp.eval(`document.querySelector('#next').disabled`));
    await cdp.eval(`document.querySelector('#zoom-in').click()`);
    await until(() => cdp.eval(`document.querySelector('#zoom-value').textContent==='125%'`));
    await cdp.eval(`document.querySelector('#previous').click()`);
    await until(() => cdp.eval(`document.querySelector('#sentences').textContent.includes('测试译文')`));
  });
  await t.test('notes and bilingual links survive browser reload and PDF reopen', async () => {
    await cdp.send('Page.reload');
    await until(() => cdp.eval(`document.querySelector('#library')?.textContent.includes('Reading Across Languages')`));
    await cdp.eval(`document.querySelector('#demo').click()`);
    await until(() => cdp.eval(`document.querySelector('#notes-list').textContent.includes('Edited insight') && document.querySelector('#sentences').textContent.includes('测试译文')`)).catch(async error => { console.log('Reload diagnostics', await cdp.eval(`({notes:document.querySelector('#notes-list').textContent,translations:[...document.querySelectorAll('.sentence-target')].map(n=>n.textContent)})`)); throw error; });
    assert.ok(await cdp.eval(`document.querySelectorAll('.pdf-mark').length>0`));
    const records = await cdp.eval(`import('./src/storage.js').then(m=>m.storage('getAll')).then(d=>JSON.stringify(d))`);
    assert.ok(!records.includes('%PDF-'));
    assert.ok(!records.includes('endpoint'));
  });
  await t.test('Markdown download contains persisted annotations and bilingual content', async () => {
    await cdp.eval(`document.querySelector('#export').click()`);
    const filename = await until(async () => (await readdir(downloads)).find(n => n.endsWith('.md')));
    const content = await readFile(path.join(downloads, filename), 'utf8');
    assert.match(content, /Edited insight/); assert.match(content, /测试译文/); assert.match(content, /Page 1/);
  });
  await t.test('nothing leaves the origin before explicit translation consent', async () => {
    assert.deepEqual(requests.filter(url => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')), []);
    await cdp.eval(`document.querySelector('#translation-settings').click(); document.querySelector('#endpoint').value='https://adapter.example/translate'; document.querySelector('#translate-page').click()`);
    await until(() => cdp.eval(`document.querySelector('#status').textContent.includes('Consent is required')`));
    assert.ok(!requests.some(url => url.includes('adapter.example')));
  });
  await t.test('JSON import rejects fabricated links and leaves unaligned text uncertain', async () => {
    const document = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#translation-file' });
    const invalid = path.join(downloads, 'invalid.json');
    await writeFile(invalid, JSON.stringify([{ sourceIds: ['p99-s99'], text: 'Fabricated match' }]));
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [invalid] });
    await until(() => cdp.eval(`document.querySelector('#status').textContent.includes('unknown source sentence ID')`));
    assert.ok(!(await cdp.eval(`document.querySelector('#sentences').textContent.includes('Fabricated match')`)));
    const valid = path.join(downloads, 'translations.json');
    await writeFile(valid, JSON.stringify([{ sourceIds: [], text: '尚未对齐的译文', confirmed: true }]));
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [valid] });
    await until(() => cdp.eval(`document.querySelector('#translation-status').textContent.includes('Imported 1')`));
    await cdp.eval(`document.querySelector('dialog').close()`);
    assert.ok(await cdp.eval(`[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('尚未对齐')).textContent.includes('Unaligned')`));
    await cdp.eval(`[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('尚未对齐')).querySelector('.review-button').click()`);
    await until(() => cdp.eval(`document.querySelector('#status').textContent.includes('relink this translation first')`));
    await cdp.eval(`document.querySelector('.sentence-source').click(); [...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('尚未对齐')).querySelectorAll('.review-button')[1].click()`);
    await until(() => cdp.eval(`[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('尚未对齐')).textContent.includes('Unreviewed')`));
    await cdp.eval(`[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('尚未对齐')).querySelector('.review-button').click()`);
    await until(() => cdp.eval(`[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('尚未对齐')).textContent.includes('User-confirmed')`));
    await cdp.eval(`document.querySelector('#translation-settings').click()`);
  });
  await t.test('pluggable adapter sends only sentences and marks all links uncertain', async () => {
    let sent;
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://adapter.example/*' }] });
    cdp.on('Fetch.requestPaused', async event => {
      if (event.request.method === 'OPTIONS') {
        await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 204, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Methods', value: 'POST' }, { name: 'Access-Control-Allow-Headers', value: 'content-type' }] }); return;
      }
      sent = JSON.parse(event.request.postData);
      adapterRequests++;
      const result = { translations: adapterMode === 'all' ? sent.sentences.map(s=>({text:'测试服务译文：'+s.id,sourceIds:[s.id]})) : [{ text: '<img src=x onerror=alert(1)> 未审核的译文', sourceIds: [sent.sentences[0].id], confirmed: true }] };
      await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: origin }], body: Buffer.from(JSON.stringify(result)).toString('base64') });
    });
    await cdp.eval(`document.querySelector('#translation-consent').checked=true; document.querySelector('#translate-page').click()`);
    await until(() => cdp.eval(`document.querySelector('#translation-status').textContent.includes('Translation complete:')`));
    assert.deepEqual(Object.keys(sent).sort(), ['sentences', 'sourceLanguage', 'targetLanguage']);
    assert.deepEqual(Object.keys(sent.sentences[0]).sort(), ['id', 'text']);
    await cdp.eval(`document.querySelector('dialog').close()`);
    assert.equal(await cdp.eval(`document.querySelectorAll('#sentences img').length`), 0);
    assert.ok(await cdp.eval(`[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('未审核')).textContent.includes('Unreviewed')`));
    await cdp.send('Fetch.disable');
  });
  await t.test('responsive layout, search and delete', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(600);
    assert.ok(await cdp.eval(`document.documentElement.scrollWidth <= window.innerWidth`));
    await cdp.eval(`document.querySelector('#search').value='测试译文'; document.querySelector('#search').dispatchEvent(new Event('input'))`);
    assert.equal(await cdp.eval(`document.querySelectorAll('.sentence-source').length`), 1);
    await cdp.eval(`document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input'))`);
    const before = await cdp.eval(`document.querySelectorAll('.note-card').length`);
    await cdp.eval(`document.querySelector('.note-card .danger').click()`);
    await until(() => cdp.eval(`document.querySelectorAll('.note-card').length===${before - 1}`));
    const shot = await cdp.send('Page.captureScreenshot', { captureBeyondViewport: false }); await writeFile('test-results/mobile.png', Buffer.from(shot.data, 'base64'));
  });
  await t.test('PDF view and text view work; invalid upload preserves the current paper', async () => {
    await cdp.eval(`document.querySelector('button[data-view="text"]').click()`);
    assert.equal(await cdp.eval(`getComputedStyle(document.querySelector('#pdf-pane')).display`), 'none');
    await cdp.eval(`document.querySelector('button[data-view="pdf"]').click()`);
    assert.equal(await cdp.eval(`getComputedStyle(document.querySelector('#bilingual-pane')).display`), 'none');
    await cdp.eval(`document.querySelector('button[data-view="split"]').click()`);
    const document = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#file-input' });
    const invalid = path.join(downloads, 'invalid.pdf'); await writeFile(invalid, 'Not a PDF');
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [invalid] });
    await until(() => cdp.eval(`document.querySelector('#status').textContent.includes('does not appear to be a PDF')`));
    assert.equal(await cdp.eval(`document.querySelector('#document-name').textContent`), 'Reading Across Languages.pdf');
    const valid = path.join(downloads, 'uploaded.pdf'); await writeFile(valid, samplePDF());
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [valid] });
    await until(() => cdp.eval(`document.querySelector('#status').textContent.includes('Paper opened')`));
    assert.ok(await cdp.eval(`document.querySelector('#notes-list').textContent.includes('Edited insight')`));
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  await t.test('Mirror has equal paper geometry, instant reversible hover and locked selection', async () => {
    await cdp.eval(`document.querySelector('button[data-view="split"]').click()`);
    await until(() => cdp.eval(`document.querySelector('#mirror-page').offsetWidth>0 && document.querySelector('#mirror-content .mirror-target')!==null`)).catch(async e=>{console.log('Mirror diagnostics',await cdp.eval(`({status:document.querySelector('#mirror-status').textContent,reasons:[...document.querySelectorAll('.continuation-label')].map(n=>n.textContent)})`));throw e;});
    const dimensions = await cdp.eval(`['#pdf-page','#mirror-page'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.width,r.height]})`);
    assert.deepEqual(dimensions[0],dimensions[1]);
    await cdp.eval(`window.getSelection().removeAllRanges();document.querySelector('#clear-selection').click();document.querySelector('#pdf-scroll').scrollTop=0;document.querySelector('#mirror-scroll').scrollTop=0`);
    const point=await cdp.eval(`(()=>{const el=document.querySelector('#mirror-content .mirror-target');el.scrollIntoView({block:'center'});const r=el.getClientRects()[0];return {x:r.x+5,y:r.y+r.height/2,id:el.dataset.targetId};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
    await until(()=>cdp.eval(`document.querySelectorAll('#pdf-highlights .pdf-hover-mark').length>0`));
    assert.equal(await cdp.eval(`document.querySelectorAll('#pdf-highlights .pdf-linked-mark').length`),0);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:point.x,y:point.y});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x,y:point.y});
    await until(()=>cdp.eval(`document.querySelectorAll('#pdf-highlights .pdf-linked-mark').length>0`));
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10});
    await until(()=>cdp.eval(`document.querySelectorAll('.pdf-hover-mark').length===0`));
    assert.ok(await cdp.eval(`document.querySelectorAll('#pdf-highlights .pdf-linked-mark').length>0`));
    const pdfPoint=await cdp.eval(`(()=>{const r=document.querySelector('#pdf-highlights .pdf-linked-mark').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...pdfPoint});
    await until(()=>cdp.eval(`document.querySelectorAll('#mirror-content .mirror-target.hovered').length>0`));
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10});
    const before=await cdp.eval(`document.querySelector('#selection-label').textContent`);
    await cdp.eval(`document.querySelector('button[data-view="text"]').click()`);
    await until(()=>cdp.eval(`document.querySelector('#sentences').checkVisibility()`));
    assert.equal(await cdp.eval(`document.querySelector('#selection-label').textContent`),before);
    assert.ok(await cdp.eval(`document.querySelector('.sentence-target.selected')!==null`));
    await cdp.eval(`document.querySelector('button[data-view="split"]').click()`);
    await until(()=>cdp.eval(`document.querySelector('#mirror-scroll').checkVisibility()`));
  });
  await t.test('annotation removal, Ctrl+Z and Ctrl+Shift+Z survive page navigation',async()=>{
    await cdp.eval(`document.querySelector('.sentence-source').click();document.querySelector('#note-text').value='Undo across pages';document.querySelector('#save-note').click()`);
    await until(()=>cdp.eval(`document.querySelector('#notes-list').textContent.includes('Undo across pages')`));
    await cdp.eval(`document.querySelector('#next').click()`);
    await until(()=>cdp.eval(`document.querySelector('.sentence-source')?.dataset.sourceId.startsWith('p2-')`));
    await cdp.eval(`document.activeElement.blur()`);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:2});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:2});
    await until(()=>cdp.eval(`!document.querySelector('#notes-list').textContent.includes('Undo across pages')`));
    assert.equal(await cdp.eval(`document.querySelector('#page-number').value`),'2');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Z',code:'KeyZ',modifiers:10});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Z',code:'KeyZ',modifiers:10});
    await until(()=>cdp.eval(`document.querySelector('#notes-list').textContent.includes('Undo across pages')`));
    await cdp.eval(`[...document.querySelectorAll('.note-card')].find(n=>n.textContent.includes('Undo across pages')).querySelector('.danger').click()`);
    await until(()=>cdp.eval(`!document.querySelector('#notes-list').textContent.includes('Undo across pages')`));
    await cdp.eval(`document.querySelector('#undo').click()`);
    await until(()=>cdp.eval(`document.querySelector('#notes-list').textContent.includes('Undo across pages')`));
    await cdp.eval(`document.querySelector('#previous').click()`);
    await until(()=>cdp.eval(`document.querySelector('.sentence-source')?.dataset.sourceId.startsWith('p1-')`));
  });
  await t.test('direct translation editor and Undo preserve source notes and alignment',async()=>{
    await cdp.eval(`document.querySelector('.sentence-target').click();document.querySelector('#edit-selected-translation').click()`);
    await until(()=>cdp.eval(`document.querySelector('#edit-dialog').open`));
    const before=await cdp.eval(`({text:document.querySelector('#edit-text').value,ids:document.querySelector('#edit-source-ids').value,notes:document.querySelectorAll('.note-card').length})`);
    await cdp.eval(`document.querySelector('#edit-text').value='经过人工修改的译文。';document.querySelector('#edit-source-ids').value='p1-s2';document.querySelector('#edit-verified').checked=false;document.querySelector('#save-edit').click()`);
    await until(()=>cdp.eval(`!document.querySelector('#edit-dialog').open && document.querySelector('#sentences').textContent.includes('经过人工修改')`));
    assert.equal(await cdp.eval(`document.querySelectorAll('.note-card').length`),before.notes);
    await cdp.eval(`document.querySelector('#undo').click()`);
    await until(()=>cdp.eval(`!document.querySelector('#sentences').textContent.includes('经过人工修改')`));
    assert.ok(await cdp.eval(`document.querySelector('#sentences').textContent.includes(${JSON.stringify(before.text)})`));
  });
  await t.test('overflow uses a readable continuation, and translated text remains independently selectable',async()=>{
    await cdp.eval(`document.querySelector('.sentence-source').click();document.querySelector('#translation-settings').click();document.querySelector('#manual-translation').value='这段译文需要保留清晰的字号，不应挤进原来狭小的区域。'.repeat(50);document.querySelector('#add-translation').click()`);
    await until(()=>cdp.eval(`document.querySelector('#mirror-continuation').textContent.includes('这段译文需要')`));
    assert.ok(await cdp.eval(`(()=>{const e=[...document.querySelectorAll('#mirror-continuation .mirror-target')].find(e=>e.textContent.includes('这段译文'));return e.textContent.length>1000&&parseFloat(getComputedStyle(e).fontSize)>=16;})()`));
    const selection=await cdp.eval(`(()=>{const e=document.querySelector('#mirror-content .mirror-target');const range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return {text:selection.toString(),inOriginal:document.querySelector('#text-layer').contains(selection.anchorNode)};})()`);
    assert.ok(selection.text.length>0);assert.equal(selection.inOriginal,false);
    await cdp.eval(`getSelection().removeAllRanges();document.querySelector('#undo').click()`);
    await until(()=>cdp.eval(`!document.querySelector('#mirror-continuation').textContent.includes('这段译文需要')`));
    await cdp.eval(`document.querySelector('#pdf-scroll').scrollTop=100`);
    await delay(100);
    assert.ok(await cdp.eval(`Math.abs(document.querySelector('#pdf-scroll').scrollTop-document.querySelector('#mirror-scroll').scrollTop)<2`));
  });
  await t.test('whole-paper translation enforces consent and budget, reports progress, resumes from cache',async()=>{
    adapterMode='all';await cdp.send('Fetch.enable',{patterns:[{urlPattern:'https://adapter.example/*'}]});
    const before=adapterRequests;
    await cdp.eval(`document.querySelector('#translation-settings').click();document.querySelector('#endpoint').value='https://adapter.example/translate';document.querySelector('#translation-consent').checked=false;document.querySelector('#translate-paper').click()`);
    await until(()=>cdp.eval(`document.querySelector('#status').textContent.includes('Consent is required')`));assert.equal(adapterRequests,before);
    await cdp.eval(`document.querySelector('#translation-consent').checked=true;document.querySelector('#translation-limit').value='100';document.querySelector('#translate-paper').click()`);
    await until(()=>cdp.eval(`document.querySelector('#translation-status').textContent.includes('No text was sent') && !document.querySelector('#translate-paper').disabled`));assert.equal(adapterRequests,before);
    const page=await cdp.eval(`document.querySelector('#page-number').value`);
    await cdp.eval(`document.querySelector('#translation-limit').value='20000';document.querySelector('#translate-paper').click()`);
    await until(()=>cdp.eval(`document.querySelector('#translation-status').textContent.includes('Translation complete: 2 pages') && !document.querySelector('#translate-paper').disabled`));
    assert.equal(await cdp.eval(`document.querySelector('#page-number').value`),page);
    assert.equal(await cdp.eval(`document.querySelector('#translation-progress').value`),2);
    assert.ok(await cdp.eval(`document.querySelector('#sentences').textContent.includes('测试译文')`),'Manual text is never overwritten');
    const after=adapterRequests;assert.ok(after>before);
    await cdp.eval(`document.querySelector('#translate-paper').click()`);
    await until(()=>cdp.eval(`document.querySelector('#translation-status').textContent.includes('0 characters sent') && !document.querySelector('#translate-paper').disabled`));assert.equal(adapterRequests,after);
    await cdp.eval(`document.querySelector('#translation-dialog').close();[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('测试服务译文')).querySelectorAll('.review-button')[4].click()`);
    await delay(100);
    await cdp.eval(`document.querySelector('#translation-settings').click();document.querySelector('#translate-paper').click()`);
    await until(()=>cdp.eval(`document.querySelector('#translation-status').textContent.includes('0 characters sent') && !document.querySelector('#translate-paper').disabled`));assert.equal(adapterRequests,after);
    await cdp.eval(`document.querySelector('#translation-dialog').close()`);await cdp.send('Fetch.disable');adapterMode='single';
  });
  await t.test('versioned JSON backup restores notes with source verification', async () => {
    await cdp.eval(`document.querySelector('#export-json').click()`);
    const name = await until(async () => (await readdir(downloads)).find(n => n.endsWith('.reader.json')));
    const backup = JSON.parse(await readFile(path.join(downloads, name), 'utf8'));
    assert.equal(backup.schema, 'parallel-notes'); assert.equal(backup.document.id.length, 64);
    assert.ok(!JSON.stringify(backup).includes('%PDF-'));
    const before = await cdp.eval(`document.querySelectorAll('.note-card').length`);
    const dom = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#backup-file' });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.join(downloads, name)] });
    await until(() => cdp.eval(`document.querySelector('#status').textContent.includes('Backup restored')`));
    assert.equal(await cdp.eval(`document.querySelectorAll('.note-card').length`), before * 2);
    const bad = path.join(downloads, 'bad-backup.json'); backup.document.id = 'wrong'; await writeFile(bad, JSON.stringify(backup));
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [bad] });
    await until(() => cdp.eval(`document.querySelector('#status').textContent.includes('fingerprint does not match')`));
    assert.equal(await cdp.eval(`document.querySelectorAll('.note-card').length`), before * 2);
  });
  await t.test('session-only reading does not persist a new note', async () => {
    await cdp.eval(`document.querySelector('#persist-notes').checked=false; document.querySelector('#persist-notes').dispatchEvent(new Event('change'))`);
    await cdp.eval(`document.querySelector('#note-text').value='session-only sentinel'; document.querySelector('#save-note').click()`);
    await until(() => cdp.eval(`document.querySelector('#notes-list').textContent.includes('session-only sentinel')`));
    assert.match(await cdp.eval(`document.querySelector('#status').textContent`), /kept for this session/);
    const records = await cdp.eval(`import('./src/storage.js').then(m=>m.storage('getAll')).then(d=>JSON.stringify(d))`);
    assert.ok(!records.includes('session-only sentinel'));
    await cdp.eval(`document.querySelector('#persist-notes').checked=true; document.querySelector('#persist-notes').dispatchEvent(new Event('change'))`);
  });
  if (process.env.REAL_PAPERS_DIR) {
    const corpus = JSON.parse(await readFile(new URL('./papers.json', import.meta.url), 'utf8'));
    const report = [];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
    for (const paper of corpus) await t.test(`real academic paper: ${paper.name}`, async () => {
      const dom = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#file-input' });
      // CDP file uploads require absolute paths, including on Windows runners.
      const filename = path.resolve(process.env.REAL_PAPERS_DIR, paper.file);
      const original = await readFile(filename);
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filename] });
      await until(() => cdp.eval(`document.querySelector('#document-name').textContent===${JSON.stringify(paper.file)} && document.querySelector('#status').textContent.includes('Paper opened')`));
      assert.equal(await cdp.eval(`document.querySelector('#page-count').textContent`), `/ ${paper.pages}`);
      for (const page of paper.checkPages) {
        await cdp.eval(`document.querySelector('#page-number').value=${page};document.querySelector('#page-number').dispatchEvent(new Event('change'))`);
        await until(() => cdp.eval(`document.querySelector('.sentence-source')?.dataset.sourceId.startsWith('p${page}-') && document.querySelectorAll('.textLayer span').length>5`));
        const metrics = await until(() => cdp.eval(`import('./src/storage.js').then(m=>m.storage('getAll')).then(records=>{const d=records.find(d=>d.name===${JSON.stringify(paper.file)});const s=d?.sources[${page}];return s?{page:${page},sentences:s.length,columns:[...new Set(s.map(x=>x.column).filter(x=>x>=0))].length,warningCount:s.filter(x=>x.warnings?.length).length,encodingWarnings:s.filter(x=>x.warnings?.some(w=>w.startsWith('Unreliable'))).length,allAnchored:s.every(x=>x.rects.length>0),formulas:s.filter(x=>x.warnings?.some(w=>w.startsWith('Formula'))).length}:null;})`));
        const current = metrics;
        assert.ok(typeof current === 'object', 'Current page metrics committed');
        assert.ok(current.sentences > 5); assert.ok(current.warningCount >= 1); assert.ok(current.allAnchored);
        report.push({ paper: paper.file, ...current });
        if (paper.file === 'tracemonkey.pdf' && page === 4) assert.equal(current.columns, 2);
        if (paper.file === 'tracemonkey.pdf' && page === 8) assert.ok(current.formulas > 0);
        if (paper.file === 'tam-review.pdf' && page === 2) assert.ok(current.encodingWarnings > 0, 'Corrupt character mapping must not pass silently');
        if (paper.file === 'tracemonkey.pdf' && page === 4) {
          const reference = await cdp.eval(`import('./src/storage.js').then(m=>m.storage('getAll')).then(r=>{const s=r.find(d=>d.name==='tracemonkey.pdf').sources[4];const target=s.find(x=>x.text.startsWith('A trace records'));return {id:target?.id,text:target?.text,column:target?.column,ordered:s.findIndex(x=>x.id===target?.id)>s.findLastIndex(x=>x.column===0)}})`);
          assert.equal(reference.text, 'A trace records all its intermediate values in a small activation record area.');
          assert.equal(reference.column, 1); assert.ok(reference.ordered, 'Left column must finish before right column starts');
          await cdp.eval(`document.querySelector('[data-source-id="${reference.id}"]').click();document.querySelector('#translation-settings').click();document.querySelector('#manual-translation').value='跟踪会将其所有中间值记录在一个小型活动记录区域中。';document.querySelector('#add-translation').click()`);
          await until(() => cdp.eval(`!document.querySelector('dialog').open && document.querySelector('#sentences').textContent.includes('跟踪会将')`));
          await cdp.eval(`[...document.querySelectorAll('.sentence-target')].find(t=>t.textContent.startsWith('跟踪会将')).click()`);
          assert.ok(await cdp.eval(`(() => {const page=document.querySelector('#pdf-page').getBoundingClientRect();return [...document.querySelectorAll('.pdf-linked-mark')].every(e=>e.getBoundingClientRect().left>page.left+page.width/2)})()`), 'Chinese sentence must highlight only the actual right-column source');
          // Complete one representative right-column paragraph before scaling.
          // These are reviewed test translations of a short excerpt, not provider output.
          const paragraph = await cdp.eval(`import('./src/storage.js').then(m=>m.storage('getAll')).then(r=>{const sources=r.find(d=>d.name==='tracemonkey.pdf').sources[4];return ['To make variable accesses','Thus, the trace can read','When the trace exits'].map(prefix=>sources.filter(s=>s.text.startsWith(prefix)).map(s=>s.id));})`);
          assert.ok(paragraph.every(ids=>ids.length===1), 'Each reviewed excerpt has exactly one actual source sentence');
          const chinese=['为加快跟踪中的变量访问，系统会将局部变量和全局变量拆箱，复制到该活动记录区中。','因此，跟踪可以通过简单的加载和存储操作读写这些变量，无需依赖解释器使用的装箱机制。','退出跟踪时，虚拟机会将这些原生存储中的值重新装箱，并复制回解释器的数据结构。'];
          const file=path.join(downloads,'representative-links.json');await writeFile(file,JSON.stringify(paragraph.map((ids,i)=>({sourceIds:ids,text:chinese[i]}))));
          await cdp.eval(`document.querySelector('#translation-settings').click()`);
          const dom=await cdp.send('DOM.getDocument');const input=await cdp.send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#translation-file'});
          await cdp.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[file]});
          await until(()=>cdp.eval(`document.querySelector('#sentences').textContent.includes('为加快跟踪')`));
          await cdp.eval(`document.querySelector('#translation-dialog').close()`);
          await until(()=>cdp.eval(`document.querySelector('#mirror-content').textContent.includes('为加快跟踪')`));
          assert.ok(await cdp.eval(`(()=>{const p=document.querySelector('#mirror-page').getBoundingClientRect();const e=[...document.querySelectorAll('#mirror-content .mirror-target')].find(e=>e.textContent.startsWith('跟踪会将'));const r=e.getBoundingClientRect();return r.left>p.left+p.width/2&&r.top>=p.top&&parseFloat(getComputedStyle(e).fontSize)>=12;})()`),'Reviewed paragraph must actually fit on the Chinese paper in the right column');
          const retained=await cdp.eval(`(()=>{const a=document.querySelector('#pdf-canvas'),b=document.querySelector('#mirror-canvas');const left=a.getContext('2d').getImageData(0,0,a.width,a.height).data,right=b.getContext('2d').getImageData(0,0,b.width,b.height).data;let changedLeft=0,changedRight=0;for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const i=(y*a.width+x)*4;if(left[i]!==right[i]||left[i+1]!==right[i+1]||left[i+2]!==right[i+2]){if(x<a.width/2)changedLeft++;else changedRight++;}}return{changedLeft,changedRight};})()`);
          assert.equal(retained.changedLeft,0,'Other column pixels remain exactly unchanged');assert.ok(retained.changedRight>0,'Source glyphs are actually replaced, not just a duplicate screenshot');
          await cdp.eval(`document.querySelector('button[data-view="text"]').click()`);
          await until(()=>cdp.eval(`document.querySelector('#sentences').checkVisibility()&&document.querySelector('#sentences').textContent.includes('为加快跟踪')`));
          assert.equal(await cdp.eval(`document.querySelector('#page-number').value`),'4');
          await cdp.eval(`document.querySelector('button[data-view="split"]').click()`);
          await until(()=>cdp.eval(`document.querySelector('#mirror-content').textContent.includes('为加快跟踪')`));
        }
        if (paper.file === 'tracemonkey.pdf' && page === 8) {
          const formulaId=await cdp.eval(`import('./src/storage.js').then(m=>m.storage('getAll')).then(r=>r.find(d=>d.name==='tracemonkey.pdf').sources[8].find(s=>s.warnings.some(w=>w.startsWith('Formula'))).id)`);
          await cdp.eval(`document.querySelector('#sentences [data-source-id="${formulaId}"]').click();document.querySelector('#translation-settings').click();document.querySelector('#manual-translation').value='公式区域测试注释：请以原始公式为准。';document.querySelector('#add-translation').click()`);
          await until(()=>cdp.eval(`document.querySelector('#mirror-continuation').textContent.includes('公式区域测试')`));
          assert.ok(await cdp.eval(`document.querySelector('#mirror-continuation').textContent.includes('Protected')`));
          assert.ok(await cdp.eval(`document.querySelector('#pdf-canvas').toDataURL()===document.querySelector('#mirror-canvas').toDataURL()`),'Protected formula/figure canvas is an unchanged copy of the source');
        }
        if (paper.file === 'tracemonkey.pdf' && page === 5) {
          const boundary = await cdp.eval(`import('./src/storage.js').then(m=>m.storage('getAll')).then(r=>{const d=r.find(d=>d.name==='tracemonkey.pdf');return {before:d.sources[4].find(s=>s.text.includes('objects')&&s.text.endsWith('rep-')),after:d.sources[5].find(s=>s.text.startsWith('resentations are assigned'))}})`);
          assert.ok(boundary.before && boundary.after, 'Real cross-page sentence fragments remain inspectable');
          assert.ok(boundary.before.warnings.length && boundary.after.warnings.length);
          assert.ok(!await cdp.eval(`document.querySelector('#sentences').textContent.includes('对象的表示形式')`), 'No automatic fabricated cross-page match');
          const links = [{ sourceIds: [boundary.before.id, boundary.after.id], text: '在 TraceMonkey 中，对象的表示形式会被赋予一个称为对象形状的整数键。' }];
          const file = path.join(downloads, 'reviewed-boundary.json'); await writeFile(file, JSON.stringify(links));
          await cdp.eval(`document.querySelector('#translation-settings').click()`);
          const dom = await cdp.send('DOM.getDocument');
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#translation-file' });
          await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
          await until(() => cdp.eval(`document.querySelector('#sentences').textContent.includes('对象的表示形式')`));
          await cdp.eval(`document.querySelector('dialog').close(); [...document.querySelectorAll('.sentence-target')].find(t=>t.textContent.includes('对象的表示形式')).click()`);
          assert.ok(await cdp.eval(`[...document.querySelectorAll('.translation-card')].find(c=>c.textContent.includes('对象的表示形式')).textContent.includes('Unreviewed')`));
          assert.ok(await cdp.eval(`document.querySelectorAll('.pdf-linked-mark').length>0`));
          await cdp.eval(`document.querySelector('#page-number').value=4;document.querySelector('#page-number').dispatchEvent(new Event('change'))`);
          await until(() => cdp.eval(`document.querySelector('.sentence-source')?.dataset.sourceId.startsWith('p4-') && document.querySelector('#sentences').textContent.includes('对象的表示形式')`));
          await cdp.eval(`document.querySelector('#page-number').value=5;document.querySelector('#page-number').dispatchEvent(new Event('change'))`);
          await until(() => cdp.eval(`document.querySelector('.sentence-source')?.dataset.sourceId.startsWith('p5-')`));
        }
        await cdp.eval(`document.querySelector('.sentence-source').click()`);
        await until(() => cdp.eval(`document.querySelectorAll('.pdf-linked-mark').length>0`));
        const shot = await cdp.send('Page.captureScreenshot'); await writeFile(`test-results/${paper.file}-page-${page}.png`, Buffer.from(shot.data, 'base64'));
      }
      assert.deepEqual(await readFile(filename), original, 'Source PDF bytes must remain unchanged');
    });
    await writeFile('test-results/corpus-report.json', JSON.stringify(report, null, 2));
  }
  assert.deepEqual(errors, [], 'No unhandled browser exceptions');
});
