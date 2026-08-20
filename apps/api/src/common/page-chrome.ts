/* =============================================================================
   One design, on the pages the dashboard does not render
   =============================================================================
   Three HTML pages are served straight from this API rather than by Next: the
   consignee's tracking page, the driver's hand-off page, and the driver app's
   install page. They have no build step, no Tailwind and no shared component
   library — so left alone they drift, and they had. Three different blues, three
   different greys, three different corner radii, and a card that was 12px round
   on one page and 14px on the next.

   This is the common ground. The values are the dashboard's own dark theme,
   transcribed: --bg is its --kh-bg, --brand is its --kh-brand, the glass sheet
   is the same tint at the same alpha behind the same blur, and the shadow is
   the same four layers. A driver who scans a code and a purchasing manager who
   opens a link are looking at the same product as the dispatcher who sent them.

   Dark, and not by default. The scene for all three is a phone: an agent at a
   yard gate in Erbil, a driver in a cab at a loading dock, a stranded driver at
   two in the morning. More than half the consignee page is a basemap, and light
   chrome wrapped around a map is two designs arguing. The map decides;
   everything else follows.
   ========================================================================== */

/**
 * The palette and the geometry, as custom properties.
 *
 * Emitted inside `:root` by `pageStyle` below. Kept as a separate export so a
 * page can read a single token in an inline style without reproducing it.
 */
export const PAGE_TOKENS = `
  color-scheme: dark;

  /* Surfaces — the dashboard's dark ramp, transcribed from globals.css. */
  --bg:          #0b1012;
  --surface:     #12191c;
  --surface-2:   #192226;
  --surface-3:   #212c31;

  /* Lines */
  --line:        #263237;
  --line-strong: #394a51;

  /* Text. --ink-3 is the lightest that still measures above 4.5:1 on --bg. */
  --ink:         #e8eff1;
  --ink-2:       #9eb0b7;
  --ink-3:       #80929a;

  /* One accent, for interactive affordances only. */
  --brand:       #5298ff;
  --brand-hover: #78afff;
  --brand-soft:  #142742;

  /*
   * Status, and deliberately not the dispatcher's meanings.
   *
   * On the fleet map green means "the GPS is reporting". Here it has to mean
   * "your goods arrived" — the only outcome the reader is waiting for, and what
   * every parcel tracker they have ever used says it with. In transit is the
   * brand blue: progressing, not finished.
   */
  --done:        #5ee2ad;
  --live:        #5298ff;
  --wait:        #facc6c;
  --stop:        #ff8a8a;

  /* Glass — the same sheet the dashboard's floating panels are cut from. */
  --glass:       rgba(15, 21, 24, 0.72);
  --glass-solid: #12191c;
  --hairline:    rgba(255, 255, 255, 0.07);

  /* Geometry. Two radius families: sheets, and the controls inside them. */
  --r-sheet:     16px;
  --r-panel:     14px;
  --r-control:   10px;
  --r-chip:      8px;

  /* The one easing curve in the product. Covers most of the distance in the
     first third and settles, which is what makes a panel feel light. */
  --ease:        cubic-bezier(0.16, 1, 0.3, 1);
`;

/**
 * Reset, body, focus, and the handful of classes all three pages share.
 *
 * `.sheet` is the opaque panel, `.glass` the translucent one, `.btn` the
 * control. Everything else each page defines for itself, because beyond these
 * they have almost nothing in common: one is a status report, one is an eight
 * character code, one is a list of installation steps.
 */
export const PAGE_BASE = `
  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100dvh;
    font: 16px/1.5 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    background: var(--bg);
    color: var(--ink);
  }

  /*
   * A single wash of the brand colour behind everything, fixed to the viewport.
   *
   * Very large and at 7% opacity, so it reads as light in the room rather than
   * as a shape on the page. It is what stops a dark page from looking like an
   * unstyled document, and it costs one element with no layout impact.
   */
  body::before {
    content: '';
    position: fixed;
    inset: -30vh 0 auto;
    height: 70vh;
    background: radial-gradient(60% 55% at 50% 0%, rgba(82, 152, 255, 0.09), transparent 70%);
    pointer-events: none;
    z-index: 0;
  }
  body > * { position: relative; z-index: 1; }

  /* Every focusable thing gets the same visible ring, on every page. */
  :focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: 3px;
  }

  /* Digits that will be compared down a column must not jitter row to row. */
  .num { font-variant-numeric: tabular-nums; }

  /* ---------------------------------------------------------------- sheets -- */

  .sheet {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-sheet);
    box-shadow:
      inset 0 1px 0 var(--hairline),
      0 1px 2px rgba(0, 0, 0, 0.35),
      0 10px 28px -8px rgba(0, 0, 0, 0.5);
  }

  .glass {
    background: var(--glass);
    -webkit-backdrop-filter: blur(18px) saturate(180%);
    backdrop-filter: blur(18px) saturate(180%);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-sheet);
    box-shadow:
      inset 0 1px 0 var(--hairline),
      0 1px 2px rgba(0, 0, 0, 0.35),
      0 10px 28px -8px rgba(0, 0, 0, 0.5);
  }

  /* Both fallbacks collapse the sheet to opaque. Neither changes a dimension,
     so no layout depends on the blur being available. */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .glass { background: var(--glass-solid); }
  }
  @media (prefers-reduced-transparency: reduce) {
    .glass {
      background: var(--glass-solid);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  /* -------------------------------------------------------------- controls -- */

  .btn {
    display: block;
    width: 100%;
    padding: 15px 18px;
    border: 1px solid transparent;
    border-radius: var(--r-control);
    font: inherit;
    font-weight: 600;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    transition: background-color .18s var(--ease), border-color .18s var(--ease), color .18s var(--ease);
  }

  /*
   * The primary action is lit rather than raised — the accent colour itself,
   * spread and faded. A neutral drop shadow under a blue button on a dark page
   * is invisible, and this is the one control on each of these pages that a
   * reader must not have to look for.
   */
  .btn--primary {
    background: var(--brand);
    color: #06101f;
    box-shadow: 0 2px 14px -2px rgba(82, 152, 255, 0.55);
  }
  .btn--primary:hover { background: var(--brand-hover); }

  .btn--quiet {
    background: transparent;
    color: var(--ink-2);
    border-color: var(--line-strong);
  }
  .btn--quiet:hover { color: var(--ink); border-color: var(--ink-3); }

  /* ------------------------------------------------------------ the switcher -- */
  /*
   * The language links, on every page that has more than one.
   *
   * A flex row rather than inline text, so the options do not reflow into the
   * middle of a sentence when one of them is right-to-left and the page is not —
   * which is guaranteed here, since the Turkish page lists two right-to-left
   * names side by side. No text-align: the flex line follows the page direction
   * on its own.
   */
  .langs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .lang { color: var(--ink-3); text-decoration: underline; text-underline-offset: 3px; }
  .lang:hover { color: var(--ink); }
  .lang__sep { color: var(--ink-3); opacity: .5; }

  /* ---------------------------------------------------------------- motion -- */

  @keyframes rise {
    from { opacity: 0; transform: translateY(10px) scale(.985); }
    to   { opacity: 1; transform: none; }
  }
  .rise { animation: rise .28s var(--ease) both; }

  @media (prefers-reduced-motion: reduce) {
    .rise { animation: none; }
    .btn { transition: none; }
  }
`;

/**
 * The `<style>` element every page opens with.
 *
 * Takes the page's own rules and appends them, so the shared layer can never be
 * accidentally overridden by load order — a page's rules always come last.
 */
export function pageStyle(pageCss = ''): string {
  return `<style>
  :root {${PAGE_TOKENS}  }
${PAGE_BASE}
${pageCss}
</style>`;
}

/**
 * The document head, minus the title.
 *
 * `viewport-fit=cover` matters on the two driver pages: they are opened from a
 * camera scan on a phone held in one hand, often with a notch.
 */
export function pageHead(title: string, style: string): string {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0b1012">
<title>${title}</title>
${style}
</head>`;
}
