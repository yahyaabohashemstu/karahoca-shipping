/* =============================================================================
   The icon set
   =============================================================================
   One family, drawn to one set of rules, because a dock a dozen icons tall is
   the most concentrated place in the product for inconsistency to show:

     · a 20×20 box, so a 1.5px stroke lands on a whole pixel at the 18px size
       the dock renders them at
     · outline only, stroke 1.5, round caps and joins — no filled shapes, which
       would read as "selected" next to their outlined neighbours
     · every path inset to a 2px margin, so no icon touches its own edge and
       none looks larger than the rest at the same nominal size
     · currentColor throughout, so one class recolours an icon for hover, active
       and disabled without a second copy of it

   They are hand-drawn rather than pulled from a set because six of the eight
   are domain nouns — a tracking session, a haulage firm, a consignment — and no
   general-purpose icon library has those. A truck from one library beside a
   building from another is exactly the mismatch this file exists to prevent.
   ========================================================================== */

type IconProps = { className?: string };

const BOX = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/*
 * 19px at a 14px root.
 *
 * Up from 16px, which was drawn to the old 32px tile and looked starved once
 * the dock was the only navigation in the product — a 16px outline glyph in a
 * 36px well reads as an icon someone forgot to finish. 19px keeps a 1.5px
 * stroke landing near enough to a whole pixel to stay crisp, and leaves 8px of
 * clearance inside the 35px tile, which is what a tile needs to still read as a
 * button rather than as a frame around a picture.
 */
const SIZE = 'h-[1.35rem] w-[1.35rem] shrink-0';

/** Live map — a position pin, which is what the screen is actually about. */
export function IconMap({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M10 17.6s5.6-4.9 5.6-9a5.6 5.6 0 0 0-11.2 0c0 4.1 5.6 9 5.6 9Z" />
      <circle cx="10" cy="8.5" r="2.1" />
    </svg>
  );
}

/** Tracking sessions — a route between two points, not a clock or a list. */
export function IconRoute({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <circle cx="5" cy="15" r="2.1" />
      <circle cx="15" cy="5" r="2.1" />
      <path d="M6.6 13.5c1.2-1.2 1.4-2.4 2.6-3.5 1.2-1.2 2.5-1.4 3.6-2.6" strokeDasharray="0.1 2.6" />
    </svg>
  );
}

/** Orders — a consignment, drawn as a pallet-load rather than a document. */
export function IconOrder({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M10 2.6 16.8 6v8L10 17.4 3.2 14V6L10 2.6Z" />
      <path d="M3.4 6.1 10 9.4l6.6-3.3M10 9.4v8" />
    </svg>
  );
}

/** Customers — companies, so a building. A person icon would be wrong here. */
export function IconCustomer({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M4.2 17.4V4.4a.8.8 0 0 1 .8-.8h6a.8.8 0 0 1 .8.8v13" />
      <path d="M11.8 8.8h3.2a.8.8 0 0 1 .8.8v7.8" />
      <path d="M2.6 17.4h14.8" />
      <path d="M6.4 6.8h3M6.4 9.6h3M6.4 12.4h3" />
    </svg>
  );
}

/** Carriers — the haulage firm, which is a lorry the company does not own. */
export function IconCarrier({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M2.4 5.8h8.2v7.6H2.4z" />
      <path d="M10.6 8.6h3l2.6 2.7v2.1h-5.6z" />
      <circle cx="6" cy="14.8" r="1.5" />
      <circle cx="13.6" cy="14.8" r="1.5" />
    </svg>
  );
}

/** Performance — measured, so a chart. Deliberately the only abstract one. */
export function IconChart({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M3.2 16.8h13.6" />
      <path d="M6.2 16.8v-5.4M10 16.8V5.4M13.8 16.8v-3.4" strokeWidth={2} />
    </svg>
  );
}

/**
 * The driver app's install page — a handset with something arriving on it.
 *
 * Not a download tray and not an app-store glyph: what a dispatcher is doing
 * when they reach for this is putting software onto somebody else's telephone,
 * and the phone is the recognisable half of that.
 */
export function IconInstall({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <rect x="5.8" y="2.6" width="8.4" height="14.8" rx="1.8" />
      <path d="M10 6.2v4.9M7.9 9l2.1 2.1L12.1 9" />
      <path d="M8.9 15h2.2" />
    </svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <circle cx="8.8" cy="8.8" r="5.2" />
      <path d="m12.6 12.6 4 4" />
    </svg>
  );
}

/** Sign out — a door with an arrow leaving it. */
export function IconSignOut({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M8.2 3.2H4.4a.8.8 0 0 0-.8.8v12a.8.8 0 0 0 .8.8h3.8" />
      <path d="m12.4 13.2 3.2-3.2-3.2-3.2M15.6 10H7.4" />
    </svg>
  );
}

export function IconSun({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <circle cx="10" cy="10" r="3.6" />
      <path d="M10 1.6v2M10 16.4v2M18.4 10h-2M3.6 10h-2M15.94 4.06l-1.41 1.41M5.47 14.53l-1.41 1.41m11.88 0-1.41-1.41M5.47 5.47 4.06 4.06" />
    </svg>
  );
}

export function IconMoon({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M16.4 12.2A7 7 0 0 1 7.8 3.6a7 7 0 1 0 8.6 8.6Z" />
    </svg>
  );
}

/**
 * Focus — the frame that clears everything off the map.
 *
 * Four corner brackets with nothing between them: the icon is a picture of what
 * pressing it produces, which is an empty frame.
 */
export function IconFocus({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M3 7.4V4.2a1.2 1.2 0 0 1 1.2-1.2h3.2M17 7.4V4.2A1.2 1.2 0 0 0 15.8 3h-3.2M3 12.6v3.2A1.2 1.2 0 0 0 4.2 17h3.2M17 12.6v3.2a1.2 1.2 0 0 1-1.2 1.2h-3.2" />
    </svg>
  );
}

/** Restore — the same frame with its contents back. */
export function IconRestore({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M3 7.4V4.2a1.2 1.2 0 0 1 1.2-1.2h3.2M17 7.4V4.2A1.2 1.2 0 0 0 15.8 3h-3.2M3 12.6v3.2A1.2 1.2 0 0 0 4.2 17h3.2M17 12.6v3.2a1.2 1.2 0 0 1-1.2 1.2h-3.2" />
      <rect x="7" y="7" width="6" height="6" rx="1.2" />
    </svg>
  );
}

/** A chevron that points along the inline axis, whichever way the page reads. */
export function IconChevron({ className, back }: IconProps & { back?: boolean }) {
  return (
    <svg
      {...BOX}
      className={className ?? SIZE}
      // The glyph is physical; the meaning is logical. Mirroring the whole
      // element with the document is the only way an arrow labelled "collapse"
      // still points at the edge it collapses towards in Arabic.
      style={{ transform: back ? 'scaleX(var(--kh-dir))' : 'scaleX(calc(var(--kh-dir) * -1))' }}
    >
      <path d="m8 4.4 5.6 5.6L8 15.6" />
    </svg>
  );
}

export function IconClose({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="m5.4 5.4 9.2 9.2M14.6 5.4l-9.2 9.2" />
    </svg>
  );
}

/** Fit all — a viewfinder closing on a point. */
export function IconFit({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M2.8 6.6V3.4a.6.6 0 0 1 .6-.6h3.2M17.2 6.6V3.4a.6.6 0 0 0-.6-.6h-3.2M2.8 13.4v3.2a.6.6 0 0 0 .6.6h3.2M17.2 13.4v3.2a.6.6 0 0 1-.6.6h-3.2" />
      <circle cx="10" cy="10" r="1.9" />
    </svg>
  );
}

/** The 3D switch — an isometric cube. */
export function IconCube({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M10 2.6 16.8 6v8L10 17.4 3.2 14V6L10 2.6Z" />
      <path d="M3.4 6.1 10 9.4l6.6-3.3M10 9.4v8" />
      <path d="M6.6 7.6v4.2" strokeWidth={1.1} />
    </svg>
  );
}

export function IconPlus({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M10 4.2v11.6M4.2 10h11.6" />
    </svg>
  );
}

export function IconZoomIn({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M10 5.2v9.6M5.2 10h9.6" />
    </svg>
  );
}

export function IconZoomOut({ className }: IconProps) {
  return (
    <svg {...BOX} className={className ?? SIZE}>
      <path d="M5.2 10h9.6" />
    </svg>
  );
}

/**
 * The compass, for finding north again after a rotation.
 *
 * The north half is filled and the south half is not, which is the one place
 * this set breaks its own outline-only rule — because a compass whose halves
 * are both outlines does not tell you which end is north, which is its entire
 * job. The rotation is applied by the caller from the map's bearing.
 */
export function IconCompass({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className ?? SIZE}>
      <path d="M10 3.4 12.6 10H7.4z" fill="currentColor" />
      <path
        d="M10 16.6 7.4 10h5.2z"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
    </svg>
  );
}
