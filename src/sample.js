// An original, synthetic paper. No personal or third-party PDF is distributed.
export const samplePages = [
  [
    'Reading Across Languages',
    'A small experiment in thoughtful research',
    'Parallel Research Notes | 2026',
    '',
    'Abstract',
    'Reading in another language is an act of interpretation.',
    'A bilingual workspace brings the original and its translation together.',
    'Sentence links help readers move between two perspectives.',
    '',
    '1. A workspace for understanding',
    'The original paper remains the primary source of evidence.',
    'Translations offer another route into the argument.',
    'Uncertain matches should be reviewed rather than treated as facts.',
    '',
    'Try it: select a sentence, highlight it, and write a note.',
    'Your observations stay in this browser until you export them.',
  ],
  [
    'Reading Across Languages',
    '2. Keeping a useful reading trail',
    '',
    'A good annotation connects a claim to a question.',
    'Local storage lets readers return to their observations.',
    'Markdown exports make those observations portable.',
    '',
    '3. Limits and care',
    'Text extraction does not always preserve the order of a paper.',
    'Multi-column layouts and scanned pages need additional care.',
    'A reader should always be able to check the original page.',
    '',
    'This sample was written for Parallel and contains no private data.',
  ],
];
export function samplePDF() {
  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const lines of samplePages) {
    const stream = 'BT /F1 12 Tf 50 735 Td 22 TL ' + lines.map((line, i) => `${i ? 'T* ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n') + ' ET';
    const contentId = objects.length + 2;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(output.length); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(output);
}
