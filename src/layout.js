// Conservative layout planning, independent of PDF.js and translation provider.
export function bounds(rects) {
  if (!rects?.length) return null;
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
}
export const intersects = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
export function planLayout(sources, translations) {
  // Sentence bounding boxes on the same printed line must be typeset together.
  // Geometry components split large extraction blocks at real paragraph gaps,
  // without changing a single existing source ID or quote.
  const groups = [];
  for (const source of sources) {
    const box = bounds(source.rects);
    const touching = groups.filter(rows => rows.some(s => intersects(bounds(s.rects), box)));
    const rows = [source, ...touching.flat()];
    for (const group of touching) groups.splice(groups.indexOf(group), 1);
    groups.push(rows.sort((a,b) => sources.indexOf(a)-sources.indexOf(b)));
  }
  return groups.map(rows => {
    const ids = new Set(rows.map(s => s.id)), box = bounds(rows.flatMap(s => s.rects || []));
    const targets = translations.filter(t => t.sourceIds.some(id => ids.has(id)));
    let reason = '';
    if (!box || rows.some(s => !s.rects?.length)) reason = 'Unresolved source geometry';
    else if (rows.some(s => s.warnings?.some(w => /Formula|Rotated|Unreliable|unresolved|ambiguous/.test(w)))) reason = 'Protected equation, figure, table or uncertain source';
    else if (targets.some(t => t.sourceIds.some(id => !ids.has(id)))) reason = 'Link spans separate source regions or pages';
    else if (rows.some(s => targets.filter(t => t.sourceIds.includes(s.id)).length > 1)) reason = 'Multiple translation versions: choose or edit in Reading Mode';
    else if (targets.some(t => { const ix = t.sourceIds.map(id => rows.findIndex(s => s.id === id)).sort((a,b) => a-b); return ix.some((n,i) => i && n !== ix[i-1]+1); })) reason = 'Noncontiguous source link';
    else if (sources.some(s => !ids.has(s.id) && s.rects?.some(r => intersects(box, r)))) reason = 'Source regions overlap';
    const emitted = new Set(), runs = [];
    for (const source of rows) {
      const target = targets.find(t => t.sourceIds.includes(source.id));
      if (target && emitted.has(target.id)) continue;
      if (target) emitted.add(target.id);
      runs.push({ source, target, text: target?.text || source.text });
    }
    return { sources: rows, targets, box, runs, reason };
  });
}
