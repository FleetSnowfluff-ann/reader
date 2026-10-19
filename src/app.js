import { History } from './history.js';
import { renderMirror, mirrorMarks } from './mirror.js';
import { PDFReader } from './pdf.js';
import { allSources, pageTranslations, hitTest, correctLink } from './alignment.js';
import { requestTranslation } from './translation.js';
import { runTranslationJob } from './translation-job.js';
import { challengeToken } from './challenge.js';
import { service } from './config.js';
import { createNote, exportBackup, importBackup } from './annotations.js';
import { recoverSourceAnchors } from './extraction.js';
import { validateTranslations, linkedIds, markdown } from './core.js';
import { storage } from './storage.js';
import { samplePDF } from './sample.js';

const sessionDocuments = new Map();
const histories = new Map();
let editor = null;
let persistent = true;
const $ = selector => document.querySelector(selector);
const state = { pdf: null, doc: null, page: 1, zoom: 1, selected: null, quote: '', render: null, generation: 0, opening: 0, translationRequest: null, engine: null, activeSourceIds: [], hoveredIds: [], hoveredTargets: [], targetId: null, renderedPage: null, viewScrolls: {} };
let toastTimer;
function status(message, error = false) {
  clearTimeout(toastTimer);
  $('#status').textContent = message;
  $('#status').classList.add('visible');
  $('#status').setAttribute('role', error ? 'alert' : 'status');
  toastTimer = setTimeout(() => $('#status').classList.remove('visible'), error ? 14000 : 5000);
}
function on(selector, event, handler) {
  $(selector).addEventListener(event, async e => {
    try { await handler(e); } catch (error) { console.error(error); status(error.message || 'Something went wrong.', true); }
  });
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, className, action) {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', async () => {
    try { await action(); } catch (error) { status(error.message, true); }
  });
  return element;
}
let writes = Promise.resolve();
async function save() {
  const snapshot = structuredClone(state.doc);
  sessionDocuments.set(snapshot.id, snapshot);
  if (!persistent) { $('#document-meta').textContent = 'Session only · Export before closing this tab'; return; }
  writes = writes.catch(() => {}).then(() => storage('put', snapshot));
  try { await writes; $('#document-meta').textContent = 'Saved on this device · PDF is not stored'; }
  catch { $('#document-meta').textContent = 'Not saved — export your notes now'; throw new Error('Browser storage is unavailable or full. Export your notes before leaving.'); }
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = node('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const sources = () => state.doc?.sources?.[state.page] || [];
const translations = () => state.doc ? pageTranslations(state.doc, state.page) : [];
const addTranslations = entries => state.doc.translations[state.page].push(...entries);

async function refreshLibrary() {
  let saved = [];
  if (persistent) { try { saved = await storage('getAll'); } catch { status('Browser storage unavailable. Use session mode and export your work.', true); } }
  const documents = [...new Map([...saved, ...sessionDocuments.values()].map(d => [d.id, d])).values()];
  $('#library').replaceChildren();
  if (!documents.length) $('#library').append(node('p', 'library-empty', 'A quiet desk, ready for your first paper. 你的阅读旅程从这里开始。'));
  for (const doc of documents.sort((a, b) => b.updated - a.updated)) {
    const item = node('div', 'library-item');
    const open = button(doc.name, '', () => doc.sample ? openPDF(samplePDF(), doc.name, true) : (status('Choose the same PDF to restore its notes and translations.'), $('#file-input').click()));
    open.append(node('small', '', `${doc.notes.length} annotations · page ${doc.lastPage || 1} · ${doc.sample ? 'Sample paper' : 'Reopen the original PDF to continue'}`));
    const remove = button('Forget', 'danger', async () => {
      if (!confirm(`Delete local notes and translations for “${doc.name}”? Export anything you want to keep first.`)) return;
      await storage('delete', doc.id); sessionDocuments.delete(doc.id); await refreshLibrary();
    });
    remove.setAttribute('aria-label', `Forget ${doc.name}`);
    item.append(open, remove); $('#library').append(item);
  }
}

async function openPDF(bytes, name, sample = false) {
  if (bytes.length > 100 * 1024 * 1024) throw new Error('Please choose a PDF smaller than 100 MB.');
  if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF-')) throw new Error('This file does not appear to be a PDF.');
  const opening = ++state.opening;
  status('Opening your paper…');
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
  await writes.catch(() => {});
  let existing = sessionDocuments.get(id);
  if (!existing && persistent) { try { existing = await storage('get', id); } catch { persistent = false; $('#persist-notes').checked = false; status('Storage unavailable; using session mode. Export before closing.', true); } }
  const engine = new PDFReader();
  const pdf = await engine.open(bytes, incorrect => prompt(incorrect ? 'Incorrect PDF password. Try again (not stored):' : 'PDF password (not stored):'));
  if (opening !== state.opening) { await pdf.destroy(); return; }
  state.translationRequest?.abort();
  state.generation++;
  if (state.engine) await state.engine.destroy();
  state.engine = engine;
  state.pdf = pdf;
  state.doc = existing || { id, name, sample, notes: [], sources: {}, translations: {}, lastPage: 1, updated: Date.now() };
  state.doc.pageCount = pdf.numPages;
  for (const note of state.doc.notes) { note.fingerprint ||= id; note.sourceIds ||= note.sourceId ? [note.sourceId] : []; }
  state.page = Math.min(state.doc.lastPage || 1, pdf.numPages);
  state.zoom = 1; state.selected = null; state.quote = ''; state.activeSourceIds = []; state.hoveredIds = []; state.targetId = null; state.renderedPage = null; state.viewScrolls = {};
  if (!histories.has(id)) histories.set(id, new History());
  $('#search').value = ''; $('#note-text').value = '';
  $('#welcome').hidden = true; $('#reader').hidden = false;
  $('#document-name').textContent = state.doc.name;
  $('#page-count').textContent = `/ ${pdf.numPages}`;
  $('#page-number').max = pdf.numPages;
  await renderPage();
  status('Paper opened. Your PDF stays on this device.');
}

async function renderPage() {
  const generation = ++state.generation;
  const doc = state.doc, pageNumber = state.page;
  const extracted = await state.engine.extract(pageNumber);
  if (generation !== state.generation) return;
  const old = doc.sources[pageNumber];
  if (old && JSON.stringify(old.map(s => [s.id, s.text])) !== JSON.stringify(extracted.sources.map(s => [s.id, s.text]))) {
    doc.sources[pageNumber] = recoverSourceAnchors(old, extracted.content.items, extracted.page.getViewport({ scale: 1 }));
    extracted.warnings.push('Saved sentence IDs retained. Unresolved anchors are flagged, not reassigned.');
  } else doc.sources[pageNumber] = extracted.sources;
  $('#layout-status').textContent = extracted.warnings.join(' ');
  doc.translations[pageNumber] ||= [];
  doc.seededPages ||= {};
  if (doc.sample && !doc.seededPages[pageNumber]) {
    doc.seededPages[pageNumber] = true;
    const pairs = [
      ['Reading in another language is an act of interpretation.', '用另一种语言阅读，本身就是一种诠释。'],
      ['A bilingual workspace brings the original and its translation together.', '双语工作区将原文与译文呈现在一起。'],
      ['Sentence links help readers move between two perspectives.', '句子之间的链接帮助读者在两种视角间切换。'],
      ['A good annotation connects a claim to a question.', '好的批注将一个论点与一个问题联系起来。'],
      ['Local storage lets readers return to their observations.', '本地存储让读者能够随时回顾自己的思考。'],
    ];
    for (const [english, chinese] of pairs) {
      const source = doc.sources[pageNumber].find(s => s.text === english);
      if (source) doc.translations[pageNumber].push({ id: crypto.randomUUID(), sourceIds: [source.id], text: chinese, confirmed: true });
    }
  }
  doc.lastPage = pageNumber; doc.updated = Date.now();
  $('#page-number').value = pageNumber;
  $('#previous').disabled = pageNumber <= 1; $('#next').disabled = pageNumber >= state.pdf.numPages;
  $('#zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
  const ready = await state.engine.render(extracted, { canvas: $('#pdf-canvas'), container: $('#pdf-page'), textContainer: $('#text-layer'), availableWidth: Math.max(520, Math.min($('#pdf-scroll').clientWidth || 760, $('.workspace').dataset.view === 'split' ? $('#mirror-scroll').clientWidth || 760 : 760) - 36), zoom: state.zoom });
  if (!ready || generation !== state.generation) return;
  for (const source of sources()) source.rects = state.engine.exactRectangles(source, $('#pdf-page'));
  state.renderedPage = pageNumber;
  renderSentences(); renderNotes(); renderHighlights(); updateAnchor(); updateHistory();
  await save();
}

function updateAnchor() {
  $('#selection-label').textContent = state.activeSourceIds.length ? `Locked · ${state.activeSourceIds.join(' + ')}` : 'Hover to compare · Click to lock a sentence';
  $('#note-anchor').textContent = state.quote ? `Page ${state.page} · “${state.quote}”` : `Page ${state.page} note · Select a sentence to attach a quote`;
}
async function selectSentence(id, side) {
  const related = linkedIds(Object.values(state.doc.translations).flat(), id, side);
  const sourceIds = side === 'source' ? [id] : related;
  const targetIds = side === 'target' ? [id] : related;
  if (side === 'target' && sourceIds.length && !sourceIds.some(id => id.startsWith(`p${state.page}-`))) await goPage(allSources(state.doc).find(s => s.id === sourceIds[0]).page);
  state.activeSourceIds = sourceIds; state.targetId = side === 'target' ? id : targetIds[0] || null; state.hoveredIds = []; state.hoveredTargets = [];
  state.selected = sourceIds.length === 1 ? sourceIds[0] : null;
  state.quote = allSources(state.doc).filter(s => sourceIds.includes(s.id)).map(s => s.text).join(' ');
  document.querySelectorAll('[data-source-id]').forEach(element => element.classList.toggle('selected', sourceIds.includes(element.dataset.sourceId)));
  document.querySelectorAll('[data-target-id]').forEach(element => element.classList.toggle('selected', targetIds.includes(element.dataset.targetId)));
  updateAnchor(); renderHighlights();
  const separate = targetIds.some(id => [...$('#mirror-continuation').querySelectorAll('[data-target-id]')].some(el => el.dataset.targetId === id));
  if (side === 'target') $('#pdf-highlights .pdf-linked-mark')?.scrollIntoView({ block: 'center', behavior: 'auto' });
  const root = $('.workspace').dataset.view === 'split' ? $('#mirror-scroll') : $('#sentences');
  const counterpart = side === 'source' ? [...root.querySelectorAll('[data-target-id]')].find(el => el.dataset.targetId === targetIds[0]) : null;
  counterpart?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  if (separate) for (const pane of [$('#pdf-scroll'), $('#mirror-scroll')]) suppressedScroll.set(pane, [pane.scrollTop, pane.scrollLeft]);
}

function translationCard(translation) {
  const card = node('div', 'translation-card');
  const target = button(translation.text, 'sentence-target', () => selectSentence(translation.id, 'target'));
  target.lang = 'zh'; target.dataset.targetId = translation.id;
  const meta = node('div', 'target-meta');
  meta.append(node('span','provenance',translation.provenance?.kind || 'legacy'));
  meta.append(node('span', `badge ${translation.confirmed ? 'confirmed' : ''}`, translation.confirmed ? 'User-confirmed · 已确认' : translation.sourceIds.length ? 'Unreviewed · 待核对' : 'Unaligned · 未对齐'));
  meta.append(button(translation.confirmed ? 'Mark uncertain' : 'Confirm link', 'review-button', async () => {
    if (!translation.sourceIds.length) throw new Error('Select an English sentence and relink this translation first.');
    await mutate('Review translation', () => { translation.confirmed = !translation.confirmed; if (translation.confirmed) translation.verifiedAt = Date.now(); });
  }));
  meta.append(button('Relink to selection', 'review-button', async () => {
    if (!state.selected) throw new Error('Select one English sentence first.');
    await mutate('Relink translation', () => { translation.sourceIds = [state.selected]; translation.confirmed = false; });
  }));
  meta.append(button('Edit source IDs', 'review-button', async () => {
    const value = prompt('Source IDs, comma separated. Visit both pages first for cross-page links. Empty = unaligned.', translation.sourceIds.join(', '));
    if (value === null) return;
    await mutate('Edit alignment', () => correctLink(translation, value.split(',').map(id => id.trim()).filter(Boolean), allSources(state.doc)));
  }), button('Edit text', 'review-button', async () => {
    const value = prompt('Edit Chinese translation:', translation.text);
    if (value === null) return;
    const [entry] = validateTranslations([{ text: value, sourceIds: translation.sourceIds }], allSources(state.doc));
    await mutate('Edit translation', () => { translation.text = entry.text; translation.confirmed = false; translation.provenance = { ...translation.provenance, kind: 'corrected', editedAt: Date.now() }; });
  }), button('Remove', 'review-button', async () => {
    await mutate('Remove translation', () => removeTranslation(translation.id));
  }));
  card.append(target, meta); return card;
}

function renderSentences() {
  paintMirror();
  const list = $('#sentences'), readingTop = list.scrollTop; list.replaceChildren();
  const query = $('#search').value.trim().toLowerCase();
  if (!sources().length) { list.append(node('p', 'empty-state', 'No text was found on this page. It may be a scan. You can still read the PDF and add page notes. OCR is not included. 本页未提取到文本。')); return; }
  const rendered = new Set();
  for (const source of sources()) {
    const targets = translations().filter(t => t.sourceIds.includes(source.id));
    if (query && !source.text.toLowerCase().includes(query) && !targets.some(t => t.text.toLowerCase().includes(query))) continue;
    const block = node('article', 'sentence-block');
    block.append(node('div', 'sentence-label', `ENGLISH · ${source.id}`));
    if (source.warnings?.length) block.append(node('div', 'source-warning', source.warnings.join(' · ')));
    const sourceButton = button(source.text, 'sentence-source', () => selectSentence(source.id, 'source'));
    sourceButton.dataset.sourceId = source.id;
    sourceButton.classList.toggle('marked', state.doc.notes.some(n => n.sourceId === source.id && n.kind === 'highlight'));
    sourceButton.classList.toggle('selected', source.id === state.selected);
    block.append(sourceButton);
    const actions = node('div', 'sentence-actions');
    actions.append(button('Highlight', '', async () => {
      await toggleSourceHighlight(source);
    }), button('Annotate', '', () => { selectSentence(source.id, 'source'); showNotes(true); $('#note-text').focus(); }), button('＋ 中文', '', () => { selectSentence(source.id, 'source'); $('#translation-dialog').showModal(); }));
    block.append(actions);
    for (const target of targets) if (!rendered.has(target.id)) { block.append(translationCard(target)); rendered.add(target.id); }
    if (!targets.length) block.append(node('div', 'translation-empty', 'Add a translation · 添加译文'));
    list.append(block);
  }
  for (const target of translations().filter(t => !t.sourceIds.length && (!query || t.text.toLowerCase().includes(query)))) list.append(translationCard(target));
  if (!list.childNodes.length) list.append(node('p', 'empty-state', 'No matching sentences on this page.'));
  list.scrollTop = readingTop;
}

function showNotes(visible) {
  $('#notes-pane').hidden = !visible; $('.workspace').classList.toggle('notes-hidden', !visible);
  $('#toggle-notes').setAttribute('aria-expanded', String(visible));
}
function renderNotes() {
  $('#note-count').textContent = state.doc.notes.length;
  const list = $('#notes-list'); list.replaceChildren();
  if (!state.doc.notes.length) list.append(node('p', 'empty-state', 'Questions, connections, small discoveries. Make this margin yours.'));
  for (const note of [...state.doc.notes].reverse()) {
    const card = node('article', 'note-card');
    const meta = node('div', 'note-meta');
    meta.append(button(`Page ${note.page} · ${note.kind}`, '', async () => { await goPage(note.page); if (note.sourceId) selectSentence(note.sourceId, 'source'); }));
    meta.append(button('Delete', 'danger', async () => {
      await mutate('Remove annotation', () => { state.doc.notes = state.doc.notes.filter(n => n.id !== note.id); });
    }));
    card.append(meta);
    if (note.quote) card.append(node('blockquote', '', note.quote));
    if (note.text) card.append(node('p', '', note.text));
    card.append(button('Edit', '', async () => {
      openEditor('note', note.id);
    }));
    list.append(card);
  }
}
function renderHighlights() {
  const options = { locked: state.activeSourceIds, hovered: state.hoveredIds, notes: state.doc.notes.filter(n => n.page === state.page) };
  mirrorMarks($('#pdf-highlights'), sources(), options);
  mirrorMarks($('#mirror-highlights'), sources(), options);
  const targets = new Set(Object.values(state.doc.translations).flat().filter(t => t.sourceIds.some(id => state.activeSourceIds.includes(id))).map(t => t.id));
  document.querySelectorAll('[data-target-id]').forEach(el => { el.classList.toggle('selected', targets.has(el.dataset.targetId)); el.classList.toggle('hovered', state.hoveredTargets.includes(el.dataset.targetId));
    const entry = translations().find(t => t.id === el.dataset.targetId);
    el.classList.toggle('annotated', !!entry && state.doc.notes.some(n => n.kind === 'highlight' && entry.sourceIds.includes(n.sourceId)));
  });
  document.querySelectorAll('[data-source-id]').forEach(el => { el.classList.toggle('hovered', state.hoveredIds.includes(el.dataset.sourceId)); el.classList.toggle('selected', state.activeSourceIds.includes(el.dataset.sourceId)); });
}
async function goPage(value) {
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1 || page > state.pdf.numPages) { $('#page-number').value = state.page; throw new Error('Enter a valid page number.'); }
  state.viewScrolls = {}; state.page = page; state.selected = null; state.quote = ''; state.activeSourceIds = []; state.hoveredIds = []; state.hoveredTargets = []; state.targetId = null; $('#search').value = '';
  await renderPage();
  for (const pane of [$('#pdf-scroll'), $('#mirror-scroll'), $('#sentences')]) { pane.scrollTop=0; pane.scrollLeft=0; }
}

on('#open-file', 'click', () => $('#file-input').click());
on('#welcome-open', 'click', () => $('#file-input').click());
on('#file-input', 'change', async e => { const file = e.target.files[0]; e.target.value = ''; if (file) await openPDF(new Uint8Array(await file.arrayBuffer()), file.name); });
on('#demo', 'click', () => openPDF(samplePDF(), 'Reading Across Languages.pdf', true));
on('#drop-zone', 'dragover', e => { e.preventDefault(); $('#drop-zone').classList.add('dragging'); });
on('#drop-zone', 'dragleave', () => $('#drop-zone').classList.remove('dragging'));
on('#drop-zone', 'drop', async e => { e.preventDefault(); $('#drop-zone').classList.remove('dragging'); const file = e.dataTransfer.files[0]; if (file) await openPDF(new Uint8Array(await file.arrayBuffer()), file.name); });
on('#back', 'click', async () => { state.opening++; state.translationRequest?.abort(); await writes.catch(() => {}); $('#reader').hidden = true; $('#welcome').hidden = false; await refreshLibrary(); });
on('#previous', 'click', () => goPage(state.page - 1));
on('#next', 'click', () => goPage(state.page + 1));
on('#page-number', 'change', e => goPage(e.target.value));
on('#zoom-in', 'click', async () => { state.zoom = Math.min(2.5, state.zoom + .25); await renderPage(); });
on('#zoom-out', 'click', async () => { state.zoom = Math.max(.5, state.zoom - .25); await renderPage(); });
on('#toggle-notes', 'click', async () => { showNotes($('#notes-pane').hidden); await renderPage(); });
for (const element of document.querySelectorAll('button[data-view]')) element.addEventListener('click', async () => {
  const previous = $('.workspace').dataset.view;
  state.viewScrolls[previous] = { pdf: $('#pdf-scroll').scrollTop, mirror: $('#mirror-scroll').scrollTop, reading: $('#sentences').scrollTop };
  document.querySelectorAll('button[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === element)));
  $('.workspace').dataset.view = element.dataset.view;
  const saved = state.viewScrolls[element.dataset.view];
  // Reading already has its source text. Restore before asynchronous PDF work so
  // a reader's subsequent scroll or edit cannot be overwritten by its completion.
  if (element.dataset.view === 'text') {
    if (saved) $('#sentences').scrollTop=saved.reading;
    else if (state.selected) $('#sentences').querySelector(`[data-source-id="${state.selected}"]`)?.scrollIntoView({block:'center'});
  }
  try { await renderPage();
    if(saved && $('.workspace').dataset.view===element.dataset.view && element.dataset.view!=='text') {
      $('#pdf-scroll').scrollTop=saved.pdf; $('#mirror-scroll').scrollTop=saved.mirror;
    }
  } catch (error) { status(error.message, true); }
});
on('#search', 'input', renderSentences);
on('#save-note', 'click', async () => {
  const text = $('#note-text').value.trim();
  if (!text) throw new Error('Write a note first.');
  if (text.length > 20000) throw new Error('Please keep notes under 20,000 characters.');
  await mutate('Add note', () => state.doc.notes.push(anchoredNote({ kind: 'note', page: state.page, sourceId: state.selected, sourceIds: [...state.activeSourceIds], quote: state.quote, text })));
  $('#note-text').value = ''; renderNotes(); status(persistent ? 'Note saved on this device.' : 'Note kept for this session. Export before closing.');
});
on('#highlight-selection', 'pointerdown', e => e.preventDefault());
on('#highlight-selection', 'click', async () => {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) throw new Error('Select text on the PDF page first.');
  const range = selection.getRangeAt(0);
  if (!$('#text-layer').contains(range.commonAncestorContainer)) throw new Error('Select text inside the PDF page.');
  const pageRect = $('#pdf-page').getBoundingClientRect();
  const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => ({ x: Math.max(0, (r.left - pageRect.left) / pageRect.width), y: Math.max(0, (r.top - pageRect.top) / pageRect.height), width: Math.min(1, r.width / pageRect.width), height: Math.min(1, r.height / pageRect.height) }));
  await mutate('Highlight PDF selection', () => state.doc.notes.push(anchoredNote({ kind: 'highlight', page: state.page, quote: selection.toString(), text: '', rects })));
  selection.removeAllRanges(); renderHighlights(); renderNotes(); status('PDF selection highlighted. Add a comment with Edit in Notes.');
});
on('#export', 'click', () => download(state.doc.name.replace(/\.pdf$/i, '') + '.reader.md', markdown(state.doc, state.doc.notes), 'text/markdown;charset=utf-8'));
on('#translation-settings', 'click', () => $('#translation-dialog').showModal());
on('#add-translation', 'click', async () => {
  if (!state.selected) throw new Error('Select one English sentence before adding a translation.');
  const text = $('#manual-translation').value.trim();
  const [entry] = validateTranslations([{ sourceIds: [state.selected], text }], sources());
  entry.confirmed = true; entry.provenance = { kind: 'manual', createdAt: Date.now() }; await mutate('Add manual translation', () => addTranslations([entry]));
  $('#manual-translation').value = ''; $('#translation-dialog').close(); renderSentences(); status('Translation linked to the selected sentence.');
});
on('#export-source', 'click', () => download(`page-${state.page}-sources.json`, JSON.stringify({ documentId: state.doc.id, page: state.page, sentences: sources() }, null, 2), 'application/json'));
on('#import-translations', 'click', () => $('#translation-file').click());
on('#translation-file', 'change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const doc = state.doc, page = state.page, pageSources = allSources(state.doc);
  if (file.size > 2 * 1024 * 1024) throw new Error('Translation files must be smaller than 2 MB.');
  const imported = validateTranslations(JSON.parse(await file.text()), pageSources);
  if (state.doc !== doc || state.page !== page) throw new Error('The page changed. Import again on the intended page.');
  if (translations().length + imported.length > 2000) throw new Error('At most 2,000 translations are supported per page.');
  await mutate('Import translations', () => addTranslations(imported));
  $('#translation-status').textContent = `Imported ${imported.length} translations. Review their sentence links before confirming.`;
});
async function translateScope(scope) {
  if (!$('#translation-consent').checked) throw new Error('Consent is required before sending text to a translation endpoint.');
  const endpoint = $('#endpoint').value.trim();
  if (!endpoint) throw new Error('Automatic translation is not configured yet. Connect the documented Worker or a trusted adapter.');
  const doc = state.doc, engine = state.engine;
  const pages = scope === 'paper' ? Array.from({length: doc.pageCount},(_,i)=>i+1) : [state.page];
  const controller = new AbortController(); state.translationRequest?.abort(); state.translationRequest = controller;
  $('#translate-page').disabled=true; $('#translate-paper').disabled=true; $('#cancel-translation').hidden=false;
  $('#translation-progress').hidden=false; $('#translation-progress').max=pages.length; $('#translation-progress').value=0;
  doc.translationCache ||= {};
  try {
    const result = await runTranslationJob({ pages, endpoint, cache:doc.translationCache, limit:Number($('#translation-limit').value), signal:controller.signal,
      extract:async page=>{
        const extracted=await engine.extract(page);
        if(state.doc!==doc)throw new Error('Document changed.');
        const old=doc.sources[page];
        doc.sources[page]=old && JSON.stringify(old.map(s=>[s.id,s.text]))!==JSON.stringify(extracted.sources.map(s=>[s.id,s.text])) ? recoverSourceAnchors(old,extracted.content.items,extracted.page.getViewport({scale:1})) : old || extracted.sources;
        doc.translations[page] ||= []; return doc.sources[page];
      },
      getExisting:page=>pageTranslations(doc,page),
      request:async (sources,signal)=>requestTranslation({endpoint,sources,consent:true,signal,challengeToken:await challengeToken(endpoint===service.endpoint?service.turnstileSiteKey:'',signal)}),
      onBatch:async (page,entries)=>{
        if(state.doc!==doc || controller.signal.aborted)throw new DOMException('Stopped','AbortError');
        // Do not overwrite a manual edit made while the network request was in flight.
        const covered=new Set(pageTranslations(doc,page).flatMap(t=>t.sourceIds));
        const fresh=entries.filter(t=>!t.sourceIds.some(id=>covered.has(id)));
        if(doc.translations[page].length+fresh.length>2000)throw new Error('Page translation limit reached.');
        await mutate(`Translate page ${page}`,()=>doc.translations[page].push(...fresh));
      },
      onProgress:progress=>{
        $('#translation-progress').value=progress.completed;
        $('#translation-status').textContent=`${progress.phase} · page ${progress.page} · ${progress.completed}/${progress.totalPages} pages · ${progress.characters.toLocaleString()} uncached characters · ${progress.skipped} uncertain sources skipped. Completed batches are saved.`;
      }
    });
    $('#translation-status').textContent=`Translation complete: ${result.completed} pages, ${result.characters.toLocaleString()} characters sent; ${result.skipped} uncertain sources skipped. Machine translations remain unreviewed.`;
  } catch(error) { $('#translation-status').textContent=`${error.name==='AbortError'?'Translation stopped.':error.message} Completed batches are kept; resume skips existing translations.`; throw error; }
  finally { if(state.translationRequest===controller)state.translationRequest=null;$('#translate-page').disabled=false;$('#translate-paper').disabled=false;$('#cancel-translation').hidden=true;updateHistory(); }
}
on('#translate-page','click',()=>translateScope('page'));
on('#translate-paper','click',()=>translateScope('paper'));
on('#cancel-translation','click',()=>state.translationRequest?.abort());
$('#endpoint').value=service.endpoint;
$('#service-status').textContent=service.endpoint?'DeepL API Free proxy configured. Human verification runs after consent. The proxy enforces a shared character budget.':'Automatic service not activated. Manual translations and imports work now. Deployment requires the free proxy account configuration in the repository guide.';
on('#endpoint', 'input', () => { $('#translation-consent').checked = false; state.translationRequest?.abort(); });
on('#translation-consent', 'change', event => { if (!event.target.checked) state.translationRequest?.abort(); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.pdf && !$('#reader').hidden) renderPage().catch(error => status(error.message, true)); }, 200); });
refreshLibrary().catch(() => status('Local storage is unavailable. Enable browser storage to keep notes.', true));

// Source PDF → translated sentences. Selection drags still work normally.
on('#text-layer', 'click', async event => {
  if (!window.getSelection().isCollapsed) return;
  const page = $('#pdf-page').getBoundingClientRect();
  const source = hitTest(sources(), (event.clientX - page.left) / page.width, (event.clientY - page.top) / page.height);
  if (source) { $('#search').value = ''; renderSentences(); await selectSentence(source.id, 'source'); }
});
on('#persist-notes', 'change', async event => {
  persistent = event.target.checked;
  if (state.doc) await save();
  await refreshLibrary();
  status(persistent ? 'Notes will be saved in this browser.' : 'Session mode: export before closing. Previously saved records are kept.');
});
on('#export-json', 'click', () => download(state.doc.name.replace(/\.pdf$/i, '') + '.reader.json', exportBackup(state.doc), 'application/json'));
on('#restore-json', 'click', () => $('#backup-file').click());
on('#backup-file', 'change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw new Error('Backup must be smaller than 10 MB.');
  const doc = state.doc, engine = state.engine;
  const restored = importBackup(JSON.parse(await file.text()), doc);
  // Re-extract from the open PDF to verify every restored source before changing any state.
  for (const [number, rows] of Object.entries(restored.sources)) {
    const actual = await engine.extract(Number(number));
    if (rows.every(source => actual.sources.some(s => s.id === source.id && s.text === source.text))) restored.sources[number] = actual.sources;
    else {
      const anchored = recoverSourceAnchors(rows, actual.content.items, actual.page.getViewport({ scale: 1 }));
      if (anchored.some(source => !source.segments.length)) throw new Error('Backup source text is absent or ambiguous in this PDF. Nothing was imported.');
      restored.sources[number] = anchored;
    }
  }
  if (state.doc !== doc) throw new Error('Document changed; backup was not imported.');
  if (!confirm(`Append ${restored.notes.length} notes and imported translations? Existing work is kept. Restored translation links will need review.`)) return;
  Object.assign(doc.sources, restored.sources);
  await mutate('Restore backup', () => {
    for (const [page, entries] of Object.entries(restored.translations)) (doc.translations[page] ||= []).push(...entries);
    doc.notes.push(...restored.notes);
  });
  await renderPage(); status('Backup restored. Review imported translation links.');
});

function paintMirror() {
  if (!state.doc || state.renderedPage !== state.page || $('.workspace').dataset.view !== 'split') return;
  const result = renderMirror({ sources: sources(), translations: translations(), canvas: $('#pdf-canvas'), textLayer: $('#text-layer'), page: $('#mirror-page'), targetCanvas: $('#mirror-canvas'), targetLayer: $('#mirror-content'), continuation: $('#mirror-continuation'), zoom: state.zoom });
  $('#mirror-status').textContent = !result.total ? 'Original retained · Translate this page or add a sentence translation.' : `${result.fitted} regions typeset · ${result.adapted} spacing adjustments · ${result.deferred} translations in continuation. Original graphics retained; unreviewed links need checking.`;
}
function updateHistory() {
  const h = histories.get(state.doc?.id);
  $('#undo').disabled = !h?.undoStack.length; $('#redo').disabled = !h?.redoStack.length;
  $('#undo').title = h?.undoStack.length ? `Undo ${h.undoStack.at(-1).label} · Ctrl+Z` : 'Undo · Ctrl+Z';
  $('#redo').title = h?.redoStack.length ? `Redo ${h.redoStack.at(-1).label} · Ctrl+Shift+Z` : 'Redo · Ctrl+Shift+Z';
}
async function mutate(label, change) {
  histories.get(state.doc.id).record(state.doc, label, change);
  state.doc.updated = Date.now();
  await save(); renderSentences(); renderNotes(); renderHighlights(); updateHistory();
}
async function travel(direction) {
  if (!state.doc || !$('#reader').checkVisibility()) return;
  if (state.translationRequest) throw new Error('Stop the translation job before Undo or Redo.');
  const label = histories.get(state.doc.id)[direction](state.doc);
  if (!label) return;
  await save(); renderSentences(); renderNotes(); renderHighlights(); updateHistory(); status(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${label}`);
}
on('#undo','click',()=>travel('undo')); on('#redo','click',()=>travel('redo'));
document.addEventListener('keydown',event=>{
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.altKey) return;
  if (event.target.closest('input,textarea,[contenteditable="true"]')) return;
  event.preventDefault(); travel(event.shiftKey?'redo':'undo').catch(e=>status(e.message,true));
});
function anchoredNote(options) {
  const ids = options.sourceIds || (options.sourceId ? [options.sourceId] : []);
  const chinese = Object.values(state.doc.translations).flat().filter(t=>t.sourceIds.some(id=>ids.includes(id))).map(t=>t.text).join('\n');
  return createNote({ ...options, fingerprint: state.doc.id, translation: chinese });
}
async function toggleSourceHighlight(source, removeOnly=false) {
  const existing=state.doc.notes.filter(n=>n.sourceId===source.id && n.kind==='highlight');
  await mutate(existing.length?'Remove highlight':'Highlight sentence',()=>{
    if(existing.length) state.doc.notes=state.doc.notes.filter(n=>!existing.some(e=>e.id===n.id));
    else if(!removeOnly) state.doc.notes.push(anchoredNote({kind:'highlight',page:source.page,sourceId:source.id,quote:source.text}));
  });
}
on('#mark-sentence','click',async()=>{const source=allSources(state.doc).find(s=>s.id===state.selected);if(!source)throw new Error('Select one source sentence first.');await toggleSourceHighlight(source);});
on('#unmark-sentence','click',async()=>{
  if(!state.activeSourceIds.length)throw new Error('Select a highlighted sentence, or remove a PDF selection in Notes.');
  await mutate('Remove highlights',()=>{state.doc.notes=state.doc.notes.filter(n=>!(n.kind==='highlight' && state.activeSourceIds.includes(n.sourceId)));});
});
on('#annotate-sentence','click',()=>{showNotes(true);$('#note-text').focus();});
on('#clear-selection','click',()=>{state.activeSourceIds=[];state.selected=null;state.quote='';state.targetId=null;updateAnchor();renderHighlights();});
on('#edit-selected-translation','click',()=>{if(state.targetId)openEditor('translation',state.targetId);else $('#translation-dialog').showModal();});
function openEditor(kind,id) {
  const value=kind==='note'?state.doc.notes.find(n=>n.id===id):Object.values(state.doc.translations).flat().find(t=>t.id===id);
  if(!value)throw new Error('This item no longer exists.');
  editor={kind,id,documentId:state.doc.id};
  $('#edit-title').textContent=kind==='note'?'Edit annotation · 编辑批注':'Edit translation · 核对译文';
  $('#edit-source').textContent=kind==='note'?`Page ${value.page} · ${value.quote || 'Page note'}`:allSources(state.doc).filter(s=>value.sourceIds.includes(s.id)).map(s=>`[${s.id}] ${s.text}`).join(' ');
  $('#edit-text').value=value.text; $('#edit-link-fields').hidden=kind==='note';
  $('#edit-source-ids').value=(value.sourceIds||[]).join(', ');$('#edit-verified').checked=!!value.confirmed;
  $('#edit-dialog').showModal();$('#edit-text').focus();
}
on('#save-edit','click',async()=>{
  if(editor?.documentId!==state.doc.id)throw new Error('Document changed. Reopen the editor.');
  const text=$('#edit-text').value.trim();if(text.length>20000)throw new Error('Text must be under 20,000 characters.');
  await mutate('Edit '+editor.kind,()=>{
    if(editor.kind==='note'){const note=state.doc.notes.find(n=>n.id===editor.id);note.text=text;note.editedAt=Date.now();}
    else {
      const value=Object.values(state.doc.translations).flat().find(t=>t.id===editor.id);
      const ids=$('#edit-source-ids').value.split(',').map(s=>s.trim()).filter(Boolean);
      validateTranslations([{text,sourceIds:ids}],allSources(state.doc));
      if($('#edit-verified').checked&&!ids.length)throw new Error('Unaligned translations cannot be verified.');
      correctLink(value,ids,allSources(state.doc));value.text=text;value.confirmed=$('#edit-verified').checked;
      value.provenance={...value.provenance,kind:'corrected',editedAt:Date.now()};if(value.confirmed)value.verifiedAt=Date.now();
    }
  });$('#edit-dialog').close();
});
function removeTranslation(id){for(const page of Object.keys(state.doc.translations))state.doc.translations[page]=state.doc.translations[page].filter(t=>t.id!==id);}
on('#delete-edit','click',async()=>{if(editor?.documentId!==state.doc.id)throw new Error('Document changed.');await mutate('Remove '+editor.kind,()=>{if(editor.kind==='note')state.doc.notes=state.doc.notes.filter(n=>n.id!==editor.id);else removeTranslation(editor.id);});$('#edit-dialog').close();});

function preview(id,side) {
  const ids = id ? (side==='source'?[id]:linkedIds(translations(),id,'target')) : [];
  const targets=id?(side==='target'?[id]:linkedIds(translations(),id,'source')):[];
  if(JSON.stringify(ids)===JSON.stringify(state.hoveredIds)&&JSON.stringify(targets)===JSON.stringify(state.hoveredTargets))return;
  state.hoveredIds=ids;state.hoveredTargets=targets;renderHighlights();
}
for(const root of [$('#text-layer'),$('#mirror-content'),$('#mirror-continuation'),$('#sentences')]) {
  root.addEventListener('pointermove',event=>{
    if(!state.doc || event.buttons || !window.getSelection().isCollapsed)return;
    const target=event.target.closest('[data-target-id]'), source=event.target.closest('[data-source-id]');
    if(target)return preview(target.dataset.targetId,'target');if(source)return preview(source.dataset.sourceId,'source');
    const box=(root===$('#text-layer')?$('#pdf-page'):$('#mirror-page')).getBoundingClientRect();
    if(root===$('#text-layer') || event.target.closest('.mirror-source-layer')){const s=hitTest(sources(),(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height);preview(s?.id,'source');}else preview(null);
  });
  root.addEventListener('pointerleave',()=>preview(null));
}
for(const root of [$('#mirror-content'),$('#mirror-continuation')]) {
  const choose=event=>{
    if(!window.getSelection().isCollapsed)return;
    const target=event.target.closest('[data-target-id]'),source=event.target.closest('[data-source-id]');
    if(target)selectSentence(target.dataset.targetId,'target').catch(e=>status(e.message,true));
    else if(source)selectSentence(source.dataset.sourceId,'source').catch(e=>status(e.message,true));
    else if(event.target.closest('.mirror-source-layer')){const box=$('#mirror-page').getBoundingClientRect();const s=hitTest(sources(),(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height);if(s)selectSentence(s.id,'source').catch(e=>status(e.message,true));}
  };
  root.addEventListener('click',choose);
  root.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();choose(event);}});
  root.addEventListener('dblclick',event=>{const t=event.target.closest('[data-target-id]');if(t)openEditor('translation',t.dataset.targetId);});
}
$('#text-layer').addEventListener('dblclick',event=>{const box=$('#pdf-page').getBoundingClientRect();const note=state.doc.notes.find(n=>n.page===state.page && (n.sourceId?sources().find(s=>s.id===n.sourceId)?.rects:n.rects)?.some(r=>(event.clientX-box.left)/box.width>=r.x&&(event.clientX-box.left)/box.width<=r.x+r.width&&(event.clientY-box.top)/box.height>=r.y&&(event.clientY-box.top)/box.height<=r.y+r.height));if(note)openEditor('note',note.id);});
const suppressedScroll = new WeakMap();
for(const [from,to] of [[$('#pdf-scroll'),$('#mirror-scroll')],[$('#mirror-scroll'),$('#pdf-scroll')]])from.addEventListener('scroll',()=>{
  const ignored=suppressedScroll.get(from); suppressedScroll.delete(from);
  if(ignored && Math.abs(from.scrollTop-ignored[0])<1 && Math.abs(from.scrollLeft-ignored[1])<1)return;
  if($('.workspace').dataset.view!=='split')return;
  if(from===$('#mirror-scroll') && from.scrollTop>to.scrollHeight-to.clientHeight+2)return;
  to.scrollTop=from.scrollTop;to.scrollLeft=from.scrollLeft;
  suppressedScroll.set(to,[to.scrollTop,to.scrollLeft]);
},{passive:true});
