import { readFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const directory = process.env.REAL_PAPERS_DIR || '.cache/papers';
await mkdir(directory, { recursive: true });
for (const paper of JSON.parse(await readFile(new URL('../tests/papers.json', import.meta.url), 'utf8'))) {
  const file = `${directory}/${paper.file}`;
  try { await readFile(file); } catch { execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '90', '--output', file, paper.url]); }
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== paper.sha256) { await rm(file); throw new Error(`Integrity mismatch for ${paper.file}`); }
  console.log(`Verified temporary research fixture: ${paper.file}`);
}
