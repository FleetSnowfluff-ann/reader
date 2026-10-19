import { validateTranslations, validateEndpoint } from './core.js';
export async function requestTranslation({ endpoint, sources, consent, signal, challengeToken }) {
  if (!consent) throw new Error('Consent is required before sending text to a translation endpoint.');
  const url = validateEndpoint(endpoint);
  if (!sources.length) throw new Error('No extracted text to translate.');
  if (sources.some(s => s.warnings?.some(w => w.startsWith('Unreliable character mapping')))) throw new Error('This page has unreliable character mapping. Read the PDF and enter reviewed translations manually.');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000), body: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'zh-CN', sentences: sources.map(({ id, text }) => ({ id, text })), ...(challengeToken ? { challengeToken } : {}) }) });
  if (!response.ok) throw new Error(`Translation adapter returned HTTP ${response.status}. Check CORS and server configuration.`);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Translation response exceeds 2 MB.'); } chunks.push(value); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  const result = JSON.parse(new TextDecoder().decode(body));
  return validateTranslations(result.translations, sources).map(t => ({ ...t, provenance: { kind: 'machine', provider: result.provider === 'DeepL API Free' ? result.provider : 'Custom adapter', createdAt: Date.now() } }));
}
