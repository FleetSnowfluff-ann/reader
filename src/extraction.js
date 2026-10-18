// Geometry-based reading order, deliberately conservative around complex content.
// No model or semantic alignment is inferred here. All rectangles are page-normalized.
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)] || 12;
const abbreviations = /\b(?:Fig|Figs|Eq|Eqs|Sec|Secs|Dr|Prof|Mr|Mrs|vs|e\.g|i\.e|et al)\.$/i;

// Preserve existing annotation IDs when upgrading extraction. Only unique exact
// normalized quotes are mapped; ambiguity yields an unresolved anchor, never a guess.
export function recoverSourceAnchors(saved, items, viewport) {
  let stream = ''; const mapping = [], textItems = items.filter(i => typeof i.str === 'string');
  const add = (char, ref) => {
    if (/\s/.test(char)) { if (!stream || stream.endsWith(' ')) return; char = ' '; }
    stream += char; mapping.push(ref);
  };
  textItems.forEach((item, itemIndex) => {
    if (stream) add(' ', null);
    for (let offset = 0; offset < item.str.length; offset++) add(item.str[offset], { itemIndex, offset });
  });
  return saved.map(source => {
    const value = source.text.replace(/\s+/g, ' ').trim();
    const start = stream.indexOf(value);
    if (!value || start < 0 || stream.indexOf(value, start + 1) !== -1) return { ...source, rects: [], segments: [], warnings: ['Saved source anchor unresolved or ambiguous; verify the PDF and correct links manually'] };
    const segments = [];
    for (const ref of mapping.slice(start, start + value.length)) {
      if (!ref) continue;
      const last = segments.at(-1);
      if (last?.itemIndex === ref.itemIndex) last.end = ref.offset + 1;
      else segments.push({ itemIndex: ref.itemIndex, start: ref.offset, end: ref.offset + 1 });
    }
    const rects = segments.map(segment => {
      const item = textItems[segment.itemIndex];
      const [x0, y0, x1, y1] = viewport.convertToViewportRectangle([item.transform[4], item.transform[5], item.transform[4] + item.width, item.transform[5] + (item.height || 10)]);
      return { x: Math.min(x0, x1) / viewport.width, y: Math.min(y0, y1) / viewport.height, width: Math.abs(x1 - x0) / viewport.width, height: Math.abs(y1 - y0) / viewport.height };
    });
    return { ...source, segments, rects, warnings: [...new Set([...(source.warnings || []), 'Saved source IDs preserved after extraction update'])] };
  });
}

export function sentenceRanges(text) {
  const parts = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)];
  const result = [];
  for (const part of parts) {
    const previous = result.at(-1);
    if (previous && abbreviations.test(text.slice(previous.start, previous.end).trim())) previous.end = part.index + part.segment.length;
    else result.push({ start: part.index, end: part.index + part.segment.length });
  }
  return result;
}

export function extractPage(items, viewport, page) {
  let index = 0;
  const tokens = items.filter(item => typeof item.str === 'string').map(item => {
    const itemIndex = index++;
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle([item.transform[4], item.transform[5], item.transform[4] + item.width, item.transform[5] + (item.height || 10)]);
    return { text: item.str, itemIndex, x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), rotated: Math.abs(item.transform[1]) > .1 };
  }).filter(t => t.text.trim() && t.width > 0 && t.height > 0);
  if (!tokens.length) return { sources: [], warnings: ['No extractable text: scanned or empty page. OCR is not included.'], columns: 0 };
  const height = median(tokens.map(t => t.height));
  const rows = [];
  for (const token of [...tokens].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.findLast(r => Math.abs(r.y - token.y) < height * .45);
    if (row) row.tokens.push(token); else rows.push({ y: token.y, tokens: [token] });
  }
  const lines = [];
  for (const row of rows) {
    let line;
    for (const token of row.tokens.sort((a, b) => a.x - b.x)) {
      const gap = line ? token.x - (line.x + line.width) : 0;
      if (!line || gap > Math.max(height * 2.4, viewport.width * .035)) {
        line = { tokens: [], x: token.x, y: token.y, width: 0, height: token.height };
        lines.push(line);
      }
      line.tokens.push(token); line.width = token.x + token.width - line.x; line.height = Math.max(line.height, token.height);
    }
  }
  const midpoint = viewport.width / 2;
  const left = lines.filter(l => l.x + l.width < midpoint + viewport.width * .025 && l.width > viewport.width * .15);
  const right = lines.filter(l => l.x > midpoint - viewport.width * .025 && l.width > viewport.width * .15);
  const twoColumns = left.length >= 5 && right.length >= 5;
  const spanning = twoColumns ? lines.filter(l => l.x < midpoint - 20 && l.x + l.width > midpoint + 20) : [];
  const spans = new Set(spanning);
  // Full-width lines divide the page into bands; within each band read left then right.
  const ordered = [];
  let remaining = lines.filter(l => !spans.has(l));
  function appendBand(band) {
    band.sort((a, b) => twoColumns ? Number(a.x >= midpoint - 12) - Number(b.x >= midpoint - 12) || a.y - b.y || a.x - b.x : a.y - b.y || a.x - b.x);
    ordered.push(...band);
  }
  for (const full of spanning.sort((a, b) => a.y - b.y)) {
    appendBand(remaining.filter(l => l.y < full.y - height * .5));
    remaining = remaining.filter(l => l.y >= full.y - height * .5);
    ordered.push(full);
  }
  appendBand(remaining);
  const blocks = [];
  let block, last;
  for (const line of ordered) {
    const column = twoColumns && !spans.has(line) ? Number(line.x >= midpoint - 12) : -1;
    const separated = !last || column !== last.column || line.y - last.y > height * 1.9 || line.y < last.y || Math.abs(line.height - last.height) > height * .25;
    if (separated) { block = { lines: [], column }; blocks.push(block); }
    block.lines.push(line); last = { ...line, column };
  }
  const sources = [];
  for (const [blockIndex, group] of blocks.entries()) {
    let text = ''; const spans = [];
    for (const line of group.lines) for (const token of line.tokens) {
      if (text) text += ' ';
      spans.push({ start: text.length, end: text.length + token.text.length, token });
      text += token.text;
    }
    for (const range of sentenceRanges(text)) {
      const leading = text.slice(range.start, range.end).match(/^\s*/)[0].length;
      const trailing = text.slice(range.start, range.end).match(/\s*$/)[0].length;
      const start = range.start + leading, end = range.end - trailing;
      if (start >= end) continue;
      const segments = [], rects = [];
      for (const span of spans.filter(s => s.end > start && s.start < end)) {
        const from = Math.max(0, start - span.start), to = Math.min(span.token.text.length, end - span.start);
        segments.push({ itemIndex: span.token.itemIndex, start: from, end: to });
        rects.push({ x: (span.token.x + span.token.width * from / span.token.text.length) / viewport.width, y: span.token.y / viewport.height, width: span.token.width * (to - from) / span.token.text.length / viewport.width, height: span.token.height / viewport.height });
      }
      const value = text.slice(start, end);
      const warnings = [];
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/.test(value)) warnings.push('Unreliable character mapping; read the original PDF');
      if (!/[.!?。！？][”"')\]]?$/.test(value)) warnings.push('Fragment or heading; boundary needs review');
      if (/[=∑∫≤≥±√∂∈→]|(?:\b\d+\s+){3}|\b(?:Table|Figure)\s+\d/.test(value)) warnings.push('Formula, figure or table content; verify in PDF');
      if (segments.some(s => tokens.find(t => t.itemIndex === s.itemIndex)?.rotated)) warnings.push('Rotated text; order uncertain');
      sources.push({ id: `p${page}-s${sources.length + 1}`, page, text: value, segments, rects, block: blockIndex, column: group.column, warnings });
    }
  }
  if (sources.length) {
    sources[0].warnings.push('Page boundary: may continue the previous page');
    sources.at(-1).warnings.push('Page boundary: may continue on the next page');
  }
  return { sources, columns: twoColumns ? 2 : 1, warnings: [twoColumns ? 'Two-column order inferred from geometry; verify complex regions.' : 'Reading order inferred from geometry.', 'Equations and tables are preserved visually; extracted text may be incomplete.'] };
}
