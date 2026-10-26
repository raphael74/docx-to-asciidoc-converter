# AGENTS.md

Instructions for AI agents working in this repository.

## What this project is

A documentation pipeline. It takes every Word document (`*.docx`) in `source/`
(e.g. `Example 1.docx`) and publishes them as
a static HTML site using [Antora](https://antora.org). Each document becomes
its own Antora module.

The pipeline has four stages:

```
source/*.docx  --pandoc-->  destination/<name>/<name>.adoc  --build-antora.js-->  antora/modules/<module>/**  --Antora-->  build/site/**
```

## The one rule that matters most

**Everything except `source/` and the hand-edited code is generated output.**

| Path                                                                                  | Status                                                                                  |
|---------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| `source/*.docx`                                                                       | **Source of truth.** The only hand-edited input.                                        |
| `destination/`                                                                        | Generated (one folder per document: intermediate AsciiDoc + extracted images).          |
| `antora/modules/` (all modules, their `pages/`, `nav.adoc`, `images/`)                | Generated.                                                                              |
| `build/`                                                                              | Generated. Git-ignored.                                                                 |
| `convert-to-asciidoc.sh`, `build-antora.js`, `verify-links.js`, `antora-playbook.yml` | Hand-edited code.                                                                       |
| `antora/antora.yml`                                                                   | Hand-edited, **except its `nav:` list**, which `build-antora.js` rewrites on every run. |

Never fix a content problem by editing files under `destination` or
`antora/modules` — the next `yarn build` overwrites them. Change the
DOCX, or change the script that generates the file, instead.

## Commands

```sh
yarn install          # once
yarn build            # convert -> split -> build site -> verify (the full pipeline)
yarn preview          # build, then serve build/site/ in a browser
```

Individual stages, in order:

```sh
yarn convert          # source/*.docx -> destination/<name>/<name>.adoc + destination/<name>/media/ (pandoc)
yarn split            # destination/<name>/<name>.adoc -> antora/modules/<module>/ (build-antora.js)
yarn build:site       # Antora -> build/site/
yarn verify           # check every anchor and xref in every module resolves (verify-links.js)
yarn serve            # serve the already-built site
```

`yarn build` is the definition of "done": it must finish with
`All anchors and xrefs resolve correctly (N modules checked).` and no Antora
warnings. Always run it after any change to the scripts, the playbook, or a
DOCX.

## Environment requirements

- `pandoc` on `PATH` (the convert script fails fast if it is missing).
- Node.js 18+ / Yarn Classic 1.x. The version is pinned via `packageManager`
  in `package.json`, so corepack (bundled with Node) downloads the right
  Yarn on demand. **Use Yarn, not npm:** the project has a `yarn.lock` and
  deliberately no `package-lock.json`; running `npm install` would recreate
  one and drift from the committed lockfile.
- This directory **must remain a git repository.** Antora rejects a local
  content source that is not a git repo. Do not delete or re-initialise `.git`.
  The playbook uses `branches: HEAD`, so uncommitted working-tree files are
  used directly (Antora "author mode") — no commit needed before building.

## Output layout

```
destination/
└── <Document_Name>/
    ├── <Document_Name>.adoc
    └── media/                      # images extracted by pandoc

antora/
├── antora.yml                      # nav: list is maintained by build-antora.js
└── modules/
    ├── ROOT/                       # landing page linking to all documents
    │   ├── nav.adoc
    │   └── pages/index.adoc
    └── <module>/                   # one module per document
        ├── nav.adoc
        ├── images/
        └── pages/                  # index.adoc + one page per chapter
```

In the built site, `ROOT` is published at
`build/site/<component>/<version>/` and every other module in a sub folder of
that: `build/site/<component>/<version>/<module>/`.

## How the pipeline works

### 1. `convert-to-asciidoc.sh`

Loops over every `source/*.docx` (case-insensitive extension) and runs pandoc
(`--from docx --to asciidoc --wrap=none --extract-media .`) once per file. Each
document gets its own folder `destination/<name>/`, and pandoc runs from inside
that folder so image references stay relative (`media/imageN.png`). The folder
per document is what keeps `image1.png` of one document from overwriting
`image1.png` of another. Output per document is a single flat `.adoc` file plus
a `media/` folder. It is deliberately dumb: no post-processing. Keep it that
way.

### 2. `build-antora.js`

The core of the project. Discovers every `destination/<name>/<name>.adoc` and
produces one Antora module per document, plus a `ROOT` module. All per-document
state (heading plan, link targets, ToC numbering) lives inside
`convertDocument()`, so documents are processed in isolation and never
reference each other. The script starts by deleting `antora/modules` entirely.

For each document, in order, it:

1. **Splits** the document at every `== ` line into one page per top-level
   chapter, under `antora/modules/<module>/pages/`. Page file names are ASCII
   slugs (`asciiSlug`) and unique within the module (`index` is reserved for the
   landing page; duplicates get a `-2` suffix); anchors and cross-reference
   targets keep Unicode (`slugify`).
2. **Recovers chapter numbers** from the table of contents that pandoc leaves in
   the converted file (`link:#anchor[2.1 Title ...]`). Word's auto-numbering is
   lost from the headings themselves, but the ToC keeps it.
3. **Builds a heading plan** (`headingPlan`): for every heading, its final
   anchor and display label. One plan drives both the page bodies and the nav so
   they cannot disagree. Duplicate anchors on a page get a `-1`/`-2` suffix.
4. **Applies the plan** in `transformBody`: shifts heading levels down by one (the chapter title becomes the page's
   level-0 title), attaches explicit
   `[#anchor]` IDs, rewrites cross-references, and rewrites image paths. All
   pages of a document share one module, so xrefs need no module prefix.
4b. **Links square-bracket references.** It reads the document's `Referenzen`
   table, gives every row a `[[ref-<name>]]` anchor (replacing pandoc's broken
   `[#bookmark .anchor]##` markup, which renders as literal text), and rewrites
   each `++[++NAME++]++` in the body whose `NAME` matches a row to a link to
   that row. Existing Word hyperlinks to the old bookmark
   (`link:#BOOKMARK[++[++NAME++]++]`) are folded into the same link. If the
   references table is in the front matter instead of a `==`/`===` chapter, a
   standalone `Referenzen` page is generated for it so the links resolve.
5. **Generates** the module's `nav.adoc` (main pages only, under a `.Title`
   group heading), its `index.adoc` landing page, and copies
   `destination/<name>/media` into the module's `images/`.

Then, once for all documents, it:

6. **Generates the `ROOT` module**: a `nav.adoc` and an `index.adoc` that lists
   every document as `xref:<module>:index.adoc[Title]`.
7. **Updates `antora/antora.yml`.** Antora only picks up nav files that are
   listed there, so the `nav:` list is rewritten to contain `ROOT` plus every
   module. Everything else in an existing file is left untouched. If the file
   does not exist it is created from the `COMPONENT_*` constants.

**Module names** are the ASCII slug of the folder name, e.g.
`VG_T_Referenzarchitektur_Software_v5.7` →
`vg-t-referenzarchitektur-software-v5-7`. Duplicates get a `-2` suffix, and
`root` is reserved because it would clash with `ROOT` on case-insensitive file
systems.

**Document titles** (used for the nav group, the module's landing page, and the
ROOT landing page) come from, in priority order: the `DOC_TITLES` map at the top
of `build-antora.js` (keyed by folder name), the document's own level-0
`= Title` line, or the folder name. Add an entry to `DOC_TITLES` to give a new
document a proper display title.

A document with no `== ` chapters is skipped with a warning; the script only
fails if no document can be converted at all.

### 3. Antora + `verify-links.js`

Antora renders `antora/` to `build/site/`. `verify-links.js` then reads the
built HTML of every module and fails if any `xref:` (including the
module-qualified form `xref:module:page.adoc`) or `<<anchor>>` in any page or
`nav.adoc` points at a missing page or element ID. It reads the component name
and version from `antora/antora.yml` to locate the site folder. It exits
non-zero on failure, which fails `yarn build`.

## Conventions and constraints

- **ASCII file names, Unicode anchors.** Page file names and module names must
  be ASCII (`softwarearchitektur-fur-fachanwendungen.adoc`); heading IDs keep
  the original spelling (`für`, `ü`). This is intentional — do not "simplify"
  one to match the other.
- **One module per document.** Do not merge documents into a single module or
  add cross-document links in the generator; per-document isolation is what
  keeps anchors and images from colliding.
- **Anchors are pinned explicitly** with `[#anchor]` before each heading. This
  stops numbers or punctuation in a title from leaking into the ID and keeps
  duplicated titles from colliding.
- **Same-page references** are written as `<<anchor,label>>`. (The form
  `<<anchor>>[label]` is wrong: it renders a literal `[label]` after the link.)
- **`idprefix` / `idseparator` are load-bearing.** `antora-playbook.yml` sets
  `idprefix: ''` and `idseparator: '-'` so Asciidoctor's generated IDs match the
  slugs `build-antora.js` writes into xrefs. Changing these silently breaks
  every internal link (and will be caught by `yarn verify`).
- **Numbering scheme.** Chapter (page) titles keep the fixed numbers from the
  source document (1–8), stored in the heading plan. Section numbers inside a
  page are **not** stored — they come from Asciidoctor's `sectnums`, which
  restarts at 1 for each page, so a page's first section is `1`, its subsections
  `1.1`, `1.2`, and the next section `2`. If you touch numbering, keep these two
  mechanisms separate.
- **Navigation shows main pages only** (a module's landing page + its
  chapters). Do not add section/subsection entries back into a `nav.adoc`.
- **Style.** Plain Node.js (CommonJS, `require`), no build step, no
  dependencies beyond what `package.json` already lists. Match the existing
  comment style: explain *why*, especially for the pandoc workarounds.

## Known data quirks (do not "fix" blindly)

- Pandoc emits malformed figure captions like
  `.[#_Ref100587667 .anchor]####Abbildung : Übersicht`. `transformBody`
  normalises these to plain captions and drops the `_Ref…`/`_Toc…` bookmark
  targets. Asciidoctor numbers figures per page, restarting at 1 for every
  chapter page. Because the body text still carries Word's document-wide figure
  numbers ("Abbildung 25"), `transformBody` reads the document's
  `Abbildungsverzeichnis` to map bookmarks to figures, counts the figures per
  chapter to get their page-local number, and rewrites both linked and bare
  references. Table captions rely on `table-caption: Tabelle`; Word's own
  `Tabelle :` label is stripped.
- Pandoc sometimes emits a figure as an inline `image:` followed by its caption
  (Word anchored the image). `transformBody` promotes these to a block `image::`
  with the caption above it, so Asciidoctor renders a real figure. Some of those
  images sit in a two-column layout table that pandoc marked
  `options="header"`; because header cells are parsed as inline-only, the header
  option is dropped when the first cell contains an image.
- The same anchored image can appear twice: once inline in the paragraph and
  again as `{empty}[#_Ref… .anchor]####image:…` with the caption on the next
  block. `transformBody` folds that pair into a single block figure and drops
  the duplicate inline image, mapping both bookmarks to the same page-local
  figure number. Without this the `####` line renders as literal text, the
  caption is not counted as a figure and every later figure number on that page
  is off by one.
- Some document links point at Word bookmarks that no longer exist. These are
  reduced to their plain link text rather than left as broken links.
- The ToC does not list every heading (deeper levels and a few omissions), and
  it disambiguates repeated titles (`einleitung-1`, `einleitung-2`). The
  alignment logic in `build-antora.js` walks the ToC and the headings in
  document order to pair them; if you change that logic, re-run
  `yarn build` and confirm the "matched N of M ToC entries" warning (which
  names the affected document) does not appear.
- Non-ASCII characters in headings (e.g. the `🡪` arrow in some titles) can
  produce odd IDs. Pinned anchors already handle this; do not remove them.
- The numbering and cross-reference logic was developed against
  `VG_T_Referenzarchitektur_Software_v5.7.docx`. A newly added document may
  have a different ToC shape or bookmark naming, so check its warnings and
  built pages the first time it goes through the pipeline.

## Known security advisories (accepted risk — do not "fix" blindly)

- `yarn audit` (Yarn Classic uses the same advisory database as `npm audit`)
  reports **5 high-severity findings, all from one advisory**:
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
  (CVE-2026-93687) — `braces` through 3.0.3 is vulnerable to stack exhaustion
  from deeply nested brace patterns. It reaches us only via Antora's
  transitive dependencies (`content-aggregator`/`ui-loader` → `fast-glob` →
  `micromatch` → `braces`). (The finding count is per dependency path and
  differs between audit tools; it has always been this one advisory.)
- **Why it stays:** 3.0.3 is the latest published `braces`; the advisory
  affects *all* versions and upstream has released no fix, so no audit tool
  offers one. There is nothing to upgrade to, and pinning a
  fork of a transitive dependency would create more risk than the advisory
  itself.
- **Why it is acceptable here:** it is a build-time DoS in a devDependency.
  Triggering it requires the glob patterns fed to `braces` to be attacker
  controlled; every pattern in this pipeline comes from hand-edited repo
  files (the playbook, Antora internals), so anyone who could craft a
  malicious glob could already edit the build scripts directly. The
  published site and its readers are not affected at all.
- **What to do:** if a `braces` release **> 3.0.3** appears, upgrade and
  re-run `yarn audit` — the findings should disappear. Do not add Yarn
  `resolutions`, vendored copies, or patches for this advisory in the
  meantime; document-and-wait was a deliberate decision.

## Before you finish

1. `yarn build` — must print
   `All anchors and xrefs resolve correctly (N modules checked).`
2. Confirm Antora reported **zero** warnings (duplicate IDs and
   "section title out of sequence" both indicate a regression), and that the
   build printed no "matched N of M ToC entries" or "skipping" warnings you did
   not expect.
3. Spot-check one chapter page of each document in
   `build/site/software-referenzarchitektur/5.7/<module>/` for correct
   headings, numbering and images, and check that the landing page
   (`build/site/software-referenzarchitektur/5.7/index.html`) lists every
   document.
4. If you changed generated files, they are part of the diff — re-commit them
   rather than leaving the tree dirty.

## If you find something ambiguous

Ask before restructuring. The split-per-chapter layout, the one-module-per-document
layout, the ASCII/Unicode split for file names versus anchors, and the numbering
scheme were each deliberate decisions with trade-offs (documented in the commit
history). Surface the trade-off and offer options instead of silently changing
the approach.
