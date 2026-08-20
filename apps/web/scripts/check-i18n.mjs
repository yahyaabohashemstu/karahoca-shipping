#!/usr/bin/env node
/* =============================================================================
   Find user-facing text that is still hard-coded
   =============================================================================
   Completeness across languages is already a compile error: ar.ts and ku.ts are
   typed against `typeof tr`, so a key added to one and forgotten in the others
   will not build. This checks the other half — text that never made it into the
   dictionary at all and so renders in Turkish whatever language is chosen.

   That is the failure mode that survived a careful manual pass twice on the
   Android side. Scanning for Turkish letters is not enough to catch it: "Oturum
   Kodu", "Takip Aktif" and "Yenile" contain none of ı ş ğ ç ö ü, and all three
   shipped untranslated through a review that was looking for exactly them. So
   this looks at *position* — text in a place the reader can see — rather than
   at the letters.

   Run: npm run check:i18n
   ========================================================================== */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: the repository lives under a path with a
// space in it, and .pathname hands back the percent-encoded form.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/*
 * Files that hold Turkish on purpose.
 *
 * The dictionaries obviously. lib/i18n/locale.ts names each language in its own
 * language, which is the point of it.
 */
const EXEMPT_DIRS = [
  /*
   * A developer harness, deliberately unlinked from the navigation, which feeds
   * FleetMap synthetic vehicles so the 3D rendering can be looked at without a
   * database. Its only readers are whoever is working on the map, in the same
   * file as the English comments explaining it. Translating it would be noise.
   */
  join('app', 'map-preview'),
];

const EXEMPT_FILES = [
  join('lib', 'i18n', 'tr.ts'),
  join('lib', 'i18n', 'ar.ts'),
  join('lib', 'i18n', 'ku.ts'),
  join('lib', 'i18n', 'locale.ts'),
  /*
   * A text-normalisation helper has to name the characters it normalises.
   * The dotless i in searchFold is data, not a label, and the quote-pairing
   * in the catch-all pattern reads across the two adjacent string literals
   * it sits between.
   */
  join('lib', 'search.ts'),
];

/*
 * Strings that are not prose, whatever position they appear in.
 *
 * Brand names, units, and the technical vocabulary of the domain that is
 * identical in all three languages. Each of these is a deliberate decision
 * rather than an oversight, which is why they are listed rather than pattern
 * matched.
 */
const ALLOWED = new Set([
  'KaraHoca',
  'KARAHOCA',
  // The monogram in the navigation dock. It is the company's initials, which
  // are the same two letters in all three languages and in two scripts.
  'KH',
  'GPS',
  'API',
  'km',
  'kg',
  'ton',
  'UTC',
  'Terrain Tiles',
  'ID',
  '·',
  '—',
  '›',
  '‹',
]);

/** Attributes whose string value is read by a person, not by a machine. */
const VISIBLE_ATTRS =
  /\b(?:label|title|placeholder|aria-label|alt|message|description|confirmLabel|cancelLabel|emptyLabel|heading)\s*=\s*"([^"]{2,})"/g;

/** A JSX text node: between a > and a < with no braces or tags in between. */
const JSX_TEXT = />\s*([^<>{}\n][^<>{}\n]*[^<>{}\s])\s*</g;

/*
 * Any Turkish string at all, anywhere.
 *
 * The three patterns above look at position, which is what catches text with no
 * Turkish-specific letters in it. This is the complement: text that never sits
 * in a JSX node or a labelled attribute because it lives in a lookup table —
 * lib/countries.ts is a list of country names, lib/signal.ts a list of status
 * words — and would otherwise be invisible to all three.
 *
 * Position catches "Oturum Kodu"; letters catch "Irak". Neither alone is
 * enough, which is the whole lesson of the Android pass.
 */
const TURKISH_STRING = new RegExp([String.raw`'([^'\n]{2,})'`, String.raw`"([^"\n]{2,})"`].join('|'), 'g');

/** A default value on a destructured prop, e.g. `title = 'Veri alınamadı',`. */
const PROP_DEFAULT = /\b[a-zA-Z]+\s*=\s*'([^'\n]{3,})'\s*[,)]/g;

const TURKISH_LETTER = /[ıİşŞğĞçÇöÖüÜ]/;

/** Strip comments and imports so prose inside them is not reported. */
function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .map((line) => (line.includes('//') && !line.includes('://') ? line.split('//')[0] : line))
    .join('\n');
}

/**
 * Does this look like something a person reads?
 *
 * A word with a space in it, or a Turkish letter, almost always does. A lone
 * lowercase token like `neutral` or `flex-1` almost never does — those are
 * variant names and class fragments, and reporting them buries the real ones.
 */
function looksLikeProse(value) {
  if (ALLOWED.has(value)) return false;
  /*
   * JSX control flow sits between a /> and a <, so the text-node pattern picks
   * up whole ternary arms — `) : isError ? (` reads as prose to a regex.
   */
  if (/=>|===|&&|\|\||\?\s*\(|^\)\s*:|^=\s|^\{|\}$/.test(value)) return false;
  if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(value)) return false;
  if (/^[a-z][a-zA-Z0-9]*$/.test(value)) return false; // camelCase / single lowercase token
  if (/^[a-z0-9-]+$/.test(value)) return false; // kebab-case, class fragments
  if (/^[\d\s.,:/-]+$/.test(value)) return false;
  if (/^(?:https?:|\/|#|\$|var\()/.test(value)) return false;
  return TURKISH_LETTER.test(value) || /\s/.test(value) || /^[A-ZÇĞİÖŞÜ]/.test(value);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const findings = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (EXEMPT_FILES.some((exempt) => rel === exempt || rel.endsWith(sep + exempt))) continue;
  if (EXEMPT_DIRS.some((dir) => rel.startsWith(dir + sep))) continue;

  const source = strip(readFileSync(file, 'utf8'));
  const seen = new Set();
  const patterns = file.endsWith('.tsx')
    ? [VISIBLE_ATTRS, JSX_TEXT, PROP_DEFAULT, TURKISH_STRING]
    : [VISIBLE_ATTRS, PROP_DEFAULT, TURKISH_STRING];
  for (const rx of patterns) {
    rx.lastIndex = 0;
    let match;
    while ((match = rx.exec(source)) !== null) {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      // The catch-all pattern matches every string in the file, so it is held
      // to the stricter bar: it must actually contain a Turkish letter.
      if (rx === TURKISH_STRING && !TURKISH_LETTER.test(value)) continue;
      if (!looksLikeProse(value) || seen.has(value)) continue;
      seen.add(value);
      const line = source.slice(0, match.index).split('\n').length;
      findings.push({ file: rel.split(sep).join('/'), line, value });
    }
  }
}

if (findings.length === 0) {
  console.log('check-i18n: no hard-coded user-facing text found.');
  process.exit(0);
}

const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}

console.error(
  `check-i18n: ${findings.length} hard-coded string(s) in ${byFile.size} file(s).\n` +
    'These render in Turkish whatever language the reader chose. Move them into\n' +
    'src/lib/i18n/tr.ts and translate in ar.ts and ku.ts.\n',
);
for (const [file, items] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${file}  (${items.length})`);
  for (const item of items.slice(0, 40)) console.error(`      ${item.line}: ${item.value}`);
  if (items.length > 40) console.error(`      … and ${items.length - 40} more`);
}
process.exit(1);
