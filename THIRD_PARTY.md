# Third-party components and research references

The website includes **PDF.js 5.4.624**, Copyright Mozilla Foundation, under **Apache License 2.0**. The build copies the distribution's complete LICENSE into `dist/vendor/LICENSE`. Its fonts, CMaps and WASM are copied from the same integrity-verified distribution. PDF.js is unmodified; the app uses its public rendering/text APIs. There is no second PDF engine.

Readest, PDFMathTranslate, BabelDOC, ParaRead, EasyRead and Zotero Better Notes were evaluated as described in [docs/RESEARCH.md](docs/RESEARCH.md). No application code or assets from those projects are bundled. This change does not assign a new license to the repository's own code.

Real academic PDFs listed in `tests/papers.json` are downloaded temporarily from an immutable upstream revision for validation. Their copyright/license statements remain applicable. They are not committed, modified, bundled, or uploaded in CI artifacts. Test report metadata and independently written assertions are the only corpus material included in the source repository.
