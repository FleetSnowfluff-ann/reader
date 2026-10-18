# Parallel · 平行阅读

A private, browser-based English–Chinese academic paper reader. Open a PDF, read the original alongside linked translations, highlight passages, and keep a portable trail of research notes.

**No account, paid service, database server, or local package installation is required.** The app is a static site designed for GitHub Pages. Translation is pluggable; an AI provider is not bundled or required.

## Read a paper

1. Choose **Open PDF / 打开文献**, drag a PDF onto the reading desk, or try the included original sample paper.
2. Navigate pages, zoom, and switch between PDF, bilingual, and text views. The PDF has a selectable text layer.
3. Select an English sentence or Chinese translation to locate its linked counterpart. Multiple source sentences may link to one translation. Extracted reading order is approximate; always check the original for columns, equations, footnotes, and tables.
4. Use **＋ 中文** to enter a translation for a selected English sentence. Alternatively import explicit sentence links or use your own translation adapter.
5. Highlight an English sentence or select text directly on the PDF and choose **Highlight selection**. Add a note, edit it, or jump back to its page.
6. Export notes, quotes, page references, and bilingual pairs with **Export Markdown**.

PDF bytes are held in memory, not saved in the repository or uploaded. Notes, extracted page text, document names, and translations are saved in this browser's IndexedDB, keyed by a SHA-256 fingerprint of the file. Reopen the same PDF to recover them. The recent-paper list does not store your PDF. Browser data clearing, private browsing, a different device, or a different site origin can remove or isolate saved notes; export important work first. **Forget** deletes a paper's local notes and translations. Personal exports and PDFs are ignored by Git as an additional safeguard.

## Translation and alignment

The MVP deliberately does not infer semantic equivalence from sentence position. Imported and machine-generated links start **Unreviewed / 待核对**, regardless of any claimed confidence. Empty source IDs mean **Unaligned / 未对齐**. Unknown IDs are rejected, not silently substituted. Review the original and use **Confirm link**, **Mark uncertain**, or **Relink to selection**. Manually entered translations are marked user-confirmed because the reader explicitly supplies the link; this is not an accuracy guarantee.

Use **Translation → Export page source IDs** to obtain the current page's identifiers. Import a UTF-8 JSON array:

```json
[
  { "sourceIds": ["p1-s1"], "text": "对应第一句的中文译文。" },
  { "sourceIds": ["p1-s2", "p1-s3"], "text": "对应两句原文的合并译文。" },
  { "sourceIds": [], "text": "尚未确认对应原文的译文。" }
]
```

Imports apply to the current page, append to existing translations, and are limited to 2 MB and 2,000 entries per page. Plain arbitrary HTML is displayed as text.

### Optional server adapter

No API key is accepted or stored by this frontend. An optional HTTPS adapter keeps provider credentials on **your server**. Free/manual imports remain fully functional without one. This project does not provision a server, select a paid provider, or include a browser-side secret.

Set an HTTPS endpoint in **Translation**, check the consent box, then press **Translate current page**. Only that page's sentence IDs and extracted text are sent; the app does not include the PDF, document name, notes, or cookies. The endpoint is not persisted. Changing the endpoint clears consent. Requests time out after 30 seconds and redirects are rejected. You are responsible for trusting the endpoint and its retention policy.

Request: `POST /translate`, `Content-Type: application/json`:

```json
{
  "sourceLanguage": "en",
  "targetLanguage": "zh-CN",
  "sentences": [{ "id": "p1-s1", "text": "The original sentence." }]
}
```

Response:

```json
{
  "translations": [
    { "sourceIds": ["p1-s1"], "text": "原文对应的中文句子。" }
  ]
}
```

The adapter must handle CORS preflight and allow the exact deployed origin, `POST`, and the `Content-Type` header. It should impose request limits and rate limits, validate source IDs, and keep provider secrets out of responses and logs. Browser credentials are intentionally omitted; use a deployment-specific access design if your adapter needs authentication. A CORS allowlist is not authentication. See [SECURITY.md](SECURITY.md).

## GitHub development and deployment

Work in a feature branch and open a pull request into `main`. **Reader checks** runs on pushes and pull requests. It performs syntax checks, unit tests, an integrity-verified static build, and real headless Chromium integration tests. Screenshots of the synthetic demo are attached to CI runs. No personal documents are used in tests.

To publish after review:

1. In repository **Settings → Pages**, select **GitHub Actions** as the source.
2. Merge the reviewed implementation PR into `main`.
3. The **Deploy reader to GitHub Pages** workflow repeats validation and deploys only after it passes. Approve the `github-pages` environment deployment if your repository requires it.

Expected project URL: **https://FleetSnowfluff-ann.github.io/reader/**. This is a deployment target, not a claim that the site is already published. The authoritative deployed URL and status appear in the Pages workflow. Relative asset URLs support the `/reader/` project subpath. A private repository may require a GitHub plan supporting Pages; the application itself uses no paid service.

No provider keys, Pages tokens, or personal PDFs belong in Actions secrets or artifacts for this static workflow. GitHub's built-in Pages OIDC token is used for deployment, with write permissions limited to the deployment job.

## Optional cloud verification

Use the existing checkout; each cloud task is already isolated. Do not create a worktree unless explicitly requested. Node.js 22+, `curl`, `tar`, and Chromium/Chrome are sufficient. These commands do **not** run `npm install` or install system software:

```sh
npm run check
npm test
npm run build
npm run test:browser
npm start
```

The build downloads exactly PDF.js **5.4.624** from the npm registry, verifies its pinned SHA-512, and bundles its modules, worker, fonts, CMaps, WASM, and Apache-2.0 license into ignored `dist/`. Cached archives are reverified on every build. There is no runtime CDN dependency. The app is served on port 4173; `PORT` changes that port. `CHROME_BIN` can select an existing Chrome executable for browser tests. The server binds to loopback and is for development only.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/app.js` | PDF.js integration, reader state, bilingual links, annotation UI, consent-based adapter |
| `src/core.js` | Sentence extraction, explicit-link validation, endpoint validation, Markdown serialization |
| `src/storage.js` | IndexedDB transactions; writes resolve only when committed |
| `src/sample.js` | Original, generated two-page PDF fixture; no third-party paper |
| `scripts/build.mjs` | Pinned, checksum-verified PDF.js build without dependency installation |
| `tests/` | Node unit tests and real browser tests through the Chrome DevTools Protocol |

## MVP limits

- OCR is not included. Scans remain viewable and support page notes, but have no extracted sentences.
- Sentence boundaries and reading order are heuristic. Columns, hyphenation, mathematical expressions, and cross-page sentences may require manual review. Links are page-scoped; automatic semantic alignment and cross-page alignment are not implemented.
- There is no built-in translation model. Use manual translations, imported JSON, or a separately operated adapter. A mocked adapter is tested; no live provider is configured or validated.
- Notes are local to a browser and origin. Markdown export is a portable record, not a lossless restore format. Cloud sync and backup import are not included.
- Highlights and notes are stored as sidecar annotations; they are not embedded back into the PDF. Existing PDF forms, signatures, embedded attachments, and PDF annotations are not edited.
- Search covers the current page's extracted sentences and translations. PDF outlines, full-document search, and automatic citation extraction are future work.
- The desktop and mobile layouts are tested in Chromium. Current Firefox and Safari are intended targets but are not yet verified. No offline service worker is provided.
- PDFs are limited to 100 MB. The reader renders one page at a time; large files still require memory for parsing.
