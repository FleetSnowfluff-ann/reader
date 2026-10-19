# Reader validation

## Version 0.3 upgrade

Local cloud verification: **27 unit/security tests** and **21 browser scenarios** (22 runner tests including the parent), including two real academic papers. The browser suite adds genuine pointer hover in both directions, click lock, independent text selection, matched page geometry, scroll synchronization, mode switching, overflow continuation, cross-page keyboard undo/redo, direct editing, source-preserving translation changes, and whole-paper progress/budget/cache behavior.

The representative TraceMonkey page-4 paragraph is actually typeset in Chinese in its right-column source region. Tests verify its location and readable font, replacement of the source glyphs, and zero pixel changes to the other column. A protected page-8 formula remains identical in both canvases while its translation is available in continuation. Both Mirror and Reading modes share the real-paper translations.

Implementation `826e723` passed [Reader checks on Ubuntu 24.04 and Windows 2025](https://github.com/FleetSnowfluff-ann/reader/actions/runs/39201781491). Each platform ran syntax checks, 27 unit tests, the integrity-verified build and all 21 browser scenarios. The Windows regression exposed different CJK wrapping; bounded 1.30–1.45 line-height adaptation now fits the representative paragraph without shrinking its 12px font. Reflowed Chinese highlights use actual Chinese spans, not stale English rectangles. Editing a note also preserves Reading Mode's scroll position.

The DeepL/Turnstile/Cloudflare integration is tested with simulated responses and a transactional quota-store model. **No live provider request or Worker deployment is claimed**; account credentials have not been configured. See [activation and costs](TRANSLATION-PROXY.md) and [layout trade-offs](MIRROR-READER.md). The upgrade's production verification will be recorded after its deployment.

## Historical version 0.2 evidence

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
