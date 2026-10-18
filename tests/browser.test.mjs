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
  const origin = `http://127.0.0.1:${server.address().port}`;
  const appURL = origin + '/reader/';
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
  await t.test('highlights, annotation, editing and PDF text selection', async () => {
    await cdp.eval(`document.querySelector('.sentence-actions button').click()`);
    await until(() => cdp.eval(`document.querySelectorAll('.sentence-source.marked').length===1`));
    await cdp.eval(`document.querySelector('#note-text').value='A persistent research question.'; document.querySelector('#save-note').click()`);
    await until(() => cdp.eval(`document.querySelector('#notes-list').textContent.includes('A persistent research question.')`));
    await cdp.eval(`[...document.querySelectorAll('.note-card button')].find(b=>b.textContent==='Edit').click()`);
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
    await until(() => cdp.eval(`document.querySelector('#notes-list').textContent.includes('Edited insight') && document.querySelector('#sentences').textContent.includes('测试译文')`));
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
      const result = { translations: [{ text: '<img src=x onerror=alert(1)> 未审核的译文', sourceIds: [sent.sentences[0].id], confirmed: true }] };
      await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: origin }], body: Buffer.from(JSON.stringify(result)).toString('base64') });
    });
    await cdp.eval(`document.querySelector('#translation-consent').checked=true; document.querySelector('#translate-page').click()`);
    await until(() => cdp.eval(`document.querySelector('#translation-status').textContent.includes('Added 1 translations')`));
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
  assert.deepEqual(errors, [], 'No unhandled browser exceptions');
});
