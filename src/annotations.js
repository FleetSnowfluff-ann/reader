const text = (value, max = 20000) => typeof value === 'string' && value.length <= max;
export function createNote({ kind = 'note', page, sourceId = null, sourceIds = sourceId ? [sourceId] : [], quote = '', text: body = '', rects = [], fingerprint = '', translation = '' }) {
  if (!Number.isSafeInteger(page) || page < 1 || !text(body) || !text(quote) || !text(translation, 60000) || (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint))) throw new Error('Invalid annotation.');
  return { id: crypto.randomUUID(), kind, page, sourceId, sourceIds, quote, text: body, rects, fingerprint, translation, created: Date.now() };
}
export function exportBackup(doc) {
  return JSON.stringify({ schema: 'parallel-notes', version: 1, exportedAt: new Date().toISOString(), document: { id: doc.id, name: doc.name, pageCount: doc.pageCount, sources: doc.sources, translations: doc.translations, notes: doc.notes, lastPage: doc.lastPage } }, null, 2);
}
export function importBackup(value, current) {
  if (value?.schema !== 'parallel-notes' || value.version !== 1 || value.document?.id !== current.id) throw new Error('Backup version or PDF fingerprint does not match the open document.');
  const d = value.document;
  if (!text(d.name, 1000) || !Array.isArray(d.notes) || d.notes.length > 10000 || !d.sources || !d.translations || typeof d.sources !== 'object' || typeof d.translations !== 'object') throw new Error('Invalid backup structure.');
  const sources = {}, known = new Set();
  for (const [key, rows] of Object.entries(d.sources)) {
    const page = Number(key);
    if (!Number.isSafeInteger(page) || page < 1 || page > current.pageCount || !Array.isArray(rows) || rows.length > 5000) throw new Error('Invalid source page.');
    sources[page] = rows.map(s => {
      if (!s || !text(s.id, 80) || !new RegExp(`^p${page}-s\\d+$`).test(s.id) || s.page !== page || known.has(s.id) || !text(s.text)) throw new Error('Invalid source reference.');
      known.add(s.id);
      // Geometry is regenerated from the actual PDF, never trusted from a backup.
      return { id: s.id, page, text: s.text, rects: [], warnings: ['Restored source: verify against PDF'] };
    });
  }
  const translations = {};
  for (const [key, rows] of Object.entries(d.translations)) {
    if (!Object.hasOwn(sources, key) || !Array.isArray(rows) || rows.length > 2000) throw new Error('Invalid translation page.');
    translations[key] = rows.map(t => {
      if (!t || !text(t.text) || !Array.isArray(t.sourceIds) || t.sourceIds.some(id => !known.has(id))) throw new Error('Invalid translation reference.');
      return { id: crypto.randomUUID(), text: t.text, sourceIds: [...new Set(t.sourceIds)], confirmed: false, provenance: { kind: 'imported', originalKind: ['machine','manual','corrected','imported'].includes(t.provenance?.kind) ? t.provenance.kind : 'unknown' } };
    });
  }
  const notes = d.notes.map(n => {
    if (!n || !Number.isSafeInteger(n.page) || n.page < 1 || n.page > current.pageCount || !text(n.text) || !text(n.quote) || !['note', 'highlight'].includes(n.kind) || (n.sourceId && !known.has(n.sourceId)) || (n.sourceIds && (!Array.isArray(n.sourceIds) || n.sourceIds.some(id => !known.has(id))))) throw new Error('Invalid note reference.');
    const rects = n.rects || [];
    if (!Array.isArray(rects) || rects.length > 2000 || rects.some(r => !r || ['x', 'y', 'width', 'height'].some(k => typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0 || r[k] > 1))) throw new Error('Invalid highlight coordinates.');
    if (n.fingerprint && n.fingerprint !== current.id) throw new Error('Annotation fingerprint does not match.');
    return createNote({ ...n, rects, fingerprint: current.id, translation: n.translation || '' });
  });
  // Imported notes append; existing notes and source anchors are never overwritten.
  return { sources, translations, notes };
}
