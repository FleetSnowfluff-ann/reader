import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage, sentenceRanges, recoverSourceAnchors } from '../src/extraction.js';
import { correctLink, pageTranslations, hitTest } from '../src/alignment.js';
import { createNote, exportBackup, importBackup } from '../src/annotations.js';
import { requestTranslation } from '../src/translation.js';
const viewport = { width: 600, height: 800, convertToViewportRectangle: ([x, y, r, t]) => [x, 800 - t, r, 800 - y] };
const item = (str, x, y, width = 210) => ({ str, width, height: 12, transform: [12, 0, 0, 12, x, y] });
test('two-column extraction reads each column and keeps character-to-item provenance', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(item(`Left sentence ${i}.`, 40, 700 - i * 18), item(`Right sentence ${i}.`, 330, 700 - i * 18));
  const result = extractPage(items, viewport, 3);
  assert.equal(result.columns, 2);
  assert.deepEqual(result.sources.map(s => s.text), [...Array(6)].map((_, i) => `Left sentence ${i}.`).concat([...Array(6)].map((_, i) => `Right sentence ${i}.`)));
  for (const source of result.sources) assert.equal(source.segments.map(s => items[s.itemIndex].str.slice(s.start, s.end)).join(''), source.text);
  assert.ok(result.sources[0].warnings.some(w => w.includes('previous page')));
  assert.ok(result.sources.at(-1).warnings.some(w => w.includes('next page')));
});
test('existing annotation IDs survive extraction upgrades without invented anchors', () => {
  const items = [item('Title', 40, 700), item('A sentence.', 40, 650), item('Repeated.', 40, 600), item('Repeated.', 40, 550)];
  const old = [{ id: 'p1-s1', page: 1, text: 'Title A sentence.' }, { id: 'p1-s2', page: 1, text: 'Repeated.' }];
  const result = recoverSourceAnchors(old, items, viewport);
  assert.equal(result[0].id, 'p1-s1'); assert.equal(result[0].segments.length, 2);
  assert.deepEqual(result[1].segments, []); assert.ok(result[1].warnings[0].includes('ambiguous'));
});
test('abbreviations, formulas and untrustworthy character mapping are explicit', () => {
  const text = 'See Fig. 3. Another result follows.';
  assert.deepEqual(sentenceRanges(text).map(s => text.slice(s.start, s.end).trim()), ['See Fig. 3.', 'Another result follows.']);
  const result = extractPage([item('a = b + c', 40, 700), item('Broken\u0003text.', 40, 600)], viewport, 1);
  assert.ok(result.sources[0].warnings.some(w => w.startsWith('Formula')));
  assert.ok(result.sources[1].warnings.some(w => w.startsWith('Unreliable')));
});
test('cross-page links require explicit known IDs and are shown on both pages', () => {
  const a = { id: 'p1-s1', page: 1, text: 'First fragment' }, b = { id: 'p2-s1', page: 2, text: 'continues here.' };
  const entry = { id: 't1', text: '译文', sourceIds: [], confirmed: true };
  correctLink(entry, [a.id, b.id], [a, b]); assert.equal(entry.confirmed, false);
  const doc = { sources: { 1: [a], 2: [b] }, translations: { 1: [entry] } };
  assert.deepEqual(pageTranslations(doc, 1), [entry]); assert.deepEqual(pageTranslations(doc, 2), [entry]);
  assert.throws(() => correctLink(entry, ['p99-s1'], [a, b]));
  assert.deepEqual(entry.sourceIds, [a.id, b.id]);
});
test('PDF hit testing selects the actual containing rectangle, never a nearest guess', () => {
  const a = { id: 'p1-s1', rects: [{ x: .1, y: .1, width: .2, height: .02 }] };
  assert.equal(hitTest([a], .15, .11), a);
  assert.equal(hitTest([a], .7, .7), undefined);
});
test('JSON backup preserves portable data, rejects wrong fingerprints and malformed anchors', () => {
  const doc = { id: 'a'.repeat(64), name: 'paper.pdf', pageCount: 2, sources: { 1: [{ id: 'p1-s1', page: 1, text: 'A sentence.' }] }, translations: { 1: [{ id: crypto.randomUUID(), text: '一句话。', sourceIds: ['p1-s1'], confirmed: true }] }, notes: [createNote({ page: 1, sourceId: 'p1-s1', text: 'My note.' })] };
  const value = JSON.parse(exportBackup(doc));
  const restored = importBackup(value, doc);
  assert.equal(restored.notes[0].text, 'My note.'); assert.equal(restored.translations[1][0].confirmed, false);
  assert.deepEqual(restored.sources[1][0].rects, []);
  assert.throws(() => importBackup(value, { ...doc, id: 'b'.repeat(64) }));
  value.document.notes[0].sourceId = 'p99-s1'; assert.throws(() => importBackup(value, doc));
});
test('adapter refuses unconsented or corrupt text without making a request', async () => {
  await assert.rejects(requestTranslation({ endpoint: 'https://example.com', sources: [], consent: false }), /Consent/);
  await assert.rejects(requestTranslation({ endpoint: 'https://example.com', sources: [{ id: 'p1-s1', text: 'bad', warnings: ['Unreliable character mapping; read the original PDF'] }], consent: true }), /unreliable character/);
});
