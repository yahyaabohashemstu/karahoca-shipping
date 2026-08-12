'use client';

/* =============================================================================
   Basemap selection
   =============================================================================
   The dashboard used to point at OpenFreeMap's `liberty` style — a full-colour
   general-purpose basemap with 111 layers, built for people looking at places.
   Two problems for a fleet overlay:

   1. It renders motorways in orange and amber, which is exactly the colour of
      a DELAYED truck, and exactly where trucks are. Water is blue, parks are
      green. Every semantic colour in this product was competing with a basemap
      designed for tourists.

   2. 111 layers is a lot of style work on a page that a dispatcher leaves open
      for eight hours on office hardware.

   `positron` (55 layers) and `dark` (47) are desaturated by design: roads are
   grey, so the only saturated pixels on the screen are the trucks. Half the
   layers, and the overlay is finally the loudest thing on the map.

   Both are free, keyless, unmetered and cleared for commercial use, and
   MapLibre emits the required attribution automatically.
   ========================================================================== */

const LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const DARK = 'https://tiles.openfreemap.org/styles/dark';

/**
 * NEXT_PUBLIC_MAP_STYLE, when set, overrides both themes — it is the escape
 * hatch for pointing at a self-hosted tile server, at which point the operator
 * owns the light/dark question too.
 */
const OVERRIDE = process.env.NEXT_PUBLIC_MAP_STYLE?.trim() || null;

export function mapStyleFor(theme: 'light' | 'dark'): string {
  if (OVERRIDE) return OVERRIDE;
  return theme === 'dark' ? DARK : LIGHT;
}

/**
 * Marker, route and label colours, read from the active theme's tokens.
 *
 * MapLibre paint properties are plain strings, not CSS, so they cannot
 * reference a custom property and do not re-evaluate when the theme changes.
 * Reading the computed values here is what lets one token definition drive both
 * the DOM and the canvas — and it must be called again after every `setStyle`.
 */
export function mapColors() {
  const s = getComputedStyle(document.documentElement);
  const tok = (name: string, fallback = '136 136 136') => {
    const v = s.getPropertyValue(name).trim() || fallback;
    return `rgb(${v.replace(/\s+/g, ',')})`;
  };
  return {
    LIVE: tok('--kh-map-live'),
    DELAYED: tok('--kh-map-delayed'),
    STALE: tok('--kh-map-stale'),
    LOST: tok('--kh-map-lost'),
    NO_SIGNAL: tok('--kh-map-nosignal'),
    route: tok('--kh-map-route'),
    destination: tok('--kh-map-destination'),
    /** Marker outline — the page surface, so a dot reads as sitting on the map. */
    ring: tok('--kh-surface', '255 255 255'),
    /** Plate labels drawn on the canvas. */
    label: tok('--kh-text', '14 23 27'),
    labelHalo: tok('--kh-surface', '255 255 255'),
  };
}
