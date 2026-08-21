/* =============================================================================
   The driver's own language
   =============================================================================
   Two pages are read by a driver rather than by anyone at KaraHoca: the
   hand-off page reached by scanning a printed code, and the install page whose
   URL gets read aloud down a telephone. Both were Turkish only.

   That is a real failure and not a cosmetic one. The company does not employ
   these drivers — they arrive from a third-party haulage firm, out of
   Gaziantep, Şanlıurfa, Mardin and Şırnak, and a good number of them read
   Kurdish or Arabic before they read Turkish. The install page is a list of
   five instructions about permissions and unknown-source warnings; a driver who
   cannot read it either telephones the dispatcher or gives up, and a driver who
   gives up is a shipment nobody can see.

   KURMANJI, IN LATIN SCRIPT — not the Sorani the consignee page offers.

   The two surfaces have different readerships and the distinction is
   load-bearing. Erbil, who receives the goods, reads Sorani in Arabic script.
   A driver hired out of south-eastern Turkey reads Kurmanji in Latin letters.
   Offering the wrong one is offering nothing, so this file deliberately
   duplicates the shape of share.i18n.ts rather than sharing it: the same three
   slots, a different third language. Parameterising one module by "which
   Kurdish" would be more coupling than either side is worth.
   ========================================================================== */

export type DriverLocale = 'tr' | 'ar' | 'ku';

/** In the order the switcher lists them. */
export const DRIVER_LOCALES: readonly DriverLocale[] = ['tr', 'ar', 'ku'] as const;

export function isRtl(locale: DriverLocale): boolean {
  return locale === 'ar';
}

/** What the switcher calls each option, in that language. */
export const DRIVER_LOCALE_NAME: Record<DriverLocale, string> = {
  tr: 'Türkçe',
  ar: 'العربية',
  ku: 'Kurdî',
};

export interface DriverStrings {
  language: string;

  installTitle: string;
  installHeading: string;
  installLead: string;
  download: string;
  /** What the file is and what it needs, under the download button. */
  fileKind: string;
  requirement: string;
  stepsTitle: string;
  steps: readonly string[];
  installNote: string;

  handoffTitle: string;
  handoffHeading: string;
  handoffLead: string;
  codeLabel: string;
  openInApp: string;
  downloadApk: string;
  hint: string;

  /*
   * The release panel.
   *
   * Only a signed-in administrator ever sees these — the page is otherwise
   * driver-facing and public — but they are translated like everything else,
   * because the person running a Turkish yard should not be the one user in
   * the product reading English.
   */
  releaseTitle: string;
  releaseLive: string;
  releaseStaged: string;
  releaseNone: string;
  releaseAnnounce: string;
  releaseWorking: string;
  releaseDone: string;
  releaseFailed: string;
  releaseUpToDate: string;
  releaseExplain: string;
}

const TR: DriverStrings = {
  language: 'Dil',

  installTitle: 'KaraHoca Sürücü Uygulaması',
  installHeading: 'Sürücü Takip Uygulaması',
  installLead: 'Android telefonlar için.',
  download: 'Uygulamayı indir',
  fileKind: 'APK dosyası',
  // minSdk 26 in app/build.gradle.kts. Stated because a driver on a five-year-old
  // handset should find out here rather than after a 20 MB download on mobile data.
  requirement: 'Android 8.0 ve üzeri',
  stepsTitle: 'Kurulum adımları',
  steps: [
    'İndirme bitince dosyaya dokunun.',
    'Telefon “bilinmeyen kaynak” uyarısı verirse izin verin — uygulama Play Store’da değildir.',
    'Kurulumdan sonra uygulamayı açın.',
    'Sevkiyat sorumlunuzun gönderdiği karekodu okutun; kod otomatik yazılır. Karekod yoksa 8 haneli kodu elle girin.',
    'Listedeki tüm izinleri verin, sonra takibi başlatın.',
  ],
  installNote:
    'Uygulama zaten yüklüyse tekrar indirmeniz gerekmez; doğrudan karekodu okutun. Sorun yaşarsanız sevkiyat sorumlunuzu arayın.',

  handoffTitle: 'KaraHoca Sevkiyat Takibi',
  handoffHeading: 'Sevkiyat Takip Oturumu',
  handoffLead: 'Uygulamayı açın ve bu kodu girin.',
  codeLabel: 'Oturum kodu',
  openInApp: 'Uygulamada aç',
  downloadApk: 'Uygulamayı indir (APK)',
  hint: 'Sorun yaşarsanız sevkiyat sorumlunuzu arayın.',

  releaseTitle: 'Sürüm yayını',
  releaseLive: 'Sürücülerdeki sürüm',
  releaseStaged: 'Yayına hazır',
  releaseNone: 'Bekleyen sürüm yok',
  releaseAnnounce: 'Yeni sürümü indir',
  releaseWorking: 'Yayınlanıyor…',
  releaseDone: 'Yayınlandı. Eski sürümdeki sürücülere bildirim gidiyor.',
  releaseFailed: 'Yayınlanamadı',
  releaseUpToDate: 'Sürücüler zaten bu sürümde.',
  releaseExplain:
    'Bildirim yalnızca daha eski sürümdeki telefonlara gider. Güncel olanlar hiçbir şey görmez.',
};

const AR: DriverStrings = {
  language: 'اللغة',

  installTitle: 'تطبيق السائقين — كارا هوجا',
  installHeading: 'تطبيق تتبّع السائق',
  installLead: 'لهواتف أندرويد.',
  download: 'نزّل التطبيق',
  fileKind: 'ملف APK',
  requirement: 'أندرويد 8.0 أو أحدث',
  stepsTitle: 'خطوات التثبيت',
  steps: [
    'بعد انتهاء التنزيل، اضغط على الملف.',
    'إذا حذّرك الهاتف من «مصدر غير معروف»، فاسمح بالتثبيت — التطبيق ليس على متجر Play.',
    'بعد التثبيت، افتح التطبيق.',
    'امسح رمز QR الذي أرسله مسؤول الشحن؛ يُكتب الرمز تلقائيًا. وإن لم يكن هناك رمز، أدخل الرمز المكوّن من 8 خانات يدويًا.',
    'امنح كل الأذونات المطلوبة، ثم ابدأ التتبّع.',
  ],
  installNote:
    'إذا كان التطبيق مثبّتًا بالفعل فلا حاجة إلى تنزيله مجددًا؛ امسح رمز QR مباشرة. وإذا واجهت مشكلة، اتصل بمسؤول الشحن.',

  handoffTitle: 'تتبّع الشحنة — كارا هوجا',
  handoffHeading: 'جلسة تتبّع الشحنة',
  handoffLead: 'افتح التطبيق وأدخل هذا الرمز.',
  codeLabel: 'رمز الجلسة',
  openInApp: 'افتح في التطبيق',
  downloadApk: 'نزّل التطبيق (APK)',
  hint: 'إذا واجهت مشكلة، اتصل بمسؤول الشحن.',

  releaseTitle: 'إطلاق النسخة',
  releaseLive: 'النسخة لدى السائقين',
  releaseStaged: 'جاهزة للإطلاق',
  releaseNone: 'لا توجد نسخة بانتظار الإطلاق',
  releaseAnnounce: 'نزّل النسخة الجديدة',
  releaseWorking: 'جارٍ الإطلاق…',
  releaseDone: 'تمّ الإطلاق. يصل الإشعار الآن إلى السائقين ذوي النسخة الأقدم.',
  releaseFailed: 'تعذّر الإطلاق',
  releaseUpToDate: 'السائقون على هذه النسخة أصلًا.',
  releaseExplain:
    'يصل الإشعار إلى الهواتف ذات النسخة الأقدم فقط. ومن لديه النسخة الأخيرة لا يصله شيء.',
};

const KU: DriverStrings = {
  language: 'Ziman',

  installTitle: 'Sepana Ajokaran — KaraHoca',
  installHeading: 'Sepana Şopandinê ya Ajokar',
  installLead: 'Ji bo têlefonên Android.',
  download: 'Sepanê daxîne',
  fileKind: 'Pelê APK',
  requirement: 'Android 8.0 û jortir',
  stepsTitle: 'Gavên sazkirinê',
  steps: [
    'Piştî ku daxistin qediya, li pelî bitikîne.',
    'Heke têlefon hişyariya “çavkaniya nenas” bide, destûrê bide — sepan ne li Play Store ye.',
    'Piştî sazkirinê, sepanê veke.',
    'Koda QR ya berpirsê barkirinê şandiye bixwîne; kod bixweber tê nivîsandin. Heke QR tune be, koda 8 reqemî bi destan binivîse.',
    'Hemû destûrên di lîsteyê de bide, paşê şopandinê dest pê bike.',
  ],
  installNote:
    'Heke sepan jixwe sazkirî be, ne hewce ye tu dîsa daxînî; rasterast koda QR bixwîne. Heke pirsgirêk hebe, gazî berpirsê barkirinê bike.',

  handoffTitle: 'Şopandina Barê — KaraHoca',
  handoffHeading: 'Danişîna Şopandina Barê',
  handoffLead: 'Sepanê veke û vê kodê binivîse.',
  codeLabel: 'Koda danişînê',
  openInApp: 'Di sepanê de veke',
  downloadApk: 'Sepanê daxîne (APK)',
  hint: 'Heke pirsgirêk hebe, gazî berpirsê barkirinê bike.',

  releaseTitle: 'Belavkirina guhertoyê',
  releaseLive: 'Guhertoya li cem şofêran',
  releaseStaged: 'Amade ye ji bo belavkirinê',
  releaseNone: 'Guhertoyek li bendê tune',
  releaseAnnounce: 'Guhertoya nû dabeş bike',
  releaseWorking: 'Tê belavkirin…',
  releaseDone: 'Hat belavkirin. Agahdarî diçe şofêrên bi guhertoya kevntir.',
  releaseFailed: 'Belavkirin bi ser neket',
  releaseUpToDate: 'Şofêr jixwe li ser vê guhertoyê ne.',
  releaseExplain:
    'Agahdarî tenê diçe telefonên bi guhertoyeke kevntir. Yên nûtirîn tiştekî nabînin.',
};

const DICTIONARIES: Record<DriverLocale, DriverStrings> = { tr: TR, ar: AR, ku: KU };

export function driverStrings(locale: DriverLocale): DriverStrings {
  return DICTIONARIES[locale];
}

function isDriverLocale(value: unknown): value is DriverLocale {
  return typeof value === 'string' && (DRIVER_LOCALES as readonly string[]).includes(value);
}

/**
 * Which language to render in.
 *
 * There is no country signal available here — unlike the consignee page, which
 * knows where the customer is. A hand-off code is scanned off a sheet of paper
 * at a loading dock and carries nothing about who is holding the phone. So the
 * order is simply: what was asked for, then what the phone is set to, then
 * Turkish.
 *
 * The phone is a better signal for a driver than it is for a consignee: a
 * tracking link gets forwarded through WhatsApp and often opens on somebody
 * else's device, but nobody forwards a hand-off code — the driver scans it with
 * their own phone, and that phone's language is very probably theirs.
 */
export function resolveDriverLocale(
  query: string | undefined,
  acceptLanguage: string | undefined,
): DriverLocale {
  if (isDriverLocale(query)) return query;

  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    // `ku-TR`, `ckb`, `kmr` all mean a Kurdish reader; the only Kurdish this
    // surface has is Kurmanji, so any of them lands there rather than nowhere.
    if (tag === 'ku' || tag === 'kmr' || tag === 'ckb') return 'ku';
    if (tag === 'ar') return 'ar';
    if (tag === 'tr') return 'tr';
  }
  return 'tr';
}

/** Primary subtags, highest q-value first. */
function parseAcceptLanguage(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .filter((p) => p.startsWith('q='))
        .map((p) => Number.parseFloat(p.slice(2)))[0];
      return { tag: tag.trim().toLowerCase().split('-')[0], q: Number.isFinite(q) ? q : 1 };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

/**
 * The switcher, as markup.
 *
 * Every option carries its own `lang` and `dir`, so a browser lays "العربية"
 * out right-to-left inside a left-to-right footer instead of mangling it, and a
 * screen reader set to Turkish does not read the Arabic name as nonsense. The
 * current language is not a link to itself — a link that goes nowhere is a
 * dead control, and on a page with four of them that matters.
 */
export function languageSwitcher(current: DriverLocale, strings: DriverStrings): string {
  const others = DRIVER_LOCALES.filter((l) => l !== current);
  const links = others
    .map(
      (l) =>
        `<a class="lang" href="?lang=${l}" hreflang="${l}" lang="${l}" dir="${
          isRtl(l) ? 'rtl' : 'ltr'
        }">${DRIVER_LOCALE_NAME[l]}</a>`,
    )
    .join('<span class="lang__sep" aria-hidden="true">·</span>');
  return `<nav class="langs" aria-label="${strings.language}">${links}</nav>`;
}
