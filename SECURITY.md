# Privacy and security

Parallel is a static client application. Normal reading makes only same-origin requests for application files and PDF.js assets. It has no analytics, login, remote PDF loader, or automatic translation request. File bytes remain in memory. IndexedDB stores document fingerprints, names, extracted text, notes, and translation records. These are private browser data, not encrypted backups. Anyone with access to the browser profile may access them.

An optional translation request is a deliberate exception: after endpoint-specific consent, the selected page or paper's sentence IDs and text are sent to the selected HTTPS adapter. Cookies and authorization headers are not included. Do not enter API keys in the endpoint URL. Provider secrets must stay in your server's secure configuration; they must not appear in frontend source, GitHub Pages build variables, JSON imports, or commits.

Translation strings, filenames, and notes are rendered with `textContent`. Imported links are validated against known source IDs and start unreviewed. Markdown metacharacters and HTML delimiters are escaped in exports. Responses and imports have size limits. The Content Security Policy restricts scripts, workers, fonts, and other assets to the application origin, with blob workers and PDF font/image data as needed, plus an explicit Turnstile script/frame origin for consented proxy translation. HTTPS connections are allowed for explicit user-selected adapters. PDF.js is pinned and checked against a fixed SHA-512 at build time; neither TLS nor checksum verification is disabled. PDF JavaScript actions are not executed by this viewer.

Git ignores PDFs, `.env` files, private directories, note exports, build output, and test output. These patterns are a safeguard, not a secret scanner. Before any commit, inspect the staged files. Never submit personal documents or real notes as bug-report attachments. Use a synthetic reproduction. Dependencies should be reviewed and upgraded regularly; a pinned version is not a guarantee against future vulnerabilities.

For a suspected vulnerability, use GitHub's private vulnerability reporting if enabled. Otherwise contact the repository owner privately; do not post credentials or private papers in an issue.

The browser can use session-only mode instead of persisting new data. JSON backup import requires the open PDF fingerprint, validates references and rectangles, and verifies source text against the PDF before updating state. Restored translations remain unreviewed. Extracted text with suspicious control characters is explicitly flagged and blocked from automatic translation.


## Optional automatic translation proxy

The separately deployed Worker uses DeepL API Free only. Provider secrets live in Cloudflare/GitHub secret storage, never in the static build. Exact-origin checks, hostname/action-validated Turnstile and atomic global/per-IP character quotas bound abuse; CORS alone is not authentication. No source PDF, filename, fingerprint or notes enter its request body. The Worker stores only quota counters and daily salted IP hashes; translation caching is browser-local. Provider/platform retention is separate from our code. Live service activation is pending account configuration. See [TRANSLATION-PROXY.md](docs/TRANSLATION-PROXY.md).
