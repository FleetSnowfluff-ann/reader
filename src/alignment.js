export { validateTranslations, linkedIds } from './core.js';
export const allSources = doc => Object.values(doc.sources || {}).flat();
export function pageTranslations(doc, page) {
  return Object.entries(doc.translations || {}).flatMap(([owner, entries]) => entries.filter(t => Number(owner) === page || t.sourceIds.some(id => id.startsWith(`p${page}-`))));
}
export function hitTest(sources, x, y) {
  return sources.flatMap(source => (source.rects || []).filter(rect => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height).map(rect => ({ source, area: rect.width * rect.height }))).sort((a, b) => a.area - b.area)[0]?.source;
}
export function correctLink(entry, ids, sources) {
  const known = new Set(sources.map(s => s.id));
  if (!Array.isArray(ids) || ids.some(id => !known.has(id))) throw new Error('Unknown source ID. Visit its page first, then copy the displayed ID.');
  entry.sourceIds = [...new Set(ids)]; entry.confirmed = false;
}
