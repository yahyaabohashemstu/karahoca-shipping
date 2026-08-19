import type { Dictionary } from './tr';

/* =============================================================================
   Kurdish — Kurmanji, in Latin script
   =============================================================================
   Which Kurdish this is matters, because the consignee page ships a different
   one. The readers here are KaraHoca's staff and the carriers they work with,
   hired out of Gaziantep, Şanlıurfa, Mardin and Şırnak, where Kurmanji in Latin
   letters is what people read and write. Erbil reads Sorani in Arabic script,
   and Erbil is the consignee, who has their own page — see share.i18n.ts.

   This is the same Kurdish the driver app ships, and the wording is kept in
   step with android/app/src/main/res/values-ku deliberately: a dispatcher
   reading "Şopandin çalak e" on this screen is looking at the same phrase the
   driver has on their phone.

   Left-to-right, and numbers arrive with Latin digits already, which suits this
   locale without further thought.
   ========================================================================== */

export const ku: Dictionary = {
  nav: {
    map: 'Nexşeya zindî',
    sessions: 'Danişîn',
    orders: 'Sipariş',
    customers: 'Muşterî',
    carriers: 'Şirketên veguhastinê',
    performance: 'Performans',
  },

  shell: {
    brandSub: 'Şopandina Barê',
    brandAria: 'Navenda Şopandina Barê ya KaraHoca',
    driverApp: 'Sepana şofêr',
    driverAppTitle: 'Rûpela sazkirina sepana şofêr — track.karahoca.com/app',
    signOut: 'Danişînê bigire',
    language: 'Ziman',
    themeSystem: (resolved) => `Dîmena pergalê (${resolved}) — ji bo guhertinê bitikîne`,
    themeDark: 'Dîmena tarî — derbasî ronî bibe',
    themeLight: 'Dîmena ronî — derbasî tarî bibe',
    themeResolvedDark: 'tarî',
    themeResolvedLight: 'ronî',
  },
  login: {
    heading: 'Navenda Şopandina Barê',
    tagline: 'Şopandina zindî ya barhelgirên şirketên derve',
    email: 'E-peyam',
    password: 'Şîfre',
    submit: 'Têkeve',
    submitting: 'Têketin didome…',
    failedTitle: 'Têketin pêk nehat',
    failedBody: 'Têketin bi ser neket. E-peyam û şîfreya xwe kontrol bike.',
  },
  titles: {
    appDefault: 'KaraHoca — Navenda Şopandina Barê',
    appDescription: 'Şopandina zindî û dîroka rêyê ji bo barhelgirên şirketên derve',
    login: 'Têketin',
    orderNew: 'Siparişa nû',
    sessionNew: 'Danişîna şopandinê ya nû',
    sessionDetail: 'Hûrgiliyên danişînê',
  },
  common: {
    loading: 'Tê barkirin…',
    loadFailed: 'Dane nehatin girtin',
    retry: 'Dîsa biceribîne',
    refresh: 'Nû bike',
    close: 'Bigire',
    confirm: 'Piştrast bike',
    cancel: 'Betal bike',
    search: 'Bigere…',
    clearSearch: 'Lêgerînê pak bike',
    previous: 'Berê',
    next: 'Pêş',
    live: 'Zindî',
    offline: 'Girêdan tune',
    staleData: 'Girêdan qut bû — agahiyên nîşandayî dibe kevn bin.',
  },
  errors: {
    routeTitle: 'Ev dîmen nehat barkirin',
    routeBody:
      'Xeletiyeke neçaverêkirî çêbû. Daneyên şopandinê li ser serverê parastî ne — ev tenê bandorê li vê tabê dike.',
    backToMap: 'Vegere nexşeya zindî',
    appTitle: 'Sepan nehat destpêkirin',
    appBody:
      'Daneyên şopandinê li ser serverê ewle ne. Rûpelê nû bike; ger pirsgirêk berdewam be rêveberê pergalê agahdar bike.',
    code: 'Koda xeletiyê',
    sessionExpired: 'Dema danişînê qediya.',
  },
};
