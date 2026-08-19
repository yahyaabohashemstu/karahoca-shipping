/**
 * Upper-case an identifier — a customer code, a carrier code, a plate.
 *
 * Invariant, not Turkish, and the difference is not cosmetic.
 *
 * These fields used `toLocaleUpperCase('tr')`, which is correct for Turkish
 * prose and wrong for a key. Turkish maps i to İ (U+0130, capital I with a dot),
 * so a dispatcher typing `istanbul-01` stored `İSTANBUL-01` — a code that is not
 * ASCII, does not match what the ERP holds, and cannot be typed back by anyone
 * who does not know to reach for the Turkish keyboard's İ.
 *
 * The database makes it worse rather than catching it. `code` is citext with a
 * UNIQUE constraint, which compares by lower-casing, and:
 *
 *     lower('İSTANBUL-01') = 'i̇stanbul-01'   (i + U+0307 combining dot)
 *     lower('ISTANBUL-01') = 'istanbul-01'
 *
 * Those are different strings, so UNIQUE does not fire. The same firm entered
 * twice — once by someone whose keyboard produced a dotted İ and once by
 * someone whose did not — yields two customer rows and two sets of orders,
 * which is precisely the split the fixed code field exists to prevent.
 *
 * The invariant mapping has no such trap: i and ı both become a plain ASCII I,
 * and ş, ğ, ç, ö, ü still upper-case to their own capitals. What goes in as
 * ASCII comes out as ASCII.
 *
 * Deliberately only the case. Trimming happens at submit, where it always has.
 */
export function upperIdentifier(value: string): string {
  return value.toUpperCase();
}
