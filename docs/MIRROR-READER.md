# Mirror and Reading: implementation and boundaries

## One immutable source, two projections

PDF.js remains the only PDF library. It renders the original page once. Mirror Mode copies that canvas into an identically sized Chinese paper surface, preserving untouched graphic pixels. It clones the selectable PDF text layer for untranslated regions, then lays out Chinese DOM text over conservatively selected text regions. This is an interactive **HTML companion page**, not a newly generated Chinese PDF. The source file is never modified or re-saved.

Reading Mode projects the same source IDs, translations, notes and selection into a comfortable reflowable view. Changing modes retains the page, zoom, locked sentence and each mode's scroll position. A reader can always switch back to the original-only PDF view. Small screens stack the paper surfaces and allow horizontal panning, rather than shrinking Chinese into illegible columns.

`extraction.js` owns source sentences and geometric provenance. `alignment.js` owns explicit links. `layout.js` groups intersecting sentence bounds without changing source IDs. `mirror.js` renders the companion and tests for protected ink. `translation.js` and `translation-job.js` own transport and jobs, independent of rendering. `history.js` owns document-scoped edit transactions. `annotations.js` and `storage.js` preserve portable data and browser persistence. The Worker is outside `src/` and `dist/`.

## What gets replaced—and what does not

- Sentences that share a printed line are laid out together so replacing one cannot cover the next. A group's runs retain the actual source IDs; multiple sentence links must be contiguous inside that region. There is no nearest-neighbor guess or sentence-position matching.
- Chinese uses a readable serif font, at least 12 CSS pixels at the normal zoom; enlarging zoom enlarges it. Text is never progressively shrunk to force a fit. Platform-dependent CJK wrapping may adjust line height from 1.45 down to a 1.30 minimum, without changing font size; this is counted as a spacing adjustment. Fitted groups keep the original column and paragraph location. They may extend by at most 1.2% of page height into verified blank space before the next source region; such spacing adjustments are counted in the page caption. Untranslated prose within a fitted group stays in English.
- The renderer measures the resulting text. If it overflows, or if multiple conflicting versions exist, the original region stays visible and full-size Chinese goes into a labeled **Continuation** below the paper. Cross-page and disjoint links also use continuation. Their exact source IDs remain clickable and editable.
- Formula/table/figure warnings, rotated/corrupt/unresolved source text, overlapping regions and detected nontext ink are protected. Raster inspection checks for residual ink outside known glyph boxes before permitting replacement. It is a conservative safeguard, not semantic image understanding; unusual background art or fonts can cause false positives.
- Accepted regions mask only their source glyph rectangles. Figures, equations, table grids and other unmodified pixels remain the original PDF raster. This preserves their appearance, **not** a translated table data model or editable mathematical typesetting. Some inline notation can still evade heuristic detection; check the original and use Reading Mode for difficult material.
- Many-to-many or manually corrected links remain explicit and unreviewed until the reader confirms them. Translation provenance (`machine`, `manual`, `corrected`, `imported`, legacy) and reader verification are separate. A provider's ordered output is not proof of semantic accuracy.

## Interaction and history

Hover is **translucent blue**, locked selection **green**, permanent highlights **gold**. Moving the pointer away clears only hover. Click/Enter locks a sentence; Unlock releases it. Text selection in either surface does not invoke a click selection. Source clicks locate the corresponding Chinese run or continuation. Normal paper scrolling and zoom are synchronized. Continuation scrolling may diverge from the source to keep a distant source reference usable; it is explicitly outside the mirrored paper.

Re-typeset Chinese highlights follow the actual Chinese text spans, not the previous English glyph rectangles. Arbitrary PDF text-selection annotations remain on the original surface: a partial English quotation has no guaranteed Chinese substring mapping. Sentence-anchored highlights can appear on both sides through their explicit source IDs.

The shared toolbar toggles a sentence highlight, removes its highlights, opens notes and edits the selected translation and source IDs. A note's Edit button opens an in-place-workflow editor; double-clicking an existing PDF annotation opens it directly. Deletion is immediate and undoable. `Ctrl+Z` / `Ctrl+Shift+Z` (or Cmd on macOS) and the toolbar undo/redo annotations, translation edits, removals, relinks and imported batches across page navigation. Native text-field undo is left intact. Stop a running translation job before undoing its batches.

History is in memory, independently per document, bounded to 60 transactions. It survives page/mode navigation and reopening within this session, not a page reload. Stored annotations themselves survive reload. Source extraction, source identifiers, reading progress and translation cache are not rolled back by editing history.

## Compatibility and research notes

The IndexedDB database and object store are unchanged. Existing document fingerprints, source IDs, notes and saved translations are retained. Legacy ambiguous source text is not silently reassigned. JSON backup schema/version **remain `parallel-notes` / 1**; fingerprint and Chinese-at-annotation-time are additive optional note fields. Existing version-1 backups still restore, append copies, and require translation review. New backups retain translation provenance but do not treat imported verification claims as trusted.

Each new annotation has the source PDF fingerprint, page, original English quotation, sentence IDs or normalized selection rectangles, and optional Chinese snapshot. Editing/replacing a translation cannot change those original references. Markdown includes a relative PDF link with `#page=N`, fingerprint, source IDs and a stable Obsidian block ID. Put the original PDF beside the exported Markdown in your vault, or adjust the relative link for your vault organization.

## Evidence

The browser suite first checks actual sample rendering, equal paper sizes, real-pointer hover in both directions, click lock, leaving a highlight, independent Chinese text selection, continuation overflow, synchronized scroll and mode switching. Keyboard tests undo/redo after navigating to another page; direct edits and old backups are exercised.

On TraceMonkey page 4, a reviewed four-sentence paragraph is laid out in the corresponding right column with readable Chinese. The test checks the actual DOM location/font size and verifies **zero changed pixels in the other column**. It also exercises Reading Mode using those same translations. A page-8 formula-region translation is relegated to continuation, and the companion canvas remains byte-identical to the original canvas. The corpus still tests full-width tables, genuine cross-page fragments, and the TAM review's corrupted character mappings. Source PDF bytes remain unchanged.

This is evidence for those cases, not a full-page semantic accuracy score or a claim that all academic layouts can be reproduced. No live DeepL request or Cloudflare deployment has been verified without account configuration; see [translation proxy activation](TRANSLATION-PROXY.md).
