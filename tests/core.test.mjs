import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentences, extractText, validateTranslations, linkedIds, validateEndpoint, markdown } from '../src/core.js';
import { samplePDF } from '../src/sample.js';

test('sentence IDs are stable per page and Unicode text is preserved', () => {
  const text = 'A model learns.  Another model reasons! 中文也可以。';
  const result = sentences(text, 3);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(s => s.id), ['p3-s1', 'p3-s2', 'p3-s3']);
  assert.equal(result[2].text, '中文也可以。');
  assert.deepEqual(sentences(text, 3), result);
  assert.deepEqual(sentences('  '), []);
});
test('paragraph gaps are preserved without inventing a column reading order', () => {
  const items = [{ str: 'Title', transform: [1, 0, 0, 1, 0, 700], height: 12 }, { str: 'First sentence.', transform: [1, 0, 0, 1, 0, 650], height: 12 }, { str: 'Second sentence.', transform: [1, 0, 0, 1, 0, 630], height: 12 }];
  assert.equal(extractText(items), 'Title\n\nFirst sentence. Second sentence.');
  assert.deepEqual(sentences(extractText(items)).map(s => s.text), ['Title', 'First sentence.', 'Second sentence.']);
});
test('import preserves explicit many-to-many links but never trusts claimed confidence', () => {
  const sources = sentences('One. Two.');
  const result = validateTranslations([{ text: '一和二。', sourceIds: ['p1-s1', 'p1-s2', 'p1-s1'], confirmed: true, confidence: 1 }], sources);
  assert.deepEqual(result[0].sourceIds, ['p1-s1', 'p1-s2']);
  assert.equal(result[0].confirmed, false);
  assert.deepEqual(linkedIds(result, 'p1-s2', 'source'), [result[0].id]);
  assert.deepEqual(linkedIds(result, result[0].id, 'target'), ['p1-s1', 'p1-s2']);
});
test('unaligned translations remain unaligned', () => {
  const result = validateTranslations([{ text: '无对应原文', sourceIds: [] }], sentences('One.'));
  assert.deepEqual(result[0].sourceIds, []);
  assert.equal(result[0].confirmed, false);
  assert.deepEqual(linkedIds(result, 'p1-s1', 'source'), []);
});
test('malformed and fabricated links are rejected atomically', () => {
  const sources = sentences('One.');
  for (const value of [null, {}, [null], [{ text: '', sourceIds: [] }], [{ text: '译文', sourceIds: ['p9-s1'] }], [{ text: '译文' }], [{ text: '译文', sourceIds: [1] }], [{ text: 'a'.repeat(20001), sourceIds: [] }]]) {
    assert.throws(() => validateTranslations(value, sources));
  }
  assert.throws(() => validateTranslations(Array(2001).fill({ text: '译文', sourceIds: [] }), sources));
});
test('adapter URLs require HTTPS and cannot embed credentials or query secrets', () => {
  assert.equal(validateEndpoint('https://translator.example/translate'), 'https://translator.example/translate');
  for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com#secret']) assert.throws(() => validateEndpoint(url));
});
test('Markdown preserves notes, sources, page numbers and uncertainty; escapes active HTML', () => {
  const doc = { name: 'A <script>paper</script>', sources: { 1: sentences('An argument.') }, translations: { 1: [{ text: '论点。', sourceIds: ['p1-s1'], confirmed: false }] } };
  const result = markdown(doc, [{ page: 2, kind: 'note', quote: 'Quoted\ntext', text: '[click](javascript:alert(1))' }]);
  assert.match(result, /Page 2 · Note/);
  assert.match(result, /Uncertain \/ unreviewed/);
  assert.match(result, /An argument/);
  assert.ok(!result.includes('<script>'));
  assert.ok(!result.includes('[click]'));
});
test('sample PDF has a valid catalog, two pages and consistent xref offsets', () => {
  const pdf = new TextDecoder().decode(samplePDF());
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.match(pdf, /\/Count 2/);
  const offset = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(offset, offset + 4), 'xref');
});
