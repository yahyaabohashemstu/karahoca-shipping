/**
 * Fold text for substring matching in the filter boxes.
 *
 * Not for display, not for sorting, and deliberately not locale-aware — the
 * opposite of what these filters used to do.
 *
 * They folded both sides with `toLocaleLowerCase('tr')`, which is the correct
 * lower-case for Turkish prose and the wrong one for search, because Turkish
 * has four letters in the I family and lower-cases them in pairs:
 *
 *     I (U+0049) -> ı        İ (U+0130) -> i
 *
 * So a dispatcher typing `istanbul` folded their query to `istanbul` while a
 * customer stored as `Istanbul Lojistik` folded to `ıstanbul lojistik`, and the
 * substring did not match. The record was there and the search said it was not.
 *
 * Plain toLowerCase() does not fix it either, it only moves the failure: it
 * maps İ to i + U+0307, a combining dot, so `İstanbul` stops matching instead.
 *
 * What search wants is one representative per letter, so this decomposes,
 * throws the combining marks away, and folds the one Turkish letter that has no
 * decomposition:
 *
 *     I ı İ i  -> i          ş -> s      ğ -> g      ç -> c
 *     ê î û    -> e i u      ö -> o      ü -> u
 *     أ إ آ    -> ا
 *
 * That makes the filters diacritic-insensitive as well as case-insensitive,
 * which is the behaviour a dispatcher already expects: typing `sisli` finds
 * Şişli, and `corum` finds Çorum, on whatever keyboard is in front of them.
 * The cost is a few more loose matches in a list of a few hundred rows, which
 * is a far better failure than a record that cannot be found at all.
 *
 * ı is listed explicitly because it is a letter in its own right rather than an
 * i wearing a mark, so NFD leaves it exactly as it is.
 */
const COMBINING_MARKS = new RegExp(
  // Latin and Greek marks, then the whole Arabic mark block and the
  // superscript alef, so a name written with them still matches one typed
  // without. The block has to run to U+065F rather than stopping at the
  // harakat: the hamza carriers أ إ آ decompose to a plain alef plus a mark
  // at U+0653-U+0655, and those are exactly the ones a typist leaves off.
  // Spelled as escapes rather than as the characters themselves, which are
  // invisible in an editor.
  '[\u0300-\u036f\u064b-\u065f\u0670]',
  'g',
);

export function searchFold(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').replace(/ı/g, 'i').toLowerCase();
}
