#!/usr/bin/env node
/**
 * Converts every pandoc-generated AsciiDoc document found in the destination
 * folder (destination/<name>/<name>.adoc, created by convert-to-asciidoc.sh)
 * into its own Antora module:
 *
 *   antora/modules/<module>/pages/    one page per top-level chapter + index.adoc
 *   antora/modules/<module>/images/   the document's extracted media
 *   antora/modules/<module>/nav.adoc  navigation of the document
 *
 * Additionally a ROOT module with a landing page that links to all documents
 * is generated, and the `nav:` list of antora/antora.yml is kept in sync.
 *
 * Cross-references and figure anchors are normalized per document. Each
 * document is processed in isolation, so documents never reference each
 * other and anchors/images cannot collide.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DEST_DIR = path.join(ROOT, 'destination');
const ANTORA_DIR = path.join(ROOT, 'antora');
const MODULES_DIR = path.join(ANTORA_DIR, 'modules');
const DESCRIPTOR_FILE = path.join(ANTORA_DIR, 'antora.yml');

// Only used when antora/antora.yml does not exist yet and has to be created.
const COMPONENT_NAME = 'referenzarchitekturen';
const COMPONENT_VERSION = '5.7';
const COMPONENT_TITLE = 'Referenzarchitekturen';

const SITE_TITLE = 'Dokumentation';

/**
 * Optional display titles for documents, keyed by the folder name in
 * destination/. Documents not listed here use their own level-0 title (if the
 * AsciiDoc has one), otherwise the folder name.
 */
const DOC_TITLES = {
    'VG_T_Referenzarchitektur_Software_v5.7':
        'Software-Referenzarchitektur für Individual-Fachanwendungen',
    'VG_T_Referenzarchitektur_Integration_v4.1.1':
        'Integrations-Referenzarchitektur für Fachanwendungen'
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lowercase, hyphenate a heading title the same way Antora/Asciidoctor does. */
function slugify(text) {
    return text
        .replace(/<[^>]+>/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Like slugify, but transliterates to ASCII so it is safe to use in file
 * names and URLs (Antora page and module names should be ASCII).
 */
function asciiSlug(text) {
    return slugify(text)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
        .replace(/ß/g, 'ss')
        .replace(/æ/g, 'ae')
        .replace(/œ/g, 'oe')
        .replace(/[^\x00-\x7F]/g, '') // drop any remaining non-ASCII
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}

function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
}

function rmrf(target) {
    fs.rmSync(target, {recursive: true, force: true});
}

/** Returns `base`, or `base-2`, `base-3`, ... if it is already in `used`. */
function uniqueName(base, used) {
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    return name;
}

// ---------------------------------------------------------------------------
// Reference table ("Referenzen") and square-bracket references
// ---------------------------------------------------------------------------

/**
 * A document's "Referenzen" chapter lists reference names in square brackets in
 * the first column of a table (e.g. `[SI-ARCH]`). The same names appear in the
 * body as `++[++SI-ARCH++]++`, which pandoc uses to escape the brackets.
 *
 * The first column is the target for those body references, so every row gets
 * an explicit anchor. Pandoc's own anchor markup (`[#bookmark .anchor]##`) is
 * not valid AsciiDoc and currently renders as literal text, so it is replaced
 * by the `[[anchor]]` form. The `ref-` prefix keeps these anchors from
 * colliding with heading anchors.
 */
const REFERENCE_SECTION_RE = /^={2,6}\s+(?:\d+(?:\.\d+)*\s+)?Referenzen\s*$/i;
const REFERENCE_PARAGRAPH_RE = /^\*Referenzen\*\s*$/i;
const REFERENCE_ANCHOR_PREFIX = 'ref-';

/**
 * Finds the references table, rewrites its first-column anchors in `lines`, and
 * returns the reference name -> { anchor, page } map plus the table extent.
 * When the section is in the front matter (no chapter page yet), a "Referenzen"
 * page is added to `chapters` so the links have somewhere to point.
 */
function extractReferences(lines, chapters, usedBases) {
    const sectionStart = lines.findIndex(
        (line) => REFERENCE_SECTION_RE.test(line) || REFERENCE_PARAGRAPH_RE.test(line)
    );
    if (sectionStart === -1) return null;

    const tableStart = lines.findIndex((line, i) => i > sectionStart && /^\|===\s*$/.test(line));
    if (tableStart === -1) return null;

    let tableEnd = -1;
    for (let i = tableStart + 1; i < lines.length; i++) {
        if (/^\|===\s*$/.test(lines[i])) {
            tableEnd = i;
            break;
        }
    }
    if (tableEnd === -1) return null;

    const refs = new Map();
    const usedAnchors = new Set();

    for (let i = tableStart + 1; i < tableEnd; i++) {
        const line = lines[i];
        if (!line.startsWith('|') || !line.includes('++[++')) continue;

        // Drop pandoc's `[#bookmark .anchor]##` prefix (which also swallows the
        // opening `##` of its inline span) and put a real anchor in its place.
        const withoutAnchor = line.replace(/\[#[^\s\]]+\s*\.anchor\]#*/g, '');
        const m = /^\|\s*\+\+\[\+\+(.+?)\+\+\]\+\+/.exec(withoutAnchor);
        if (!m) continue;

        const name = m[1].trim();
        if (!name) continue;

        let anchor = `${REFERENCE_ANCHOR_PREFIX}${asciiSlug(name)}`;
        if (anchor === REFERENCE_ANCHOR_PREFIX) anchor = `${REFERENCE_ANCHOR_PREFIX}${i}`;
        if (usedAnchors.has(anchor)) {
            let n = 2;
            while (usedAnchors.has(`${anchor}-${n}`)) n++;
            anchor = `${anchor}-${n}`;
        }
        usedAnchors.add(anchor);

        refs.set(name, {anchor});
        lines[i] = withoutAnchor.replace(/^(\|\s*)/, `$1[[${anchor}]]`);
    }

    if (refs.size === 0) return null;

    let chapter = chapters.find((c) => sectionStart >= c.startLine && sectionStart < c.endLine);
    if (!chapter) {
        // A front-matter reference section is not covered by any chapter, and
        // the pipeline only publishes chapters. Give it its own page so the
        // linked table entries exist in the built site.
        chapter = {
            index: chapters.length + 1,
            startLine: sectionStart,
            endLine: tableEnd + 1,
            title: 'Referenzen',
            base: uniqueName(asciiSlug('Referenzen') || 'referenzen', usedBases),
            number: null,
            anchor: slugify('Referenzen'),
            synthetic: true,
        };
        chapters.push(chapter);
    }

    for (const entry of refs.values()) entry.page = chapter.base;
    return {refs, tableStart, tableEnd, chapter};
}

/** Builds a link to a reference table row, keeping the square brackets visible. */
function referenceLink(name, chapterBase, refs) {
    const entry = refs.get(name);
    if (!entry) return null;

    const label = `++[++${name}++]++`;
    if (entry.page === chapterBase) return `<<${entry.anchor},${label}>>`;
    return `xref:${entry.page}.adoc#${entry.anchor}[${label}]`;
}

/**
 * Rewrites bracketed reference names in `lines` to links to their row in the
 * references table. Handles both bare references (`++[++SI-ARCH++]++`) and
 * pandoc's wrappers around Word hyperlinks
 * (`link:#SIARCH[++[++SI-ARCH++]++]`,
 * `++[++link:#SW_ARCH[SW-ARCH]++]++`). Existing hyperlinks whose label is a
 * reference name are folded in as well. The table itself is left untouched.
 */
const REFERENCE_LINK_RE =
    /(?:\+\+\[\+\+link:#[^\s\[]+\[([^\[\]]+)\]\+\+\]\+\+|link:#[^\s\[]+\[\+\+\[\+\+([^\[\]]+)\+\+\]\+\+\]|\+\+\[\+\+([^\[\]]+)\+\+\]\+\+|link:#[^\s\[]+\[([^\[\]]+)\])/g;

function linkifyReferences(lines, chapters, refs, tableStart, tableEnd, frontMatterPage) {
    for (let i = 0; i < lines.length; i++) {
        if (i > tableStart && i < tableEnd) continue; // the references table itself

        const chapter = chapters.find((c) => i >= c.startLine && i < c.endLine);
        const pageBase = chapter ? chapter.base : frontMatterPage;
        if (!pageBase || (!lines[i].includes('++[++') && !lines[i].includes('link:#'))) continue;

        lines[i] = lines[i].replace(REFERENCE_LINK_RE, (match, wrapped, worded, bare, plain) => {
            const name = (wrapped || worded || bare || plain || '').trim();
            return referenceLink(name, pageBase, refs) || match;
        });
    }
}

// ---------------------------------------------------------------------------
// Discover the documents to convert
// ---------------------------------------------------------------------------

/** Finds destination/<name>/<name>.adoc for every sub folder of destination/. */
function discoverDocuments() {
    if (!fs.existsSync(DEST_DIR)) {
        console.error(`Error: destination folder not found: ${DEST_DIR}`);
        console.error('Run ./convert-to-asciidoc.sh first.');
        process.exit(1);
    }

    const docs = [];
    const entries = fs
        .readdirSync(DEST_DIR, {withFileTypes: true})
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const dir = path.join(DEST_DIR, entry.name);
        const adoc = path.join(dir, `${entry.name}.adoc`);
        if (!fs.existsSync(adoc)) {
            console.warn(`Warning: skipping ${path.relative(ROOT, dir)} (no ${entry.name}.adoc inside)`);
            continue;
        }
        docs.push({name: entry.name, dir, adoc, mediaDir: path.join(dir, 'media')});
    }

    if (docs.length === 0) {
        console.error(`Error: no converted documents found in ${DEST_DIR}`);
        console.error('Run ./convert-to-asciidoc.sh first.');
        process.exit(1);
    }
    return docs;
}

// ---------------------------------------------------------------------------
// Convert one document into one Antora module
// ---------------------------------------------------------------------------

/**
 * Splits one AsciiDoc document into chapter pages and writes the complete
 * module `moduleName`. Returns { title, chapterCount }, or null if the
 * document has no chapters.
 */
function convertDocument(doc, moduleName) {
    const moduleDir = path.join(MODULES_DIR, moduleName);
    const pagesDir = path.join(moduleDir, 'pages');
    const imagesDir = path.join(moduleDir, 'images');
    const srcDocx = `${doc.name}.docx`;

    const source = fs.readFileSync(doc.adoc, 'utf8');
    const lines = source.split(/\r?\n/);

    // Document title: configured, else level-0 title of the AsciiDoc, else name.
    const level0 = lines.map((l) => /^= (\S.*)$/.exec(l)).find(Boolean);
    const docTitle =
        DOC_TITLES[doc.name] || (level0 ? level0[1].trim() : doc.name.replace(/_/g, ' '));

    // Chapter boundaries: lines starting with '== ' (level-1 chapters).
    const chapterStarts = [];
    lines.forEach((line, i) => {
        if (/^== \S/.test(line)) chapterStarts.push(i);
    });

    if (chapterStarts.length === 0) {
        console.warn(`Warning: no chapters ("== ") found in ${doc.name}.adoc, skipping this document.`);
        return null;
    }

    // -------------------------------------------------------------------------
    // Build the ID map: original link target -> page file
    // -------------------------------------------------------------------------

    /**
     * Map of reference target -> page base name, so cross-references can be
     * rewritten. Targets are both the ToC anchor and the title slug, because
     * pandoc links use whichever the original document used.
     */
    const targetToPage = new Map();

    function registerHeading(title, pageBase, anchor) {
        const slug = slugify(title);
        const keys = [slug, anchor ? slugify(anchor) : null].filter(Boolean);
        for (const key of keys) {
            if (!targetToPage.has(key)) targetToPage.set(key, pageBase);
        }
    }

    // -------------------------------------------------------------------------
    // Recover the original section numbering from the generated table of
    // contents. Word's automatic heading numbers were dropped by pandoc, but the
    // ToC lines still carry them in document order:
    //   `link:#anchor[2.1 Title link:#anchor[8]]`.
    // -------------------------------------------------------------------------

    /** The ToC entries in document order: { anchor, number, title }. */
    const tocEntries = [];

    for (const line of lines) {
        const m =
            /^\s*link:#([^\s\[]+)\[(\d+(?:\.\d+)*)\s+([^\]]*?)(?:\s+link:#[^\[]+\[\d+\])?\]\s*$/.exec(
                line
            );
        if (!m) continue;
        tocEntries.push({anchor: m[1], number: m[2], title: m[3].trim()});
    }

    // -------------------------------------------------------------------------
    // Recover the original figure numbering from the figure index.
    // Word numbers figures document-wide (1..N), and the body text refers to
    // those numbers ("Abbildung 25"). Most captions lost their number during
    // conversion, but the "Abbildungsverzeichnis" entries still carry it:
    //   link:#_Ref123[Abbildung 5: Title link:#_Ref123[40]]
    // The bookmark target is the same one the caption and its references use.
    // -------------------------------------------------------------------------

    /** Map of figure bookmark target -> original document-wide figure number. */
    const figureNumbers = new Map();

    for (const line of lines) {
        const m =
            /^\s*link:#([^\s\[]+)\[Abbildung\s+\*?(\d+)\*?(?=[:\s]).*link:#\1\[\d+\]\]\s*$/.exec(
                line
            );
        if (m) figureNumbers.set(m[1], m[2]);
    }

    // The ToC lists chapters and level 3/4 headings (source `==`, `===`,
    // `====`), but not the deeper level 5/6 headings, and it occasionally omits a
    // heading. The two lists are aligned by walking them in order and matching
    // titles, which also resolves duplicate titles that the ToC disambiguates
    // with -1/-2 suffixes.
    const numberedHeadingLines = [];
    for (const [i, line] of lines.entries()) {
        if (/^={2,4} \S/.test(line)) numberedHeadingLines.push(i);
    }

    const normalizeTitle = (s) =>
        s.replace(/&#44;/g, ',').replace(/\s+/g, ' ').trim().toLowerCase();
    const stripLeadingNumber = (s) => s.replace(/^[0-9]+(?:\.[0-9]+)*\s+/, '').trim();

    /** Map of heading line number -> { anchor, number }. */
    const numberingByLine = new Map();

    {
        let ai = 0; // index into numberedHeadingLines
        for (const entry of tocEntries) {
            const wanted = normalizeTitle(entry.title);
            // Scan ahead for the heading this ToC entry belongs to. Headings with no
            // ToC entry (omitted titles) are passed over and left unnumbered here.
            while (ai < numberedHeadingLines.length) {
                const lineNo = numberedHeadingLines[ai];
                const headingTitle = stripLeadingNumber(lines[lineNo].replace(/^=+ /, '').trim());
                if (normalizeTitle(headingTitle) === wanted) {
                    numberingByLine.set(lineNo, {anchor: entry.anchor, number: entry.number});
                    ai++;
                    break;
                }
                ai++;
            }
            if (ai >= numberedHeadingLines.length) break;
        }

        if (numberingByLine.size !== tocEntries.length) {
            console.warn(
                `Warning (${doc.name}): matched ${numberingByLine.size} of ${tocEntries.length} ` +
                `ToC entries to headings; the rest keep automatic numbering.`
            );
        }
    }

    // Page names must be unique within the module, and `index` is reserved for
    // the landing page.
    const usedBases = new Set(['index']);
    const chapters = chapterStarts.map((startLine, idx) => {
        const endLine = idx + 1 < chapterStarts.length ? chapterStarts[idx + 1] : lines.length;
        const rawTitle = lines[startLine].slice(3).trim();
        const base = uniqueName(asciiSlug(rawTitle) || `chapter-${idx + 1}`, usedBases);
        const numbering = numberingByLine.get(startLine);
        return {
            index: idx + 1,
            startLine,
            endLine,
            title: rawTitle,
            base,
            number: numbering ? numbering.number : null,
            anchor: numbering ? numbering.anchor : slugify(rawTitle),
        };
    });

    // Asciidoctor numbers figures per page, restarting at 1 for every chapter
    // page. Body references have to use those same page-local numbers, so walk
    // the figures in document order per chapter and remember where each
    // bookmark ends up.
    /** Map of figure bookmark target -> { page, number } (page-local number). */
    const figureLocations = new Map();

    for (const ch of chapters) {
        let number = 0;
        for (let i = ch.startLine; i < ch.endLine; i++) {
            const m = /\[#([A-Za-z0-9_.:-]+)\s+\.anchor\]#{2,6}Abbildung\b/.exec(lines[i]);
            if (!m) continue;
            number++;
            figureLocations.set(m[1], {page: ch.base, number});

            // Pandoc sometimes writes the figure's image on a separate
            // `{empty}` line with its own bookmark, directly above the caption
            // (see the normalization in transformBody). Both bookmarks refer to
            // the same figure, so map the image bookmark to the same number.
            for (let j = i - 1; j >= ch.startLine; j--) {
                if (lines[j].trim() === '') continue;
                const imageAnchor =
                    /\[#([A-Za-z0-9_.:-]+)\s+\.anchor\]#{2,6}image:/.exec(lines[j]);
                if (imageAnchor) figureLocations.set(imageAnchor[1], {page: ch.base, number});
                break;
            }
        }
    }

    /** Map of original document-wide figure number -> bookmark target. */
    const figureAnchorByNumber = new Map();
    for (const [anchor, number] of figureNumbers) figureAnchorByNumber.set(number, anchor);

    // The references table is also a source of links for the body: every
    // bracketed reference name is linked to its row. This runs before the
    // heading plan so a front-matter references section can add a page.
    const references = extractReferences(lines, chapters, usedBases);

    // Build a single plan for every heading: its final anchor and display label.
    // Using one plan for the page body and the navigation keeps them consistent.
    //
    // Chapter numbers are kept fixed (the Word document's numbering), while the
    // sections inside a page are numbered automatically by Asciidoctor's
    // `sectnums`, which restarts at 1 for every page. Headings that the ToC does
    // not cover still get an anchor; if that anchor is already used on the same
    // page it is disambiguated with a -1/-2 suffix.
    const headingPlan = new Map(); // source line number -> { anchor, label, title, level, isChapter }

    for (const ch of chapters) {
        const usedAnchors = new Set();
        const planHeading = (lineNo, isChapter) => {
            const m = /^(={2,6}) (.+)$/.exec(lines[lineNo]);
            if (!m) return;
            const title = m[2].trim();
            const numbering = numberingByLine.get(lineNo);
            let anchor = numbering ? slugify(numbering.anchor) : slugify(title);
            if (usedAnchors.has(anchor)) {
                let n = 1;
                while (usedAnchors.has(`${anchor}-${n}`)) n++;
                anchor = `${anchor}-${n}`;
            }
            usedAnchors.add(anchor);
            // Only the chapter (page) title keeps an explicit number; section numbers
            // are left to Asciidoctor.
            const label = isChapter && numbering ? `${numbering.number} ${title}` : title;
            headingPlan.set(lineNo, {anchor, label, title, level: m[1].length, isChapter});
        };
        planHeading(ch.startLine, true);
        for (let i = ch.startLine + 1; i < ch.endLine; i++) planHeading(i, false);
    }

    // Register every heading (with its owning page) so cross-references can be
    // rewritten. Both the ToC anchor and the display title are registered,
    // because pandoc links use whichever the original document used.
    for (const ch of chapters) {
        const chapterHeading = headingPlan.get(ch.startLine);
        registerHeading(ch.title, ch.base, chapterHeading ? chapterHeading.anchor : undefined);
        for (let i = ch.startLine + 1; i < ch.endLine; i++) {
            const heading = headingPlan.get(i);
            if (!heading) continue;
            registerHeading(heading.title, ch.base, heading.anchor);
        }
    }

    // Link square-bracket references in the body to the table rows found above.
    // This has to happen after the heading plan is built (so the `Referenzen`
    // page is known) and before the pages are written (they slice `lines`).
    if (references) {
        linkifyReferences(
            lines,
            chapters,
            references.refs,
            references.tableStart,
            references.tableEnd,
            references.chapter.synthetic ? references.chapter.base : null
        );
    }

    // -------------------------------------------------------------------------
    // Transform a chapter body
    // -------------------------------------------------------------------------

    /**
     * Rewrites the document-wide figure number in a reference label
     * ("Abbildung 25" / "Abbildung *1*") to its page-local number, keeping any
     * emphasis markers around the number.
     */
    const renumberFigureLabel = (label, number) =>
        label.replace(/^(\s*Abbildung\s+)(\*?)\d+(\*?)/i, (match, prefix, open, close) =>
            `${prefix}${open}${number}${close}`
        );

    function transformBody(body, chapter, bodyStartLine) {
        let text = body;

        // 0. Shift section levels down by one, because the chapter title itself
        //    becomes the page's level-0 document title. `=== X` -> `== X`.
        text = text.replace(/^(={3,6})(?= )/gm, (m) => m.slice(1));

        // 0b. Apply the planned number and anchor to each heading. The plan is
        //     built once (see headingPlan) so the page body and the navigation
        //     agree.
        const bodyLinesArr = text.split('\n');
        for (const [offset, line] of bodyLinesArr.entries()) {
            const m = /^(={1,6}) (.+)$/.exec(line);
            if (!m) continue;
            const plan = headingPlan.get(bodyStartLine + offset);
            if (!plan) continue;
            bodyLinesArr[offset] = `[#${plan.anchor}]\n${m[1]} ${plan.label}`;
        }
        text = bodyLinesArr.join('\n');

        // 0c. Pandoc writes an image that Word anchored to a paragraph twice: as
        //     an inline image in the paragraph and again on a separate `{empty}`
        //     line that carries the bookmark plus a `####` marker:
        //       {empty}[#_Ref123 .anchor]####image:./media/image9.png[...]
        //
        //       [#_Toc456 .anchor]####Abbildung : Title
        //     The `####` line is not valid AsciiDoc, so it would render as
        //     literal text and the caption would be attached to the following
        //     paragraph instead of an image. That also desynchronises the
        //     per-page figure numbering. Turn the pair into a real figure and
        //     drop the duplicate inline image from the paragraph.
        const cleanCaption = (caption) =>
            caption.replace(/^(?:Abbildung|Tabelle)\b\s*(?:\d+\s*)?:?\s*/i, '').trim();

        const promotedFigureAnchors = [];

        text = text.replace(
            /^\{empty\}\[#([A-Za-z0-9_.:-]+)\s+\.anchor\]#{2,6}image:([^\s\[]+)\[([^\]]*)\][^\n]*\n(?:\s*\n)*\[#[A-Za-z0-9_.:-]+\s+\.anchor\]#{2,6}((?:Abbildung|Tabelle)\b[^\n]*)$/gm,
            (match, anchor, path, attrs, caption) => {
                promotedFigureAnchors.push(anchor);
                const cleaned = cleanCaption(caption);
                return cleaned ? `.${cleaned}\nimage::${path}[${attrs}]` : `image::${path}[${attrs}]`;
            }
        );

        for (const anchor of promotedFigureAnchors) {
            const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // The inline copy may still be wrapped in a Word hyperlink; drop the
            // whole link (including its nested image attribute brackets).
            text = text.replace(
                new RegExp(`link:#${escaped}\\[image:(?:[^\\[\\]]|\\[[^\\]]*\\])*\\]\\s*`, 'g'),
                ''
            );
        }

        // 1. Normalize pandoc's broken figure caption blocks. Pandoc emits e.g.
        //      .[#_Ref100587667 .anchor]####Abbildung : Übersicht ...
        //    or
        //      [#_Ref347235091 .anchor]####Abbildung 5: Übersicht ...
        //    as an anchor + a "####" that should be a caption. Rewrite to a plain
        //    caption paragraph.
        //
        //    Word keeps the caption's own "Abbildung"/"Tabelle" prefix (with an
        //    optional number and colon). Asciidoctor prepends the configured
        //    figure/table caption and a generated number, so keeping the prefix
        //    would render it twice. Strip only the leading prefix; the actual
        //    title (and any trailing footnote) stays.
        text = text.replace(
            /^\.?\[#([A-Za-z0-9_.:-]+)\s+\.anchor\]####(.+)$/gm,
            (match, _id, caption) => {
                const cleaned = cleanCaption(caption);
                return cleaned ? `.${cleaned}` : '';
            }
        );
        // Any remaining stray "####"/"###" inline caption markers.
        text = text.replace(
            /^\.?\[#([A-Za-z0-9_.:-]+)\s+\.anchor\](#{2,6})(.+)$/gm,
            (match, _id, _hashes, caption) => {
                const cleaned = cleanCaption(caption);
                return cleaned ? `.${cleaned}` : '';
            }
        );
        text = text.replace(/^(#{2,6})(?=\S)/gm, '');

        // 1a. Plain captions that pandoc already emitted correctly (no
        //     anchor/hashes) can still carry Word's own label, e.g.
        //     ".Tabelle : Clientseitige Technologien". Strip it here as well so
        //     the generated caption is the only one.
        text = text.replace(/^\.((?:Abbildung|Tabelle)\b[^\n]*)$/gm, (match, caption) => {
            const cleaned = cleanCaption(caption);
            return cleaned ? `.${cleaned}` : '';
        });

        // 1b. Pandoc marks Word's two-column layout tables (a figure next to
        //     explanatory text) as tables with a header row. Asciidoctor parses
        //     header cells as inline-only, so a block image and its title inside
        //     the "header" would be emitted as literal text. When the first row
        //     starts with an AsciiDoc cell that contains an image, drop the
        //     header option so the row is parsed as body content and the figure
        //     renders normally.
        {
            const lines = text.split('\n');
            for (let i = 0; i < lines.length - 2; i++) {
                if (!/options="header"/.test(lines[i])) continue;
                if (lines[i + 1] !== '|===' || lines[i + 2] !== 'a|') continue;

                let hasImage = false;
                for (let j = i + 3; j < lines.length; j++) {
                    if (lines[j] === '|===' || lines[j] === 'a|') break;
                    if (/^image:/.test(lines[j])) {
                        hasImage = true;
                        break;
                    }
                }
                if (hasImage) lines[i] = lines[i].replace(/options="header",?\s*/, '');
            }
            text = lines.join('\n');
        }

        // 1c. Pandoc sometimes emits a figure as an inline image followed by its
        //     caption (Word anchored the image). Asciidoctor only creates a
        //     figure for a *block* image, and a block title has to come before
        //     the image, so promote the image and move the caption up. This
        //     also fixes figures inside `a|` table cells.
        text = text.replace(
            /^image:(?![:\s])(\S+)\[([^\]]*)\]\s*\n\s*\n(\.\S[^\n]*)$/gm,
            (match, path, attrs, caption) => `${caption}\nimage::${path}[${attrs}]`
        );

        // 1d. References in running text that are not links (e.g. changelog
        //     entries such as "Anpassungen an Abbildung 24") still use Word's
        //     document-wide number. Map that number through the figure index to
        //     the figure's page-local number. Link labels are left alone here;
        //     step 3 rewrites those from their bookmark target.
        text = text
            .split('\n')
            .map((line) => {
                // Captions are block titles and must keep their title text.
                if (/^\s*\./.test(line)) return line;
                return line.replace(
                    /(?<!\[)(Abbildung\s+)(\*?)(\d+)(\*?)/gi,
                    (match, prefix, open, number, close) => {
                        const anchor = figureAnchorByNumber.get(number);
                        const location = anchor ? figureLocations.get(anchor) : null;
                        return location ? `${prefix}${open}${location.number}${close}` : match;
                    }
                );
            })
            .join('\n');

        // 2. Drop the generated table of contents lines (link:#x[... link:#x[n]]),
        //    Antora renders its own navigation.
        const keptLines = [];
        for (const line of text.split(/\r?\n/)) {
            const isTocLine = /^\s*link:#[^\[]+\[.*link:#[^\[]+\[\d+\]\s*\]\s*$/.test(line);
            if (isTocLine) continue;
            keptLines.push(line);
        }
        text = keptLines.join('\n');

        // 3. Rewrite internal cross-references.
        //    a) Chapter anchors -> xref to that chapter page.
        //    b) Section anchors -> in-page <<anchor>> or xref:page.adoc#anchor.
        //    Handles pandoc's nested form, e.g.
        //      link:#referenzen[8.2 Referenzen link:#referenzen[107]]
        //    All pages of a document live in the same module, so no module prefix
        //    is needed.
        text = text.replace(
            /link:#([^\s\[]+)\[((?:[^\[\]]|\[[^\]]*\])*)\]/g,
            (match, target, label) => {
                // Collapse a nested "link:#same[<page>]" page-number suffix in the label.
                const cleanLabel = label
                    .replace(/link:#[^\[]+\[\s*\d+\s*\]/g, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();

                // Drop references to docx-internal bookmarks (figures/TOC) that no
                // longer exist, but renumber figure references to the figure's
                // page-local number so they match the rendered caption.
                if (/^_(Toc|Ref)/.test(target)) {
                    const figure = figureLocations.get(target);
                    return figure ? renumberFigureLabel(cleanLabel, figure.number) : cleanLabel || '';
                }

                const slug = slugify(target);

                if (targetToPage.has(slug)) {
                    const page = targetToPage.get(slug);
                    const isChapterTitle = chapters.some((c) => c.base === page && c.anchor === slug);
                    // Reference to this page's own top-level chapter title: just text.
                    if (page === chapter.base && isChapterTitle) {
                        return cleanLabel || slug;
                    }
                    // A chapter title has no section anchor (it is the page title), so
                    // link to the page itself rather than to a non-existent anchor.
                    if (isChapterTitle) {
                        return cleanLabel ? `xref:${page}.adoc[${cleanLabel}]` : `xref:${page}.adoc`;
                    }
                    if (page === chapter.base) {
                        return cleanLabel ? `<<${slug},${cleanLabel}>>` : `<<${slug}>>`;
                    }
                    return cleanLabel
                        ? `xref:${page}.adoc#${slug}[${cleanLabel}]`
                        : `xref:${page}.adoc#${slug}`;
                }

                // Unknown target: keep only the (already de-numbered) link text.
                return cleanLabel || '';
            }
        );

        // 4. Rewrite image paths: ./media/imageN.png -> imageN.png (the module's
        //    Antora images directory).
        text = text.replace(/(\.\/)?media\//g, '');

        // 5. Collapse excessive blank lines.
        text = text.replace(/\n{3,}/g, '\n\n');

        return text.trim();
    }

    // -------------------------------------------------------------------------
    // Write pages
    // -------------------------------------------------------------------------

    fs.mkdirSync(pagesDir, {recursive: true});

    for (const ch of chapters) {
        // The chapter's own `== Title` line becomes the page's level-0 title, so
        // drop it from the body before transforming.
        const bodyWithoutChapterHeading = lines.slice(ch.startLine, ch.endLine).slice(1).join('\n');
        const body = transformBody(bodyWithoutChapterHeading, ch, ch.startLine + 1);

        const chapterPlan = headingPlan.get(ch.startLine);
        const titleLine = `= ${chapterPlan ? chapterPlan.label : ch.title}`;

        writeFile(
            path.join(pagesDir, `${ch.base}.adoc`),
            [
                titleLine,
                '',
                '// This file is generated by build-antora.js — do not edit by hand.',
                '',
                body,
                '',
            ].join('\n')
        );
    }

    // -------------------------------------------------------------------------
    // Copy images into the module's images directory
    // -------------------------------------------------------------------------

    let imageCount = 0;
    if (fs.existsSync(doc.mediaDir)) {
        fs.mkdirSync(imagesDir, {recursive: true});
        for (const entry of fs.readdirSync(doc.mediaDir, {withFileTypes: true})) {
            if (!entry.isFile()) continue;
            fs.copyFileSync(path.join(doc.mediaDir, entry.name), path.join(imagesDir, entry.name));
            imageCount++;
        }
    }

    // -------------------------------------------------------------------------
    // nav.adoc and index.adoc of the module
    // -------------------------------------------------------------------------

    const chapterLabel = (ch) => {
        const plan = headingPlan.get(ch.startLine);
        return plan ? plan.label : ch.title;
    };

    writeFile(
        path.join(moduleDir, 'nav.adoc'),
        [
            '// Generated by build-antora.js — do not edit by hand.',
            '',
            `.${docTitle}`,
            '* xref:index.adoc[Übersicht]',
            ...chapters.map((ch) => `* xref:${ch.base}.adoc[${chapterLabel(ch)}]`),
            '',
        ].join('\n')
    );

    writeFile(
        path.join(pagesDir, 'index.adoc'),
        [
            `= ${docTitle}`,
            '',
            '// This file is generated by build-antora.js — do not edit by hand.',
            '',
            'Diese Dokumentation wurde automatisch aus der Word-Vorlage',
            `\`${srcDocx}\` konvertiert und mit Antora als HTML-Website publiziert.`,
            '',
            '== Kapitel',
            '',
            ...chapters.map((ch) => `. xref:${ch.base}.adoc[${chapterLabel(ch)}]`),
            '',
        ].join('\n')
    );

    return {title: docTitle, chapterCount: chapters.length, imageCount};
}

// ---------------------------------------------------------------------------
// ROOT module (landing page linking to all documents)
// ---------------------------------------------------------------------------

function writeRootModule(converted) {
    const rootDir = path.join(MODULES_DIR, 'ROOT');

    writeFile(
        path.join(rootDir, 'nav.adoc'),
        [
            '// Generated by build-antora.js — do not edit by hand.',
            '',
            '* xref:index.adoc[Übersicht]',
            '',
        ].join('\n')
    );

    writeFile(
        path.join(rootDir, 'pages', 'index.adoc'),
        [
            `= ${SITE_TITLE}`,
            '',
            '// This file is generated by build-antora.js — do not edit by hand.',
            '',
            'Diese Seite listet alle Dokumente auf, die automatisch aus Word-Vorlagen',
            'konvertiert und mit Antora als HTML-Website publiziert wurden.',
            '',
            '== Dokumente',
            '',
            ...converted.map((c) => `* xref:${c.moduleName}:index.adoc[${c.title}]`),
            '',
        ].join('\n')
    );
}

// ---------------------------------------------------------------------------
// antora/antora.yml (component descriptor)
// ---------------------------------------------------------------------------

/**
 * Makes sure every module's nav.adoc is registered in the descriptor. An
 * existing descriptor is kept as is except for its `nav:` list.
 */
function updateDescriptor(moduleNames) {
    const navBlock =
        ['nav:', ...['ROOT', ...moduleNames].map((m) => `  - modules/${m}/nav.adoc`)].join('\n') +
        '\n';

    if (fs.existsSync(DESCRIPTOR_FILE)) {
        let yml = fs.readFileSync(DESCRIPTOR_FILE, 'utf8');
        const navRe = /^nav:[ \t]*\r?\n(?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*/m;
        if (navRe.test(yml)) {
            yml = yml.replace(navRe, navBlock);
        } else {
            yml = yml.replace(/\s*$/, '\n') + navBlock;
        }
        writeFile(DESCRIPTOR_FILE, yml);
        return 'updated';
    }

    writeFile(
        DESCRIPTOR_FILE,
        [
            `name: ${COMPONENT_NAME}`,
            `title: ${COMPONENT_TITLE}`,
            `version: '${COMPONENT_VERSION}'`,
            'start_page: ROOT:index.adoc',
            'asciidoc:',
            '  attributes:',
            "    sectnums: ''",
            navBlock,
        ].join('\n')
    );
    return 'created';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const documents = discoverDocuments();

// The whole modules folder is generated, so start from a clean slate.
rmrf(MODULES_DIR);

// Module names: ASCII, unique, and never `root` (clashes with ROOT on
// case-insensitive file systems).
const usedModules = new Set(['root']);
const converted = [];

documents.forEach((doc, i) => {
    const moduleName = uniqueName(asciiSlug(doc.name) || `dokument-${i + 1}`, usedModules);
    const result = convertDocument(doc, moduleName);
    if (!result) return;
    converted.push({moduleName, ...result});
    console.log(
        `${doc.name}: module "${moduleName}" with ${result.chapterCount} chapter pages, ` +
        `${result.imageCount} images`
    );
});

if (converted.length === 0) {
    console.error('Error: none of the documents could be converted.');
    process.exit(1);
}

writeRootModule(converted);
const descriptorState = updateDescriptor(converted.map((c) => c.moduleName));

console.log(`Generated ${converted.length} module(s) in ${path.relative(ROOT, MODULES_DIR)}`);
console.log(`${path.relative(ROOT, DESCRIPTOR_FILE)} ${descriptorState} (nav list)`);
