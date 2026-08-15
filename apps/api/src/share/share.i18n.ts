/* =============================================================================
   The consignee's own language
   =============================================================================
   This page is the only thing a customer of KaraHoca ever sees. The customers
   are in Erbil, Mosul, Aleppo and Damascus, and until now the page said
   "Kalan mesafe", "Planlanan teslimat", "Teslim edildi". A purchasing manager
   in Erbil opening that reads somebody else's internal paperwork, understands
   none of the four facts they came for, and telephones — which is the exact
   phone call the link exists to prevent.

   Two things beyond the words.

   DIRECTION. Arabic is right-to-left, and a translated page in a left-to-right
   layout is worse than an untranslated one: the eye starts in the wrong corner
   and every alignment fights the text. The whole document flips, which the CSS
   handles with logical properties rather than a mirrored stylesheet.

   NUMERALS. Arabic is written with either Western digits (0-9) or Eastern
   Arabic-Indic ones (٠-٩), and Intl will happily produce the latter. It is the
   wrong choice here: this page is mostly identifiers and quantities — a plate
   reading 27 AB 100, a distance in kilometres, a timestamp — and half of those
   come from data that will never be transliterated. A page mixing ٤٥ km with a
   Latin plate number looks broken. So every locale is pinned to Latin digits.

   Time zones need no special handling and it is worth writing down why rather
   than leaving it to be rediscovered: Turkey, Iraq and Syria all sit on UTC+3
   with no daylight saving, so Europe/Istanbul is the correct wall clock for a
   reader in Erbil as much as for one in Gaziantep.
   ========================================================================== */

export type ShareLocale = 'tr' | 'ar';

export const SHARE_LOCALES: readonly ShareLocale[] = ['tr', 'ar'] as const;

export function isRtl(locale: ShareLocale): boolean {
  return locale === 'ar';
}

/** What the language switcher calls each option, in that language. */
export const LOCALE_NAME: Record<ShareLocale, string> = {
  tr: 'Türkçe',
  ar: 'العربية',
};

/**
 * Which language to render in.
 *
 * Ordered by how much each source knows about the actual reader:
 *
 *   1. An explicit choice. Someone who clicked "العربية" has settled it, and no
 *      inference may override that.
 *   2. The consignee's country. A shipment to an Iraqi or Syrian customer is
 *      read in Arabic, and this is the only signal that is right even when the
 *      link is forwarded to a colleague on a Turkish-configured laptop — which
 *      is how these links actually travel.
 *   3. Accept-Language. Right for a browser that has been told, wrong for a
 *      shared office machine, hence third.
 *   4. Turkish, the language of the company that sends the link.
 */
export function resolveLocale(input: {
  query?: string | null;
  countryCode?: string | null;
  acceptLanguage?: string | null;
}): ShareLocale {
  const explicit = normaliseLocale(input.query);
  if (explicit) return explicit;

  const country = (input.countryCode ?? '').trim().toUpperCase();
  // The corridor this company ships into. Deliberately a list of countries
  // rather than "not TR": a German consignee should get Turkish and a fallback
  // they can machine-translate, not Arabic.
  if (country === 'IQ' || country === 'SY' || country === 'JO' || country === 'LB') return 'ar';
  if (country === 'TR') return 'tr';

  for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
    const match = normaliseLocale(tag);
    if (match) return match;
  }

  return 'tr';
}

function normaliseLocale(raw: string | null | undefined): ShareLocale | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  // Matches 'ar', 'ar-IQ', 'ar_SY'. Prefix, not equality, or every regional
  // Arabic a browser actually sends would fall through to Turkish.
  if (value === 'ar' || value.startsWith('ar-') || value.startsWith('ar_')) return 'ar';
  if (value === 'tr' || value.startsWith('tr-') || value.startsWith('tr_')) return 'tr';
  return null;
}

/** Accept-Language tags, best-quality first. */
function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const weight = q ? Number(q.trim().slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((x) => x.tag && x.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((x) => x.tag);
}

/* -----------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */

const FORMATTERS: Record<ShareLocale, Intl.DateTimeFormat> = {
  tr: new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }),
  /*
   * `ar-u-nu-latn-ca-gregory`, and both extensions are load-bearing.
   *
   * Without `nu-latn` the date comes back as ٢٠٢٦/٠٨/١٥ beside a Latin plate
   * number. Without `ca-gregory` an Arabic locale may resolve to the Islamic
   * calendar, and a delivery date given as 2 Safar 1448 is not a date anyone
   * can check against a purchase order.
   */
  ar: new Intl.DateTimeFormat('ar-u-nu-latn-ca-gregory', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }),
};

export function formatDateTime(locale: ShareLocale, value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return FORMATTERS[locale].format(date);
}

const NUMBERS: Record<ShareLocale, Intl.NumberFormat> = {
  tr: new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }),
  ar: new Intl.NumberFormat('ar-u-nu-latn', { maximumFractionDigits: 1 }),
};

export function formatNumber(locale: ShareLocale, value: number): string {
  return NUMBERS[locale].format(value);
}

/* -----------------------------------------------------------------------------
   The strings
   -------------------------------------------------------------------------- */

export interface ShareStrings {
  // Document
  pageTitle: (order: string) => string;
  brand: string;

  // Group headings
  groupNow: string;
  groupShipment: string;
  groupCargo: string;
  groupCarrier: string;

  // Facts
  lastFix: string;
  remaining: string;
  asTheCrowFlies: string;
  destination: string;
  plannedDelivery: string;
  orderNumber: string;
  consignee: string;
  plate: string;
  driver: string;
  driverPhone: string;
  carrier: string;
  items: string;
  quantity: string;
  noFixYet: string;

  // Status headline and detail
  statusPreparing: string;
  statusOnTheRoadTitle: string;
  statusOnBreakTitle: string;
  statusDepartingTitle: string;
  statusDepartingDetail: string;
  statusDeliveredTitle: string;
  statusDeliveredDetail: string;
  statusCancelledTitle: string;
  statusCancelledDetail: string;
  statusFinishedTitle: string;
  statusFinishedDetail: string;
  statusStoppedDetail: string;
  statusDriverReady: string;
  statusPlannedNotStarted: string;

  // Signal quality
  signalLive: string;
  signalDelayed: string;
  signalStale: string;
  signalLost: string;
  signalNone: string;

  // Map
  mapLoading: string;
  mapFailed: string;
  mapNoPosition: string;

  // Relative time, for the client-side ticker
  agoJustNow: string;
  agoMinutes: string;
  agoHours: string;
  agoDays: string;

  // Notices
  noticeInvalidTitle: string;
  noticeInvalidBody: string;
  noticeUnknownBody: string;
  noticeExpiredTitle: string;
  noticeExpiredBody: string;
  noticeErrorTitle: string;
  noticeErrorBody: string;

  // Chrome
  switchLanguage: string;
  footerPrivate: string;
  footerContact: string;
}

const TR: ShareStrings = {
  pageTitle: (order) => `Sevkiyat Takibi — ${order}`,
  brand: 'KARAHOCA',

  groupNow: 'Durum',
  groupShipment: 'Sevkiyat',
  groupCargo: 'Yük',
  groupCarrier: 'Taşıma',

  lastFix: 'Son konum güncellemesi',
  remaining: 'Kalan mesafe',
  asTheCrowFlies: 'kuş uçuşu',
  destination: 'Varış',
  plannedDelivery: 'Planlanan teslimat',
  orderNumber: 'Sipariş No',
  consignee: 'Alıcı',
  plate: 'Plaka',
  driver: 'Sürücü',
  driverPhone: 'Sürücü telefonu',
  carrier: 'Taşıyıcı firma',
  items: 'Ürünler',
  quantity: 'Miktar',
  noFixYet: 'Henüz konum alınmadı',

  statusPreparing: 'Hazırlanıyor',
  statusOnTheRoadTitle: 'Yolda',
  statusOnBreakTitle: 'Molada',
  statusDepartingTitle: 'Yola çıkıyor',
  statusDepartingDetail: 'Sürücü hazır, takip birazdan başlayacak.',
  statusDeliveredTitle: 'Teslim edildi',
  statusDeliveredDetail: 'Sevkiyat teslim edildi.',
  statusCancelledTitle: 'İptal edildi',
  statusCancelledDetail: 'Bu sevkiyat iptal edildi. Ayrıntı için sevkiyat sorumlunuzla görüşün.',
  statusFinishedTitle: 'Takip tamamlandı',
  statusFinishedDetail:
    'Aracın takibi sona erdi. Teslimat onayı için sevkiyat sorumlunuzla görüşün.',
  statusStoppedDetail: 'Araç şu anda duruyor. Takip sürüyor.',
  statusDriverReady: 'Sürücü hazır, takip birazdan başlayacak.',
  statusPlannedNotStarted: 'Sevkiyat planlandı, araç henüz yola çıkmadı.',

  signalLive: 'Araç yolda, konum canlı olarak güncelleniyor.',
  signalDelayed: 'Araç yolda. Konum birkaç dakikadır güncellenmedi.',
  signalStale: 'Araç yolda. Konum bir süredir alınamıyor, araç kapsama alanı dışında olabilir.',
  signalLost: 'Araç yolda. Konum şu anda alınamıyor, araç kapsama alanı dışında olabilir.',
  signalNone: 'Araç yolda.',

  mapLoading: 'Harita yükleniyor…',
  mapFailed: 'Harita yüklenemedi. Yukarıdaki bilgiler günceldir.',
  mapNoPosition: 'Araç henüz konum bildirmedi.',

  agoJustNow: 'az önce',
  agoMinutes: 'dakika önce',
  agoHours: 'saat önce',
  agoDays: 'gün önce',

  noticeInvalidTitle: 'Bağlantı geçerli değil',
  noticeInvalidBody:
    'Bu takip bağlantısı artık geçerli değil. Sevkiyat sorumlunuzdan yeni bir bağlantı isteyebilirsiniz.',
  noticeUnknownBody:
    'Bu takip bağlantısı açılamıyor. Bağlantıyı eksiksiz kopyaladığınızdan emin olun; sorun sürerse sevkiyat sorumlunuzla iletişime geçin.',
  noticeExpiredTitle: 'Bağlantının süresi doldu',
  noticeExpiredBody:
    'Bu sevkiyatın takip süresi doldu. Güncel bilgi için bizimle iletişime geçin.',
  noticeErrorTitle: 'Sayfa şu anda açılamıyor',
  noticeErrorBody:
    'Geçici bir sorun nedeniyle sevkiyat bilgileri getirilemedi. Lütfen birkaç dakika sonra tekrar deneyin.',

  switchLanguage: 'العربية',
  footerPrivate:
    'Bu sayfa yalnızca bu sevkiyat için oluşturulmuş özel bir bağlantıdır ve süresi dolduğunda kapanır. Lütfen bağlantıyı üçüncü kişilerle paylaşmayın.',
  footerContact: 'Sorularınız için sevkiyat sorumlunuzla iletişime geçin.',
};

/*
 * Arabic, in Modern Standard rather than any dialect.
 *
 * The readers are purchasing and warehouse staff across Iraqi Kurdistan, Mosul
 * and Syria, who share no spoken dialect but all read MSA — it is what invoices
 * and customs paperwork are already written in, so it is also the register a
 * shipping document is expected to be in.
 *
 * Two deliberate choices a translator would ask about:
 *
 *   "الشاحنة" (the lorry) rather than "المركبة" (the vehicle). The Turkish says
 *   araç, which is generic, but the reader is waiting for a specific truck and
 *   the concrete word is what they would use themselves.
 *
 *   "بخط مستقيم" for kuş uçuşu. The Turkish idiom is "as the bird flies" and
 *   Arabic has no equivalent that reads naturally on a shipping page; the plain
 *   "in a straight line" says the thing the qualifier exists to say, which is
 *   that the number is not road distance.
 */
const AR: ShareStrings = {
  pageTitle: (order) => `تتبّع الشحنة — ${order}`,
  brand: 'كارا هوجا',

  groupNow: 'الحالة',
  groupShipment: 'الشحنة',
  groupCargo: 'الحمولة',
  groupCarrier: 'النقل',

  lastFix: 'آخر تحديث للموقع',
  remaining: 'المسافة المتبقية',
  asTheCrowFlies: 'بخط مستقيم',
  destination: 'الوجهة',
  plannedDelivery: 'موعد التسليم المقرّر',
  orderNumber: 'رقم الطلب',
  consignee: 'المرسَل إليه',
  plate: 'رقم اللوحة',
  driver: 'السائق',
  driverPhone: 'هاتف السائق',
  carrier: 'شركة النقل',
  items: 'الأصناف',
  quantity: 'الكمية',
  noFixYet: 'لم يُستلم موقع بعد',

  statusPreparing: 'قيد التجهيز',
  statusOnTheRoadTitle: 'في الطريق',
  statusOnBreakTitle: 'في استراحة',
  statusDepartingTitle: 'على وشك الانطلاق',
  statusDepartingDetail: 'السائق جاهز، وسيبدأ التتبّع بعد قليل.',
  statusDeliveredTitle: 'تم التسليم',
  statusDeliveredDetail: 'تم تسليم الشحنة.',
  statusCancelledTitle: 'أُلغيت',
  statusCancelledDetail: 'أُلغيت هذه الشحنة. للتفاصيل يُرجى التواصل مع مسؤول الشحن لديكم.',
  statusFinishedTitle: 'انتهى التتبّع',
  statusFinishedDetail:
    'انتهى تتبّع الشاحنة. لتأكيد التسليم يُرجى التواصل مع مسؤول الشحن لديكم.',
  statusStoppedDetail: 'الشاحنة متوقّفة حاليًا. التتبّع مستمر.',
  statusDriverReady: 'السائق جاهز، وسيبدأ التتبّع بعد قليل.',
  statusPlannedNotStarted: 'الشحنة مجدولة، ولم تنطلق الشاحنة بعد.',

  signalLive: 'الشاحنة في الطريق، والموقع يُحدَّث مباشرةً.',
  signalDelayed: 'الشاحنة في الطريق. لم يُحدَّث الموقع منذ بضع دقائق.',
  signalStale:
    'الشاحنة في الطريق. تعذّر استلام الموقع منذ فترة، وقد تكون خارج نطاق التغطية.',
  signalLost:
    'الشاحنة في الطريق. تعذّر استلام الموقع حاليًا، وقد تكون خارج نطاق التغطية.',
  signalNone: 'الشاحنة في الطريق.',

  mapLoading: 'جارٍ تحميل الخريطة…',
  mapFailed: 'تعذّر تحميل الخريطة. المعلومات أعلاه محدَّثة.',
  mapNoPosition: 'لم تُبلّغ الشاحنة عن موقعها بعد.',

  agoJustNow: 'قبل لحظات',
  agoMinutes: 'دقيقة مضت',
  agoHours: 'ساعة مضت',
  agoDays: 'يوم مضى',

  noticeInvalidTitle: 'الرابط غير صالح',
  noticeInvalidBody:
    'لم يعد رابط التتبّع هذا صالحًا. يمكنكم طلب رابط جديد من مسؤول الشحن لديكم.',
  noticeUnknownBody:
    'تعذّر فتح رابط التتبّع هذا. تأكّدوا من نسخ الرابط كاملًا؛ وإن استمرت المشكلة يُرجى التواصل مع مسؤول الشحن لديكم.',
  noticeExpiredTitle: 'انتهت صلاحية الرابط',
  noticeExpiredBody:
    'انتهت مدة تتبّع هذه الشحنة. للحصول على معلومات محدَّثة يُرجى التواصل معنا.',
  noticeErrorTitle: 'تعذّر فتح الصفحة حاليًا',
  noticeErrorBody:
    'تعذّر جلب بيانات الشحنة بسبب مشكلة مؤقتة. يُرجى المحاولة مرة أخرى بعد بضع دقائق.',

  switchLanguage: 'Türkçe',
  footerPrivate:
    'هذه الصفحة رابط خاص أُنشئ لهذه الشحنة وحدها، ويُغلق عند انتهاء صلاحيته. يُرجى عدم مشاركته مع أطراف أخرى.',
  footerContact: 'لأي استفسار يُرجى التواصل مع مسؤول الشحن لديكم.',
};

export const SHARE_STRINGS: Record<ShareLocale, ShareStrings> = { tr: TR, ar: AR };

export function strings(locale: ShareLocale): ShareStrings {
  return SHARE_STRINGS[locale];
}

/** The other language, for the switcher. */
export function otherLocale(locale: ShareLocale): ShareLocale {
  return locale === 'ar' ? 'tr' : 'ar';
}
