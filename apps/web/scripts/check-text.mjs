#!/usr/bin/env node
/* =============================================================================
   The two text helpers, checked against the failures that produced them
   =============================================================================
   Both are four lines long and both are easy to "simplify" into something that
   looks equivalent and is not. Every case below is a bug that shipped, or the
   near miss that replacing it would reintroduce:

     upperIdentifier had been toLocaleUpperCase('tr'), which turns a typed i
     into İ. The customer code column is citext with a UNIQUE constraint, and
     lower('İSTANBUL-01') is 'i̇stanbul-01' — i plus a combining dot — which is
     not equal to lower('ISTANBUL-01'), so the constraint never fired and the
     same firm could be entered twice.

     searchFold had been toLocaleLowerCase('tr'), which folds I to ı, so typing
     `istanbul` did not find a customer stored as `Istanbul Lojistik`. Plain
     toLowerCase() only moves the failure onto the İ spelling.

   Node runs the TypeScript directly, so this exercises the shipped functions
   rather than a copy of them that could drift.

   Run: npm run check:text
   ========================================================================== */

import { searchFold } from '../src/lib/search.ts';
import { upperIdentifier } from '../src/lib/identifier.ts';

const failures = [];

function check(what, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${what}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
}

function matches(query, field) {
  return searchFold(field).includes(searchFold(query.trim()));
}

/* -- the Turkish I family, which is the whole reason both helpers exist ----- */

for (const letter of ['I', 'ı', 'İ', 'i']) {
  check(`searchFold(${JSON.stringify(letter)}) folds into the I family`, searchFold(letter), 'i');
}

// The exact report: a dispatcher types the ASCII spelling, the record holds
// either spelling, and both must be found.
check('typing "istanbul" finds "Istanbul Lojistik"', matches('istanbul', 'Istanbul Lojistik'), true);
check('typing "istanbul" finds "İstanbul Lojistik"', matches('istanbul', 'İstanbul Lojistik'), true);
check('typing "ISTANBUL" finds "İstanbul Lojistik"', matches('ISTANBUL', 'İstanbul Lojistik'), true);
check('typing "İSTANBUL" finds "Istanbul Lojistik"', matches('İSTANBUL', 'Istanbul Lojistik'), true);

/* -- diacritics, in all three languages the dashboard speaks --------------- */

check('typing "sisli" finds "Şişli Deposu"', matches('sisli', 'Şişli Deposu'), true);
check('typing "corum" finds "Çorum Lojistik"', matches('corum', 'Çorum Lojistik'), true);
check('typing "guneydogu" finds "Güneydoğu Nakliyat"', matches('guneydogu', 'Güneydoğu Nakliyat'), true);
check('typing "sopandin" finds "Şopandin"', matches('sopandin', 'Şopandin'), true);
check('typing "ahmed" finds "أحمد"', matches('احمد', 'أحمد'), true);

// Folding must not collapse everything into everything.
check('"ankara" does not match "istanbul"', matches('ankara', 'Istanbul'), false);

/* -- identifiers: ASCII in, ASCII out ------------------------------------- */

check('upperIdentifier keeps a typed i ASCII', upperIdentifier('istanbul-01'), 'ISTANBUL-01');
check('upperIdentifier keeps the dotless i ASCII', upperIdentifier('ısparta-02'), 'ISPARTA-02');
check('upperIdentifier leaves an already-upper code alone', upperIdentifier('MGZ-01'), 'MGZ-01');
check('upperIdentifier still capitalises the other Turkish letters', upperIdentifier('çorum-03'), 'ÇORUM-03');
check('upperIdentifier uppercases a plate', upperIdentifier('34 izm 123'), '34 IZM 123');

// The specific character that broke the UNIQUE constraint must never reappear.
for (const typed of ['istanbul-01', 'izmir-01', 'i', 'iii']) {
  check(
    `upperIdentifier(${JSON.stringify(typed)}) contains no U+0130`,
    upperIdentifier(typed).includes('İ'),
    false,
  );
}

// ASCII in, ASCII out — stated as the property rather than case by case.
for (const typed of ['abc-123', 'istanbul-01', 'IZMIR 34', 'a1']) {
  check(
    `upperIdentifier(${JSON.stringify(typed)}) stays ASCII`,
    /^[\x20-\x7E]*$/.test(upperIdentifier(typed)),
    true,
  );
}

/* ------------------------------------------------------------------------- */

if (failures.length === 0) {
  console.log('check-text: searchFold and upperIdentifier behave as documented.');
  process.exit(0);
}

console.error(`check-text: ${failures.length} failure(s).\n`);
for (const f of failures) console.error(`  - ${f}\n`);
process.exit(1);
