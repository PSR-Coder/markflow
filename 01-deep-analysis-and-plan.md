# MarkFlow Deep Analysis And Product Plan

Audit date: 2026-09-11
Repository: `/home/sfvdnnu/saas/markflow`

This document is the current product plan, not a claim that every proposed feature already exists. Implemented behavior is separated from hypotheses, planned work, and validation gaps.

## Executive Assessment

MarkFlow already has a credible local-first Markdown editor MVP. Its strongest differentiator is not the generic toolbar or split preview; it is the unusually deep table workflow:

- spreadsheet-style table editing without replacing the Markdown source of truth
- TSV paste and copy-out
- row/column operations with undo/redo
- header promotion with Replace/Move semantics
- alignment-aware Markdown serialization
- contextual row/column insertion controls
- semantic inline formatting inside cells
- sorting and view-only filtering
- local images, snapshots, and client-side export

The project is further along than the old `v0.1` plan suggests, but it is not yet a hardened product. The main gap is no longer “add more controls.” The main gap is trust:

1. Can a user safely edit complex Markdown without syntax corruption?
2. Can a user recover every document and attachment after browser loss or export/import?
3. Can a user predict exactly what will change before a large table or formatting operation is committed?
4. Does the experience remain reliable on mobile, offline, large documents, and assistive technology?

The next phase should therefore be a **trust and differentiation phase**, not a feature-count phase.

## Product Position

> MarkFlow is a local-first Markdown editor that makes the dangerous parts of Markdown visual, reversible, and portable.

The wedge is:

- **Tables without syntax anxiety** for writers who move between Markdown and spreadsheets.
- **Formatting without delimiter anxiety** for users who want visual controls but still need real Markdown output.
- **Portable ownership** for users who do not want their documents or attachments trapped in a hosted editor.

This is a more defensible position than competing broadly with Typora, Notion, HackMD, or VS Code on every axis.

## What The Current Code Actually Delivers

### Editing and preview

Implemented in `src/editor.ts`, `src/main.ts`, `src/toolbar.ts`, and `src/core/renderer.ts`:

- CodeMirror 6 Markdown source editing
- Source, Split, and Preview modes
- proportional source/preview scroll synchronization in Split mode
- Markdown-it rendering with tables, task lists, footnotes, linkify, headings, code highlighting, KaTeX, and Mermaid
- heading slug generation and in-preview anchor navigation
- task-list checkbox clicks that update the source Markdown
- inline Bold, Italic, Strike, Code, and Link actions
- line commands for headings, lists, blockquotes, code blocks, rules, images, and tables
- context-aware disabling of commands inside code and table contexts

Not implemented:

- a Typora-like Live mode with stable source decorations
- a block editor or contenteditable WYSIWYG surface
- true collaborative editing
- target-platform renderer profiles

### Table editor

Implemented in `src/core/tables.ts` and `src/tableEditor.ts`:

- escape-aware, fence-aware table parsing
- internal matrix model with `rows[0]` as header and separate alignments
- auto-padded and aligned Markdown serialization
- column letter bar and row-number gutter
- cell, row, column, multi-row, multi-column, and all-table selection
- sticky operations bar and expandable editor window
- Insert Row/Column buttons and contextual corner-hotspot controls
- contextual controls restricted to the correct gutter elements
- percentage-based, rectangle-clipped row/column hotspot geometry
- resize grips with priority over insertion controls
- Enter/Tab/Shift+Tab/arrow navigation
- duplicate, move, clear, delete, promote-to-header, sort, filter, paste, copy, and cut operations
- snapshot undo/redo inside the table editor
- view-only column filtering
- editor-only row-height and column-width resizing
- semantic formatting in cells and bulk formatting across selections

Current contextual-control contract:

- Row `+`: `.te-num` only; top-left inserts above, bottom-left inserts below.
- Column `+`: `.te-letter` only; top-left inserts before, top-right inserts after.
- Current radius is `25%` of the smaller gutter-cell dimension.
- The valid area is the actual cell rectangle intersected with the corner circle.
- There is no generic edge-band or full guide line.
- The control is circle-only and recomputes intent from current pointer coordinates.

Not implemented or deliberately deferred:

- rectangular drag selection
- Ctrl/Cmd+A table-local selection
- drag-to-reorder
- merged cells
- per-cell alignment
- portable multi-line GFM cells
- table formulas or proprietary schema storage

### Semantic inline formatting

Implemented in `src/core/inlineFormatting.ts`, with both `src/toolbar.ts` and `src/tableEditor.ts` using the shared engine:

- nested Bold/Italic/Strike/Code marks
- partial visible-text selections
- independent removal and reapplication of nested marks
- link-label formatting without changing link destinations
- protected code spans, images, math, HTML, escaped characters, and Markdown block syntax
- active, inactive, and mixed mark states
- bulk mixed-selection semantics: apply missing marks; remove only when all eligible text has the mark
- preservation of empty cells without marker junk

This is a significant improvement over the earlier adjacent-delimiter approach. It is still a custom inline parser, not a full CommonMark AST transformation. That distinction matters for unusual nesting, malformed Markdown, extensions, and future syntax.

### Persistence and library

Implemented in `src/core/storage.ts`, `src/library.ts`, and `src/main.ts`:

- Dexie/IndexedDB documents, snapshots, and assets
- debounced document autosave
- document create, select, rename, duplicate, delete, and search
- named snapshots through Ctrl/Cmd+S
- quiet three-minute auto-snapshots only when content has changed since load or the previous snapshot
- newest-40 snapshot retention per document
- pre-restore safety snapshot
- restore and snapshot download
- backup ZIP containing documents and referenced asset blobs

Important limitations:

- browser quota/storage failures now show a retryable save state; Library Tools reports counts, quota estimates, persistent-storage state, connectivity, and pending-save state, with an explicit protection request where supported
- versioned backup import/restore now exists as duplicate-as-new, and ordinary ZIPs containing `.md` files can import as documents without snapshot/asset metadata
- deleting a document now removes assets unreachable from remaining documents and snapshots; the Assets manager can inspect and delete remaining orphans
- attachment-bearing Markdown ZIP exports now rewrite known references to standard `assets/...` paths; missing blobs remain visible and standalone artifact tests are still needed
- “unlimited documents” is constrained by browser storage quota

### Images and export

Implemented in `src/core/images.ts` and `src/exporter.ts`:

- paste/drop/upload image ingestion
- IndexedDB blob storage
- `attachment:<id>` Markdown references
- object URL preview resolution
- missing-asset fallback
- standalone image captions via `figure`/`figcaption`
- Markdown export, ZIP export when attachments exist, standalone HTML with embedded images, and browser-print PDF
- three print themes: GitHub, Serif, Minimal
- selectable PDF text and no server-side document processing

Limitations:

- no visual image resize handles
- backup import exists and portable Markdown ZIP references now use `assets/...`; artifact verification and offline scenarios remain
- PDF is a print workflow, not a generated file artifact that can be automatically inspected in tests

### PWA, settings, and quality

Implemented or configured:

- PWA manifest and Workbox service worker
- auto-update registration
- dark/light themes
- preview HTML and single-newline settings
- keyboard shortcut help
- modal stack that makes nested dialogs Escape-safe
- aria labels and semantic controls across much of the UI

Validation gaps:

- the browser suite is a large script rather than a structured test runner
- CI runs TypeScript, pure tests, production build, and Chromium/Firefox/WebKit plus mobile smoke suites on Node 20; broader device/browser coverage remains
- the CI smoke suite now verifies service-worker readiness, offline reload, cached app boot, IndexedDB content recovery, and the Offline local-only status; the top bar reports cache readiness, updating, updated, or unavailable states; broader browser/update failure matrices remain
- no manual screen-reader audit
- no full WCAG contrast report; key light-theme contrast is checked in browser smoke
- reduced-motion CSS support now exists; no visual audit has been performed
- no measured 1 MB document or large-table performance budget
- mobile shell smoke exists; no full touch table interaction suite
- export artifact fixtures now cover portable Markdown ZIP, standalone HTML, and generated print HTML; browser print and rendered-asset artifacts remain untested

### Horizon 0 progress: parser and table contracts

The first trust-hardening tranche is now implemented:

- `npm test` is available through Vitest.
- `test/inlineFormatting.test.ts` covers nested marks, partial selections, active-state queries, protected links/code/math/images/HTML/escapes, and Markdown block structure.
- `test/tables.test.ts` covers escaped pipes, fenced-code exclusion, alignment parsing, padded serialization, ragged rows, single-column tables, and header-only tables.
- The parser preserves fenced code blocks as opaque source ranges instead of treating their fences as inline code.

Current evidence is still M3/M4 rather than M5: browser compatibility, mobile, and failure-mode matrices remain open.

The deterministic artifact and CI tranche is now also implemented:

- `test/exportArtifacts.test.ts` verifies portable Markdown ZIP entries, relative attachment paths, standalone HTML escaping/styles, and print HTML generation.
- `test/backup.test.ts` also verifies ordinary ZIP import for multiple `.md` files.
- `.github/workflows/ci.yml` runs `tsc`, `npm test`, and `npm run build` on Node 20.
- Node 20 is scoped to CI; the project does not declare a runtime engine change and local development remains unchanged.

### Horizon 0 progress: save reliability

Autosave now has a visible failure path:

- IndexedDB save failures remain in the editor instead of becoming unhandled promise rejections.
- Likely quota/storage failures show a more specific message.
- A Retry save action is exposed until persistence succeeds.
- Reconnection retries a pending save.
- Failed drafts are stored locally per document and offered for restore or recovered-copy creation on the next load; legacy single-draft data is migrated.
- Offline status is shown separately from the Saved/dirty state so local editing remains available.
- Automatic snapshots check every three minutes but only create a snapshot after content changes; opening a document and leaving it idle does not create snapshots.
- History, backup, import, and attachment cleanup are grouped under the sidebar Library Tools dropup.

Browser quota enforcement stress tests, service-worker rollout failure matrices, and multi-browser validation remain open; quota estimates and persistent-storage state are surfaced when the browser provides them.

### Horizon 0 progress: recovery package

The next recovery slice is now implemented:

- Backup ZIPs carry a versioned `manifest.json`.
- Documents, snapshots, and referenced assets are included with metadata.
- The library has an Import action that validates the manifest before restoring.
- Imported documents and assets receive new IDs, and `attachment:<id>` references are rewritten safely.
- Missing attachment references are reported after import instead of failing silently.
- Deleting a document removes assets that are no longer reachable from remaining documents or snapshots.

The Import action also accepts ordinary ZIPs containing `.md` files; those imports create documents without MarkFlow snapshot/asset metadata. Remaining recovery work is quota estimation, durable failed-save queuing, and offline validation. Export artifact coverage and the first CI workflow are now in place.

## Review Of The Original Plan

### What was strong

1. **The wedge was correct.** Tables, images, export, and local-first persistence are real pain points and are a better starting point than generic rich text.
2. **The architecture is appropriately small.** CodeMirror, markdown-it, Dexie, Vite, and framework-free DOM code keep the application understandable and local-first.
3. **The plan valued portability.** Client-side rendering, Markdown source ownership, and export freedom are strategically important.
4. **The plan recognized mode stability.** Source/Split/Preview is a sensible current product choice while Live mode remains unproven.
5. **The table roadmap was product-specific.** Header promotion, TSV paste, column alignment, and source serialization are more valuable than decorative spreadsheet imitation.

### What was stale or overstated

| Original claim | Corrected interpretation |
|---|---|
| “Three stable modes: Source, Split, Live” | Source, Split, and Preview exist. Live mode is not implemented. |
| “Full keyboard shortcuts” | Core shortcuts exist, but table-local selection, Home/End, touch, and full accessibility navigation are incomplete. |
| “Smart images” | Paste/drop/upload and export work; resize, cleanup, import, and portable paths are missing. |
| “Real library” | IndexedDB CRUD/search/history exists; folders, import, quota health, and recovery are missing. |
| “Offline” | PWA assets are configured for caching; actual offline boot/edit/save behavior is not proven. |
| “Beautiful PDF export” | Three client-side print themes exist; the user still performs Save as PDF and artifact tests are missing. |
| “MVP complete” | Core MVP is functional, but hardening and portability are not complete enough for a production maturity claim. |
| “Table editor solved” | Desktop table workflows are strong; touch selection, large-scale performance, source diff, and complex Markdown fixtures remain. |
| “AI is the next accelerator” | AI should follow trust, portability, and privacy foundations. It is not the next highest-value gap. |

### Missing decision gates in the original plan

The plan needs explicit gates before calling a phase complete:

- **Portability gate:** export a document with images, tables, math, Mermaid, links, and footnotes; re-open it outside MarkFlow; no silent data loss.
- **Recovery gate:** delete/reload/browser-offline scenarios; restore a backup into a clean profile.
- **Markdown safety gate:** formatting and table operations preserve valid block structure and protected inline syntax.
- **Accessibility gate:** keyboard-only workflow, focus order, contrast, and screen reader labels; ~~reduced-motion support~~ is implemented but still needs visual verification.
- **Performance gate:** defined budgets for startup, typing latency, preview render, 1 MB documents, and wide/long tables.
- **Mobile gate:** touch-only completion of writing, formatting, table insertion, and export.
- **Trust gate:** large operations show a clear scope and, where appropriate, a source diff before Apply.

## Revised Product Principles

1. **Visual editing must be reversible.** Every structural or formatting action should be undoable and explain its scope.
2. **Markdown remains the source of truth.** UI state such as widths, filters, and selection never silently becomes proprietary document metadata.
3. **Portability beats convenience when they conflict.** If a representation cannot survive export to ordinary Markdown, the UI must explain the limitation.
4. **Protected syntax is never guessed over.** Code, links, math, images, HTML, tables, and block prefixes need explicit parser boundaries.
5. **No silent normalization.** Canonicalization should be an explicit action with a before/after view.
6. **Local-first means recoverable, not merely local.** Backup import, asset integrity, and storage health are part of the feature.
7. **Touch is a first-class input.** Hover-only affordances need visible or long-press equivalents.
8. **A feature is not mature until it has failure evidence.** Happy-path browser screenshots are not enough.

## Revised Roadmap

### Horizon 0: Trust Hardening

Goal: make the current MVP safe to rely on.

**Completion status: implementation complete; maturity validation in progress.** The deterministic parser, export, recovery, cleanup, retry-save, property coverage, storage health, accessibility semantics, and Node 20 CI workflow are implemented/configured. Production hardening still requires the CI matrix to pass, plus storage-pressure, service-worker rollout, human accessibility, touch, and performance validation.

1. ~~Add CI on Node 20+ and run both pure tests and the browser suite.~~ Configured for Chromium, Firefox, WebKit, and a mobile viewport on Node 20; the current local Node 18 environment cannot execute that matrix.
2. ~~Expand the pure tests with property-based and malformed-input cases.~~ Done with bounded fast-check generators and malformed-input safety contracts:
   - inline formatting parse/toggle/serialize
   - nested and partial marks
   - links, code, math, images, HTML, escapes
   - headings, lists, fences, rules, and table structure
   - table parse/serialize round trips
3. ~~Add export artifact tests for Markdown, ZIP, HTML, and generated print HTML.~~ Pure artifact contracts are implemented; browser print and rendered-asset artifacts remain.
4. ~~Add backup import with manifest validation and conflict handling.~~ Done as duplicate-as-new restore; merge conflicts remain intentionally unsupported.
5. ~~Rewrite attachment references during portable Markdown export.~~ Done for attachment-bearing Markdown ZIP exports with standard `assets/...` paths; missing blobs remain visible.
6. ~~Add a visible asset reference scan and orphan cleanup.~~ Done with the Assets manager and deletion reachability cleanup; storage health and offline validation remain.
7. ~~Add offline boot/edit/save/update tests.~~ The smoke suite covers offline service-worker boot/reload and local document recovery; rollout/update failure scenarios remain.
8. ~~Add failed-save retry and browser-quota messaging.~~ Retry, likely quota/storage messaging, and a multi-document durable recovery queue are implemented; quota stress remains.
9. Add keyboard-only, screen-reader, full contrast, and reduced-motion audits; automated key-control checks exist.
10. Add a full touch table workflow audit; the current mobile check covers shell overflow and primary controls only.

Exit condition: a user can edit, export, delete, restore, and reopen a document with no silent data loss.

### Horizon 1: Product Differentiation

Goal: own the “Markdown without anxiety” category.

1. **Markdown Confidence panel** — initial read-only diagnostics shipped
   - malformed table detection
   - unclosed emphasis/code/strike detection
   - broken link and missing attachment detection
   - heading hierarchy warnings
   - duplicate heading ID warnings
   - unsupported HTML and portability warnings
   - the current panel reports local line/column findings and does not fetch remote URLs
   - one-click safe fixes with a source diff remain part of the next repair slice
2. **Source Diff Before Apply** — table-editor review shipped
   - table editor shows exact Markdown changes before commit
   - formatting actions inside the table editor are included in the same review, including multi-cell operations
   - version history offers a snapshot Diff action with explicit Keep current and Restore this version decisions
   - version history supports unified and side-by-side comparison, automatic large-change selection, line numbers, synchronized scrolling, and collapsible unchanged context
   - comparison panes wrap long Markdown lines, support responsive stacking, a draggable split, maximize/restore, sticky controls, All/Diff/Same filtering, Prev/Next diff navigation, and persistent unchanged-context expansion until explicitly hidden
   - snapshots matching the live editor show as Current version with download only; ordinary and pre-restore snapshots deduplicate against the newest persisted content
   - the main source toolbar still uses CodeMirror undo/redo directly and does not open a separate diff modal
   - user can return to the grid without losing uncommitted work
3. **Portable Document Package** — package schema 2 shipped
   - `.markflow.zip` manifest
   - Markdown files with relative asset paths
   - assets, snapshots, settings, and a version/schema identifier
   - import into a clean browser profile, including legacy schema 1 package compatibility
4. **Renderer Matrix**
   - GitHub/GFM profile
   - CommonMark profile
   - Reddit-like single-newline profile
   - optional GitLab/dev.to profiles where behavior is known
   - side-by-side difference warnings, not fake claims of perfect parity
5. **Table Intelligence**
   - column type hints: text, number, date, URL, status
   - safe fill series and normalization tools
   - duplicate/blank/header health checks
   - CSV/TSV import and export with explicit preview
   - “table is portable” report for unsupported content
6. **Touch-first table actions**
   - persistent add controls in the table toolbar
   - long-press insertion menu
   - bottom formatting/action bar on narrow screens
   - no essential hover-only workflow
7. **Clipboard bridge**
   - rich HTML/Google Docs paste to clean Markdown with preview
   - Copy as Markdown, TSV, and sanitized rich HTML
   - preserve tables, links, emphasis, and images according to an explicit conversion report

Exit condition: a new user can paste messy content, repair it visually, inspect the source diff, and export a portable package confidently.

### Horizon 2: Integrations And Review

Goal: extend reach without compromising local ownership.

- optional File System Access API adapter
- GitHub open/save/commit adapter with explicit conflict resolution
- DOCX export with a documented fidelity matrix
- comments and suggestions stored in a sidecar review file, never hidden in the Markdown body
- shareable read-only packages with no required hosted document storage
- BYOK AI actions that operate on selected text locally in the UI and disclose every outbound request
- custom export themes and template gallery

### Horizon 3: Collaboration, Only If Demand Supports It

- Yjs/Hocuspocus or equivalent CRDT collaboration
- encrypted rooms and explicit ownership
- comments/suggestions with author and resolution state
- offline merge conflict UI
- collaborative table editing with operation-level intent

Collaboration should not be pulled forward merely because competitors offer it. It changes the privacy, hosting, conflict, and pricing model substantially.

## New Standout Features

These are deliberately different from a generic “add AI, add templates, add collaboration” roadmap.

### 1. Markdown Confidence

A visible trust layer that answers: “Will this render and export the way I expect?” It combines diagnostics, scope explanations, and safe repairs. This is a natural extension of the current table and inline-formatting work.

Why it stands out: most Markdown editors expose syntax; few explain the consequences of syntax or offer reversible repairs.

### 2. Portable Package As A First-Class File

Treat a document plus images, snapshots, settings, and a manifest as one portable package. Import must work in a clean profile and report missing or conflicting assets.

Why it stands out: local-first becomes a real ownership promise instead of “the data happens to be in IndexedDB.”

### 3. Source Diff For Visual Actions

Before applying a multi-cell table operation, show the exact Markdown diff. For formatting, show the semantic change rather than only the visual result.

Why it stands out: it makes visual editing acceptable to technical writers, reviewers, and Git users.

### 4. Markdown Render Matrix

Let users compare the same document under known rendering profiles and flag divergences such as single newlines, raw HTML, tables, task lists, and footnotes.

Why it stands out: portability is usually discovered after publishing; MarkFlow could make it visible before publishing.

### 5. Table Health And Portability Report

A table can report:

- missing or duplicate headers
- empty header cells
- inconsistent numeric/date values
- escaped-pipe risks
- unsupported multiline or merged-cell expectations
- alignment and source serialization changes

Why it stands out: this adds spreadsheet confidence without turning Markdown into a proprietary database.

### 6. Safe Formatting With Provenance

Show why a toolbar action changed a cell: “Bold applied to 14 visible characters; code span and link URL skipped.” Keep the action undoable and optionally expose the source diff.

Why it stands out: it turns invisible parser decisions into understandable behavior.

### 7. Recovery Center

A small local-only control panel showing:

- last successful save
- pending save failure
- storage usage estimate
- last backup timestamp
- snapshot count
- orphan assets
- export/import verification status

Why it stands out: it addresses the least glamorous but most trust-sensitive part of browser editors.

### 8. Focused Mobile Command Surface

Instead of shrinking the desktop toolbar, provide a mobile action tray with formatting, insert, table, image, and undo actions. Table row/column controls should be persistent or long-press based.

Why it stands out: mobile is where hover-dependent Markdown tools usually collapse.

### 9. Review Sidecar

Comments and suggestions live in a `.markflow.review.json` sidecar keyed to stable text anchors, while the Markdown file remains clean. Export can include or exclude review data.

Why it stands out: it adds review workflows without polluting or locking the Markdown document.

### 10. Intent-Aware Paste

When pasted content looks like a spreadsheet, rich document, URL list, or Markdown table, show a compact conversion choice and a preview of the resulting Markdown. Never silently turn arbitrary tab-separated text into a table.

Why it stands out: paste is the bridge between the real world and Markdown, and it is usually where users lose control.

## Architectural Direction

Keep the current framework-free architecture for the next phase. The code is small enough that a premature React or ProseMirror migration would create risk without solving the immediate trust gaps.

Recommended boundaries:

- `core/inlineFormatting.ts`: semantic inline parsing and transformations; add pure fixtures and property tests.
- `core/tables.ts`: parse/serialize contract; add golden round trips and explicit portability diagnostics.
- `core/storage.ts`: add manifest/import, asset reachability, quota/error states, and schema versioning.
- `core/images.ts`: add asset lifecycle and portable path mapping.
- `exporter.ts`: separate content transformation from download UI; test generated artifacts without a browser.
- `main.ts`: keep coordination thin; move diagnostics and recovery state into focused modules.
- `tableEditor.ts`: preserve the matrix model, but introduce source diff previews before larger operations.

Avoid storing product-only table metadata inside Markdown unless it has an explicit, portable representation. Widths, filters, selection, and editor-only layout should remain ephemeral.

## Success Metrics

The next roadmap should measure outcomes, not number of buttons:

- 0 silent content-loss cases in parse/edit/serialize fixtures
- 100% successful backup export/import in a clean browser profile
- no orphan assets after documented delete/cleanup flows
- offline edit and reload succeeds in supported browsers
- table insertion/formatting completed by keyboard-only users
- mobile table workflow completes without hover
- 1 MB document typing and preview latency within a declared budget
- export fixtures preserve headings, tables, images, math, links, and footnotes
- users can explain the Markdown diff produced by a visual operation

## Non-Goals

To keep the product coherent, do not prioritize:

- a general-purpose Notion database layer
- proprietary table formulas that cannot export to Markdown
- hidden Markdown transformations with no diff or undo
- hosted collaboration before local recovery is trustworthy
- AI calls by default or without explicit data disclosure
- a full contenteditable editor before the stable source/preview model proves insufficient
- image resizing syntax that is not portable to the selected Markdown target

## Decision Summary

MarkFlow should move from “feature-maximal MVP” to “trustworthy visual Markdown.” The table editor is already the strongest wedge. The next competitive advantage should be the combination of:

1. semantic, reversible visual editing
2. Markdown Confidence diagnostics
3. source diffs for visual operations
4. truly portable document packages
5. table health and renderer portability reports
6. mobile and offline reliability

That combination is more distinctive, more defensible, and more aligned with the current code than chasing every feature offered by hosted collaboration editors.
