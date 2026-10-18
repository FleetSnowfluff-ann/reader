# Privacy and security

Parallel is a static client application. Normal reading makes only same-origin requests for application files and PDF.js assets. It has no analytics, login, remote PDF loader, or automatic translation request. File bytes remain in memory. IndexedDB stores document fingerprints, names, extracted text, notes, and translation records. These are private browser data, not encrypted backups. Anyone with access to the browser profile may access them.

An optional translation request is a deliberate exception: after endpoint-specific consent, the currently displayed page's sentence IDs and text are sent to the selected HTTPS adapter. Cookies and authorization headers are not included. Do not enter API keys in the endpoint URL. Provider secrets must stay in your server's secure configuration; they must not appear in frontend source, GitHub Pages build variables, JSON imports, or commits.

Translation strings, filenames, and notes are rendered with `textContent`. Imported links are validated against known source IDs and start unreviewed. Markdown metacharacters and HTML delimiters are escaped in exports. Responses and imports have size limits. The Content Security Policy restricts scripts, workers, fonts, and other assets to the application origin, with blob workers and PDF font/image data as needed. HTTPS connections are allowed for explicit user-selected adapters. PDF.js is pinned and checked against a fixed SHA-512 at build time; neither TLS nor checksum verification is disabled. PDF JavaScript actions are not executed by this viewer.

Git ignores PDFs, `.env` files, private directories, note exports, build output, and test output. These patterns are a safeguard, not a secret scanner. Before any commit, inspect the staged files. Never submit personal documents or real notes as bug-report attachments. Use a synthetic reproduction. Dependencies should be reviewed and upgraded regularly; a pinned version is not a guarantee against future vulnerabilities.

For a suspected vulnerability, use GitHub's private vulnerability reporting if enabled. Otherwise contact the repository owner privately; do not post credentials or private papers in an issue.
