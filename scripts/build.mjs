import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const version = '5.4.624';
const integrity = 'sm6TxKTtWv1Oh6n3C6J6a8odejb5uO4A4zo/2dgkHuC0iu8ZMAXOezEODkVaoVp8nX1Xzr+0WxFJJmUr45hQzg==';
await mkdir('.cache', { recursive: true });
const archive = `.cache/pdfjs-${version}.tgz`;
let bytes;
try { bytes = await readFile(archive); } catch {
  // curl honors the cloud environment's HTTPS proxy and certificate settings.
  execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--max-time', '120', '--output', archive + '.download', `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${version}.tgz`]);
  bytes = await readFile(archive + '.download');
}
if (createHash('sha512').update(bytes).digest('base64') !== integrity) throw new Error('PDF.js integrity mismatch; refusing to build.');
await writeFile(archive, bytes);
await rm('.cache/package', { recursive: true, force: true });
execFileSync('tar', ['-xzf', archive, '-C', '.cache']);
await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
for (const name of ['index.html', 'src']) await cp(name, `dist/${name}`, { recursive: true });
for (const name of ['build', 'web/pdf_viewer.css', 'cmaps', 'standard_fonts', 'wasm', 'LICENSE']) {
  await cp(`.cache/package/${name}`, `dist/vendor/${name}`, { recursive: true });
}
await writeFile('dist/.nojekyll', '');
console.log(`Built dist/ with integrity-verified PDF.js ${version}; no package installation required.`);
