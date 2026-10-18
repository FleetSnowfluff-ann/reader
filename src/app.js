import { PDFReader } from './pdf.js';
import { allSources, pageTranslations, hitTest, correctLink } from './alignment.js';
import { requestTranslation } from './translation.js';
import { createNote, exportBackup, importBackup } from './annotations.js';
import { recoverSourceAnchors } from './extraction.js';
import { validateTranslations, linkedIds, markdown } from './core.js';
import { storage } from './storage.js';
import { samplePDF } from './sample.js';

const sessionDocuments = new Map();
let persistent = true;
const $ = selector => document.querySelector(selector);
const state = { pdf: null, doc: null, page: 1, zoom: 1, selected: null, quote: '', render: null, generation: 0, opening: 0, translationRequest: null, engine: null, activeSourceIds: [] };
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
  state.page = Math.min(state.doc.lastPage || 1, pdf.numPages);
  state.zoom = 1; state.selected = null; state.quote = ''; state.activeSourceIds = [];
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
  const ready = await state.engine.render(extracted, { canvas: $('#pdf-canvas'), container: $('#pdf-page'), textContainer: $('#text-layer'), availableWidth: Math.max(220, ($('#pdf-scroll').clientWidth || 650) - 36), zoom: state.zoom });
  if (!ready || generation !== state.generation) return;
  for (const source of sources()) source.rects = state.engine.exactRectangles(source, $('#pdf-page'));
  renderSentences(); renderNotes(); renderHighlights(); updateAnchor();
  await save();
}

function updateAnchor() {
  $('#note-anchor').textContent = state.quote ? `Page ${state.page} · “${state.quote}”` : `Page ${state.page} note · Select a sentence to attach a quote`;
}
async function selectSentence(id, side) {
  const related = linkedIds(Object.values(state.doc.translations).flat(), id, side);
  const sourceIds = side === 'source' ? [id] : related;
  const targetIds = side === 'target' ? [id] : related;
  if (side === 'target' && sourceIds.length && !sourceIds.some(id => id.startsWith(`p${state.page}-`))) await goPage(allSources(state.doc).find(s => s.id === sourceIds[0]).page);
  state.activeSourceIds = sourceIds;
  state.selected = sourceIds.length === 1 ? sourceIds[0] : null;
  state.quote = allSources(state.doc).filter(s => sourceIds.includes(s.id)).map(s => s.text).join(' ');
  document.querySelectorAll('[data-source-id]').forEach(element => element.classList.toggle('selected', sourceIds.includes(element.dataset.sourceId)));
  document.querySelectorAll('[data-target-id]').forEach(element => element.classList.toggle('selected', targetIds.includes(element.dataset.targetId)));
  updateAnchor(); renderHighlights();
  if (side === 'target') $('#pdf-highlights .pdf-linked-mark')?.scrollIntoView({ block: 'center', behavior: 'auto' });
  const counterpart = side === 'source' ? document.querySelector(`[data-target-id="${targetIds[0]}"]`) : document.querySelector(`[data-source-id="${sourceIds[0]}"]`);
  counterpart?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

function translationCard(translation) {
  const card = node('div', 'translation-card');
  const target = button(translation.text, 'sentence-target', () => selectSentence(translation.id, 'target'));
  target.lang = 'zh'; target.dataset.targetId = translation.id;
  const meta = node('div', 'target-meta');
  meta.append(node('span', `badge ${translation.confirmed ? 'confirmed' : ''}`, translation.confirmed ? 'User-confirmed · 已确认' : translation.sourceIds.length ? 'Unreviewed · 待核对' : 'Unaligned · 未对齐'));
  meta.append(button(translation.confirmed ? 'Mark uncertain' : 'Confirm link', 'review-button', async () => {
    if (!translation.sourceIds.length) throw new Error('Select an English sentence and relink this translation first.');
    translation.confirmed = !translation.confirmed; await save(); renderSentences();
  }));
  meta.append(button('Relink to selection', 'review-button', async () => {
    if (!state.selected) throw new Error('Select one English sentence first.');
    translation.sourceIds = [state.selected]; translation.confirmed = false;
    await save(); renderSentences();
  }));
  meta.append(button('Edit source IDs', 'review-button', async () => {
    const value = prompt('Source IDs, comma separated. Visit both pages first for cross-page links. Empty = unaligned.', translation.sourceIds.join(', '));
    if (value === null) return;
    correctLink(translation, value.split(',').map(id => id.trim()).filter(Boolean), allSources(state.doc));
    await save(); renderSentences();
  }), button('Edit text', 'review-button', async () => {
    const value = prompt('Edit Chinese translation:', translation.text);
    if (value === null) return;
    const [entry] = validateTranslations([{ text: value, sourceIds: translation.sourceIds }], allSources(state.doc));
    translation.text = entry.text; translation.confirmed = false; await save(); renderSentences();
  }), button('Remove', 'review-button', async () => {
    for (const page of Object.keys(state.doc.translations)) state.doc.translations[page] = state.doc.translations[page].filter(t => t.id !== translation.id);
    await save(); renderSentences();
  }));
  card.append(target, meta); return card;
}

function renderSentences() {
  const list = $('#sentences'); list.replaceChildren();
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
      if (state.doc.notes.some(n => n.sourceId === source.id && n.kind === 'highlight')) return status('This sentence is already highlighted.');
      state.doc.notes.push(createNote({ kind: 'highlight', page: state.page, sourceId: source.id, quote: source.text, text: '' }));
      await save(); renderSentences(); renderHighlights(); renderNotes();
    }), button('Annotate', '', () => { selectSentence(source.id, 'source'); showNotes(true); $('#note-text').focus(); }), button('＋ 中文', '', () => { selectSentence(source.id, 'source'); $('#translation-dialog').showModal(); }));
    block.append(actions);
    for (const target of targets) if (!rendered.has(target.id)) { block.append(translationCard(target)); rendered.add(target.id); }
    if (!targets.length) block.append(node('div', 'translation-empty', 'Add a translation · 添加译文'));
    list.append(block);
  }
  for (const target of translations().filter(t => !t.sourceIds.length && (!query || t.text.toLowerCase().includes(query)))) list.append(translationCard(target));
  if (!list.childNodes.length) list.append(node('p', 'empty-state', 'No matching sentences on this page.'));
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
      if (!confirm('Delete this annotation?')) return;
      state.doc.notes = state.doc.notes.filter(n => n.id !== note.id); await save(); renderNotes(); renderSentences(); renderHighlights();
    }));
    card.append(meta);
    if (note.quote) card.append(node('blockquote', '', note.quote));
    if (note.text) card.append(node('p', '', note.text));
    card.append(button('Edit', '', async () => {
      const value = prompt('Edit note · 编辑笔记', note.text || '');
      if (value === null) return;
      note.text = value.slice(0, 20000); await save(); renderNotes();
    }));
    list.append(card);
  }
}
function renderHighlights() {
  $('#pdf-highlights').replaceChildren();
  const marks = state.doc.notes.filter(n => n.page === state.page).map(note => ({ ...note, rects: note.sourceId ? sources().find(s => s.id === note.sourceId)?.rects || [] : note.rects }));
  for (const note of marks) for (const rect of note.rects || []) {
    const mark = node('div', 'pdf-mark');
    Object.assign(mark.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
    $('#pdf-highlights').append(mark);
  }
  for (const source of sources().filter(s => state.activeSourceIds.includes(s.id))) for (const rect of source.rects || []) {
    const mark = node('div', 'pdf-linked-mark'); mark.dataset.sourceId = source.id;
    Object.assign(mark.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
    $('#pdf-highlights').append(mark);
  }
}
async function goPage(value) {
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1 || page > state.pdf.numPages) { $('#page-number').value = state.page; throw new Error('Enter a valid page number.'); }
  state.page = page; state.selected = null; state.quote = ''; state.activeSourceIds = []; $('#search').value = '';
  await renderPage();
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
  document.querySelectorAll('button[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === element)));
  $('.workspace').dataset.view = element.dataset.view;
  try { await renderPage(); } catch (error) { status(error.message, true); }
});
on('#search', 'input', renderSentences);
on('#save-note', 'click', async () => {
  const text = $('#note-text').value.trim();
  if (!text) throw new Error('Write a note first.');
  if (text.length > 20000) throw new Error('Please keep notes under 20,000 characters.');
  state.doc.notes.push(createNote({ kind: 'note', page: state.page, sourceId: state.selected, sourceIds: [...state.activeSourceIds], quote: state.quote, text }));
  await save(); $('#note-text').value = ''; renderNotes(); status(persistent ? 'Note saved on this device.' : 'Note kept for this session. Export before closing.');
});
on('#highlight-selection', 'pointerdown', e => e.preventDefault());
on('#highlight-selection', 'click', async () => {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) throw new Error('Select text on the PDF page first.');
  const range = selection.getRangeAt(0);
  if (!$('#text-layer').contains(range.commonAncestorContainer)) throw new Error('Select text inside the PDF page.');
  const pageRect = $('#pdf-page').getBoundingClientRect();
  const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => ({ x: Math.max(0, (r.left - pageRect.left) / pageRect.width), y: Math.max(0, (r.top - pageRect.top) / pageRect.height), width: Math.min(1, r.width / pageRect.width), height: Math.min(1, r.height / pageRect.height) }));
  state.doc.notes.push(createNote({ kind: 'highlight', page: state.page, quote: selection.toString(), text: '', rects }));
  selection.removeAllRanges(); await save(); renderHighlights(); renderNotes(); status('PDF selection highlighted. Add a comment with Edit in Notes.');
});
on('#export', 'click', () => download(state.doc.name.replace(/\.pdf$/i, '') + '.reader.md', markdown(state.doc, state.doc.notes), 'text/markdown;charset=utf-8'));
on('#translation-settings', 'click', () => $('#translation-dialog').showModal());
on('#add-translation', 'click', async () => {
  if (!state.selected) throw new Error('Select one English sentence before adding a translation.');
  const text = $('#manual-translation').value.trim();
  const [entry] = validateTranslations([{ sourceIds: [state.selected], text }], sources());
  entry.confirmed = true; addTranslations([entry]);
  await save(); $('#manual-translation').value = ''; $('#translation-dialog').close(); renderSentences(); status('Translation linked to the selected sentence.');
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
  addTranslations(imported); await save(); renderSentences();
  $('#translation-status').textContent = `Imported ${imported.length} translations. Review their sentence links before confirming.`;
});
on('#translate-page', 'click', async () => {
  if (!$('#translation-consent').checked) throw new Error('Consent is required before sending text to a translation endpoint.');
  const endpoint = $('#endpoint').value;
  if (!sources().length) throw new Error('No extracted text to translate.');
  const doc = state.doc, page = state.page, pageSources = sources();
  const controller = new AbortController(); state.translationRequest?.abort(); state.translationRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 30000);
  $('#translate-page').disabled = true; $('#translation-status').textContent = 'Sending this page’s text to your adapter…';
  try {
    const imported = await requestTranslation({ endpoint, sources: pageSources, consent: $('#translation-consent').checked, signal: controller.signal });
    if (state.doc !== doc || state.page !== page) throw new Error('The document or page changed; response discarded.');
    if (translations().length + imported.length > 2000) throw new Error('At most 2,000 translations are supported per page.');
    addTranslations(imported); await save(); renderSentences();
    $('#translation-status').textContent = `Added ${imported.length} translations. All links need review.`;
  } catch (error) { $('#translation-status').textContent = `Translation failed: ${error.name === 'AbortError' ? 'Request cancelled or timed out.' : error.message}`; throw error; }
  finally { clearTimeout(timeout); $('#translate-page').disabled = false; }
});
on('#endpoint', 'input', () => { $('#translation-consent').checked = false; });
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
  for (const [page, entries] of Object.entries(restored.translations)) (doc.translations[page] ||= []).push(...entries);
  doc.notes.push(...restored.notes);
  await save(); await renderPage(); status('Backup restored. Review imported translation links.');
});
