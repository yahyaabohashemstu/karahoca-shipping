/**
 * ISO 3166-1 alpha-2 codes, with Turkish names, for the countries a Turkish
 * detergent manufacturer actually ships to.
 *
 * Its own module rather than living beside the component that first needed it:
 * both the consignee editor and the customer dialog use it, and the dialog is
 * rendered *by* the editor, so importing it from there is a cycle.
 *
 * A fixed list rather than free text is the whole point. Typed per shipment,
 * the same firm ends up filed under DE, DEU, Almanya and Germany, and no export
 * report ever adds up again. An unlisted destination still round-trips — the
 * raw two-letter code is stored and displayed unchanged.
 */
export const COUNTRY_TR: Record<string, string> = {
  TR: 'Türkiye',
  DE: 'Almanya',
  NL: 'Hollanda',
  FR: 'Fransa',
  IT: 'İtalya',
  GB: 'Birleşik Krallık',
  BG: 'Bulgaristan',
  RO: 'Romanya',
  GR: 'Yunanistan',
  RS: 'Sırbistan',
  UA: 'Ukrayna',
  RU: 'Rusya',
  GE: 'Gürcistan',
  AZ: 'Azerbaycan',
  IQ: 'Irak',
  SY: 'Suriye',
  SA: 'Suudi Arabistan',
  AE: 'BAE',
  QA: 'Katar',
  KW: 'Kuveyt',
  OM: 'Umman',
  BH: 'Bahreyn',
  LY: 'Libya',
  EG: 'Mısır',
  MA: 'Fas',
  DZ: 'Cezayir',
  TN: 'Tunus',
  SD: 'Sudan',
  IR: 'İran',
  KZ: 'Kazakistan',
  UZ: 'Özbekistan',
  TM: 'Türkmenistan',
  KG: 'Kırgızistan',
  PL: 'Polonya',
  AT: 'Avusturya',
  BE: 'Belçika',
  ES: 'İspanya',
  SE: 'İsveç',
  CH: 'İsviçre',
  CZ: 'Çekya',
  HU: 'Macaristan',
  CY: 'Kıbrıs',
  IL: 'İsrail',
  JO: 'Ürdün',
  LB: 'Lübnan',
  AL: 'Arnavutluk',
  MK: 'Kuzey Makedonya',
  XK: 'Kosova',
  BA: 'Bosna-Hersek',
  MD: 'Moldova',
};

export function countryLabel(code: string | null | undefined): string {
  if (!code) return '—';
  const upper = code.toUpperCase();
  return COUNTRY_TR[upper] ?? upper;
}

/** Domestic first — it is most shipments — then alphabetical by Turkish name. */
export const COUNTRY_OPTIONS = Object.entries(COUNTRY_TR)
  .map(([code, label]) => ({ code, label }))
  .sort((a, b) =>
    a.code === 'TR' ? -1 : b.code === 'TR' ? 1 : a.label.localeCompare(b.label, 'tr'),
  );

/** True when a shipment leaves Turkey — the case that needs customs paperwork. */
export function isExport(code: string | null | undefined): boolean {
  return Boolean(code) && code!.toUpperCase() !== 'TR';
}
