import type { Dictionary } from './tr';

/* =============================================================================
   Arabic — Modern Standard
   =============================================================================
   The readers are KaraHoca's own staff. Gaziantep's logistics workforce is
   substantially Arabic-speaking, and the register is the same one the company's
   waybills, invoices and customs paperwork are already written in, so it is
   also the register a dispatcher expects on a screen.

   Two things kept consistent with the consignee page in apps/api/src/share, so
   that a dispatcher and the customer they are on the phone to are using the
   same words:

     الشاحنة for the lorry rather than المركبة. The Turkish "araç" is generic,
     but the person on either end of that call means one specific truck.

     Numbers and dates arrive already formatted — see format.ts — so nothing
     here should reintroduce Arabic-Indic numerals beside a Latin plate number.
   ========================================================================== */

export const ar: Dictionary = {
  nav: {
    map: 'الخريطة المباشرة',
    sessions: 'الجلسات',
    orders: 'الطلبات',
    customers: 'العملاء',
    carriers: 'شركات النقل',
    performance: 'الأداء',
  },

  shell: {
    brandSub: 'تتبّع الشحنات',
    brandAria: 'مركز كارا هوجا لتتبّع الشحنات',
    driverApp: 'تطبيق السائق',
    driverAppTitle: 'صفحة تثبيت تطبيق السائق — track.karahoca.com/app',
    signOut: 'تسجيل الخروج',
    language: 'اللغة',
    themeSystem: (resolved) => `مظهر النظام (${resolved}) — اضغط للتغيير`,
    themeDark: 'المظهر الداكن — التبديل إلى الفاتح',
    themeLight: 'المظهر الفاتح — التبديل إلى الداكن',
    themeResolvedDark: 'داكن',
    themeResolvedLight: 'فاتح',
  },
  login: {
    heading: 'مركز تتبّع الشحنات',
    tagline: 'تتبّع مباشر لشاحنات النقل الخارجية',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    submit: 'تسجيل الدخول',
    submitting: 'جارٍ تسجيل الدخول…',
    failedTitle: 'تعذّر تسجيل الدخول',
    failedBody: 'فشل تسجيل الدخول. تحقّق من بريدك الإلكتروني وكلمة المرور.',
  },
  titles: {
    appDefault: 'كارا هوجا — مركز تتبّع الشحنات',
    appDescription: 'تتبّع مباشر وسجلّ مسار لشاحنات النقل الخارجية',
    login: 'تسجيل الدخول',
    orderNew: 'طلب جديد',
    sessionNew: 'جلسة تتبّع جديدة',
    sessionDetail: 'تفاصيل الجلسة',
  },
  common: {
    loading: 'جارٍ التحميل…',
    loadFailed: 'تعذّر جلب البيانات',
    retry: 'أعد المحاولة',
    refresh: 'تحديث',
    close: 'إغلاق',
    confirm: 'تأكيد',
    cancel: 'إلغاء',
    search: 'بحث…',
    clearSearch: 'امسح البحث',
    previous: 'السابق',
    next: 'التالي',
    live: 'مباشر',
    offline: 'لا يوجد اتصال',
    staleData: 'انقطع الاتصال — قد تكون المعلومات المعروضة قديمة.',
  },
  errors: {
    routeTitle: 'تعذّر تحميل هذه الشاشة',
    routeBody:
      'حدث خطأ غير متوقّع. بيانات التتبّع محفوظة على الخادم — وهذا يؤثّر على تبويب المتصفّح هذا وحده.',
    backToMap: 'العودة إلى الخريطة المباشرة',
    appTitle: 'تعذّر تشغيل التطبيق',
    appBody:
      'بيانات التتبّع آمنة على الخادم. جرّب تحديث الصفحة؛ وإن استمرّت المشكلة أبلغ مسؤول النظام.',
    code: 'رمز الخطأ',
    sessionExpired: 'انتهت صلاحية الجلسة.',
  },
};
