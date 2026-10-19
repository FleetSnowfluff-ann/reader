export function sentences(text, page = 1) {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const parts = text.split(/\n\s*\n/).flatMap(paragraph => [...segmenter.segment(paragraph.replace(/\s+/g, ' ').trim())]);
  return parts.filter(p => p.segment.trim()).map((p, i) => ({ id: `p${page}-s${i + 1}`, text: p.segment.trim(), page }));
}

export function extractText(items) {
  let result = '', previous;
  for (const item of items) {
    if (!item.str) continue;
    const y = item.transform?.[5];
    const gap = previous && Number.isFinite(y) && Number.isFinite(previous.transform?.[5]) && Math.abs(y - previous.transform[5]);
    const paragraph = gap > Math.max(item.height || 12, previous?.height || 12) * 2;
    result += (result ? paragraph ? '\n\n' : ' ' : '') + item.str;
    previous = item;
  }
  return result;
}

export function validateTranslations(input, sources) {
  if (!Array.isArray(input) || input.length > 2000) throw new Error('Expected an array of at most 2,000 translation entries.');
  const ids = new Set(sources.map(s => s.id));
  return input.map((entry, i) => {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 20000) throw new Error(`Entry ${i + 1}: invalid translation text.`);
    if (!Array.isArray(entry.sourceIds) || entry.sourceIds.some(id => typeof id !== 'string' || !ids.has(id))) throw new Error(`Entry ${i + 1}: unknown source sentence ID.`);
    return { id: crypto.randomUUID(), text: entry.text.trim(), sourceIds: [...new Set(entry.sourceIds)], confirmed: false, provenance: { kind: 'imported' } };
  });
}

export function linkedIds(translations, id, side) {
  return side === 'source'
    ? translations.filter(t => t.sourceIds.includes(id)).map(t => t.id)
    : translations.find(t => t.id === id)?.sourceIds || [];
}

export function validateEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Use an endpoint without credentials, query parameters, or fragments.');
  if (url.protocol !== 'https:') throw new Error('Translation endpoints must use HTTPS.');
  return url.href;
}

const escapeMD = text => String(text).replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
export function markdown(doc, notes) {
  return `# ${escapeMD(doc.name)}\n\nPDF SHA-256: ${escapeMD(doc.id || 'unavailable')}\n\nExported from Parallel. PDFs and notes stay in your browser unless you explicitly export or send text for translation.\n\n` +
    notes.map(n => `## Page ${n.page} · ${n.kind === 'highlight' ? 'Highlight' : 'Note'}\n\nSource: ${escapeMD(n.sourceIds?.length ? n.sourceIds.join(', ') : n.sourceId || 'page / PDF selection')}\n\n${n.quote ? '> ' + escapeMD(n.quote).replace(/\n/g, '\n> ') + '\n\n' : ''}${escapeMD(n.text || '')}\n\n${n.translation ? '**Chinese at annotation time:** ' + escapeMD(n.translation) + '\n\n' : ''}[Open original PDF](<./${encodeURIComponent(doc.name)}#page=${n.page}>) · SHA-256: ${escapeMD(n.fingerprint || doc.id || 'unavailable')}\n${n.id ? '^reader-' + n.id.replace(/[^a-zA-Z0-9-]/g, '') + '\n' : ''}`).join('\n') +
    '\n## Bilingual reading\n\n' + Object.entries(doc.translations || {}).map(([page, items]) => items.map(t => `### Page ${page} · ${t.confirmed ? 'User-confirmed' : 'Uncertain / unreviewed'}\n\nProvenance: ${escapeMD(t.provenance?.kind || 'legacy / unknown')}\n\nSource IDs: ${t.sourceIds.map(escapeMD).join(', ') || 'Unaligned'}\n\n${Object.values(doc.sources || {}).flat().filter(s => t.sourceIds.includes(s.id)).map(s => `[page ${s.page}] ${escapeMD(s.text)}`).join(' ')}\n\n${escapeMD(t.text)}\n`).join('\n')).join('\n');
}
