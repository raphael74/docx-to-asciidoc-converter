#!/usr/bin/env node
/**
 * Verifies that every in-page anchor and cross-page xref used in the generated
 * Antora pages (and the navs) of all modules resolves to a real element ID in
 * the built HTML. Exits non-zero when broken references are found.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MODULES_DIR = path.join(ROOT, 'antora', 'modules');
const DESCRIPTOR_FILE = path.join(ROOT, 'antora', 'antora.yml');

// Component name and version determine the output folder of the site. Read
// them from the descriptor so this script follows any change there.
let componentName = 'referenzarchitekturen';
let componentVersion = '5.7';
if (fs.existsSync(DESCRIPTOR_FILE)) {
    const yml = fs.readFileSync(DESCRIPTOR_FILE, 'utf8');
    const name = /^name:\s*['"]?([^'"\s#]+)/m.exec(yml);
    const version = /^version:\s*['"]?([^'"\s#]+)/m.exec(yml);
    if (name) componentName = name[1];
    if (version) componentVersion = version[1];
}

const SITE_DIR = path.join(ROOT, 'build', 'site', componentName, componentVersion);

if (!fs.existsSync(SITE_DIR)) {
    console.error(`Error: built site not found at ${SITE_DIR}. Run 'npm run build' first.`);
    process.exit(1);
}
if (!fs.existsSync(MODULES_DIR)) {
    console.error(`Error: generated modules not found at ${MODULES_DIR}. Run 'npm run split' first.`);
    process.exit(1);
}

const modules = fs
    .readdirSync(MODULES_DIR, {withFileTypes: true})
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

/** Antora publishes ROOT at the version root and other modules in a sub folder. */
const siteDirOf = (mod) => (mod === 'ROOT' ? SITE_DIR : path.join(SITE_DIR, mod));

// Collect IDs present in each built HTML page, keyed by "<module>/<page>".
const htmlIds = new Map();
for (const mod of modules) {
    const dir = siteDirOf(mod);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.html')) continue;
        const base = file.replace(/\.html$/, '');
        const html = fs.readFileSync(path.join(dir, file), 'utf8');
        const ids = new Set();
        for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
        htmlIds.set(`${mod}/${base}`, ids);
    }
}

const problems = [];

function checkRef(fromModule, fromPage, kind, module, page, anchor) {
    const targetModule = module || fromModule;
    const targetPage = page || fromPage;
    const label = `${fromModule}/${fromPage}`;
    const ids = htmlIds.get(`${targetModule}/${targetPage}`);
    if (!ids) {
        problems.push(`${label}: ${kind} -> unknown page "${targetModule}:${targetPage}"`);
        return;
    }
    if (anchor && !ids.has(anchor)) {
        problems.push(
            `${label}: ${kind} -> missing anchor "${anchor}" in ${targetModule}/${targetPage}.html`
        );
    }
}

// Scan the generated AsciiDoc pages and navs of every module.
const sourcesToScan = [];
for (const mod of modules) {
    const pagesDir = path.join(MODULES_DIR, mod, 'pages');
    if (fs.existsSync(pagesDir)) {
        for (const f of fs.readdirSync(pagesDir).filter((f) => f.endsWith('.adoc'))) {
            sourcesToScan.push({module: mod, page: f.replace(/\.adoc$/, ''), file: path.join(pagesDir, f)});
        }
    }
    // Also scan the navigation file so sidebar links are covered.
    const navFile = path.join(MODULES_DIR, mod, 'nav.adoc');
    if (fs.existsSync(navFile)) {
        sourcesToScan.push({module: mod, page: 'index', file: navFile});
    }
}

for (const {module: mod, page, file} of sourcesToScan) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    for (const line of lines) {
        // xref:page.adoc#anchor[label], xref:page.adoc[label] and the
        // module-qualified form xref:module:page.adoc[label]
        for (const m of line.matchAll(
            /xref:(?:([A-Za-z0-9._-]+):)?([a-z0-9._-]+)\.adoc(?:#([A-Za-z0-9._:-]+))?\[/g
        )) {
            checkRef(mod, page, 'xref', m[1], m[2], m[3]);
        }
        // <<anchor>> / <<anchor,label>> (in-page)
        for (const m of line.matchAll(/<<([A-Za-z0-9._:-]+)(?:,[^>]*)?>>/g)) {
            checkRef(mod, page, 'in-page xref', mod, page, m[1]);
        }
    }
}

if (problems.length) {
    console.error(`Found ${problems.length} broken reference(s):`);
    for (const p of problems.slice(0, 50)) console.error(`  - ${p}`);
    if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
    process.exit(1);
}

console.log(`All anchors and xrefs resolve correctly (${modules.length} modules checked).`);
