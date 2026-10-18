# Phase 1 validation

Validated in the Codex cloud environment on 2026-10-19 (Asia/Shanghai). No software or models were installed on the user's Windows PC.

## Executed checks

- Syntax checks: all source, test and build-script modules.
- Unit tests: **15 passed**, no failures or skips.
- Real Chromium browser scenarios: **16 passed** (17 runner tests including the parent), no failures or skips.
- Build: PDF.js 5.4.624 archive passed its fixed SHA-512 check; static output is approximately 6.4 MB.
- Browser suite is mounted at `/reader/`, matching the Pages project subpath.
- Both source PDF files were read before and after browser testing and remained byte-for-byte identical.

The scenarios exercise actual canvas pixels/text layers, PDF→Chinese and Chinese→PDF selection, sentence/PDF-selection highlights, note editing/deletion, page navigation/zoom, reload persistence, Markdown download, source JSON imports, manual link correction, mocked translation transport, no unconsented outbound requests, hostile HTML rendered as text, mobile layout, view modes, invalid/valid PDF uploads, fingerprint-checked JSON restoration and optional session-only storage.

## Real academic corpus

Only metadata, hashes and tests are committed. The PDFs and their screenshots are temporary cloud files and are excluded from source, Pages and CI artifacts. URLs and SHA-256 values are in `tests/papers.json`.

| Paper | Page | Extracted segments | Segments with warnings | Encoding warnings | All segments geometrically anchored |
| --- | ---: | ---: | ---: | ---: | --- |
| tracemonkey.pdf | 1 | 39 | 6 | 0 | yes |
| tracemonkey.pdf | 3 | 76 | 50 | 0 | yes |
| tracemonkey.pdf | 4 | 68 | 6 | 0 | yes |
| tracemonkey.pdf | 5 | 70 | 2 | 0 | yes |
| tracemonkey.pdf | 8 | 69 | 16 | 0 | yes |
| tracemonkey.pdf | 12 | 41 | 6 | 0 | yes |
| tam-review.pdf | 1 | 18 | 8 | 0 | yes |
| tam-review.pdf | 2 | 13 | 13 | 12 | yes |
| tam-review.pdf | 3 | 28 | 28 | 26 | yes |
| tam-review.pdf | 10 | 25 | 25 | 24 | yes |
| tam-review.pdf | 22 | 9 | 9 | 8 | yes |

### Grounded checks and observed limits

- **TraceMonkey (PLDI 2009), 14 pages:** sampled pages 1, 3, 4, 5, 8 and 12. Page 4's verified source sentence about recording intermediate values is extracted as a complete sentence in the right column, after the left-column prose. A manually supplied Chinese translation highlights only that actual right-column sentence. This checks content, reading order, and geometry rather than merely counting DOM elements.
- **Real cross-page continuation:** the object-representation sentence ends with `rep-` on page 4 and resumes with `resentations` on page 5. Both fragments remain separate and flagged. A test explicitly imports the two source IDs; the link appears on both pages and remains unreviewed. The app never silently joins it.
- **Mathematical expressions and tables:** page 8 algebraic expressions and page 12's performance table render in the unmodified PDF. Extracted numeric/table text is flagged. Table cells are not reconstructed into a trustworthy semantic table; the original remains authoritative.
- **TAM review (Chuttur, 2009), 23 pages:** sampled pages 1, 2, 3, 10 and 22, including its appendix table. The original renders, but several text mappings contain control characters/gibberish. Tests assert the warning; the adapter refuses automatic translation of these pages. This is a detected extraction limitation, not a claimed successful bilingual reconstruction.
- Every sampled segment has geometric anchors; that metric does **not** establish linguistic correctness. Multiple fonts, unusual layouts, headings and equations can still fragment sentences. No universal alignment accuracy percentage is claimed.

## Production and platform status

Implementation `c7dccc0` passed [Reader checks #5](https://github.com/FleetSnowfluff-ann/reader/actions/runs/39177486442) on **Ubuntu 24.04 and Windows 2025**, using Chrome. Each platform ran syntax checks, 15 unit tests, the integrity-verified build and all 16 browser scenarios, including both real academic papers (17 runner tests including the parent). Synthetic screenshots and numerical corpus metrics are attached to that run; source PDFs and real-paper screenshots are excluded.

The [Pages workflow](https://github.com/FleetSnowfluff-ann/reader/actions/runs/39177486413) completed successfully: build, deployment, and **verify-production**. The final job opened **https://fleetsnowfluff-ann.github.io/reader/** in a fresh Chrome profile on a GitHub-hosted runner and passed the 14 synthetic browser scenarios (15 runner tests including the parent). This verifies the actual deployed site, not only a local build. Real-paper tests run before deployment; they are not repeated against production.

The earlier CI failure was reproduced: passing a relative corpus filename to Chrome's file-upload protocol caused both academic-paper imports to time out. Resolving those paths to absolute paths fixed the same reproduction and both runner platforms. Failed assertions now appear as Actions annotations as well as logs. Pages was enabled by the repository owner before the successful deployment.

Direct access to the GitHub API and Pages hostname from this Codex environment still fails at the proxy's CONNECT stage with HTTP 403, before a GitHub HTTP response. Git access and github.com HTML access work; workflow status and the production-verification job were checked through those public run pages. Production browser verification therefore ran on GitHub, not through this blocked cloud proxy.

Firefox/Safari, Edge-specific behavior and a live translation provider remain unverified. The optional adapter is tested with an intercepted response, not a paid external translation request. Pages actions emitted Node.js 20 deprecation warnings while successfully running under GitHub's forced Node.js 24 compatibility mode; the application's checks use Node.js 22.
