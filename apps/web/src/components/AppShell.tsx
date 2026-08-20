'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { tokens } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useHotkeys, useModKeyLabel } from '@/lib/useHotkeys';
import { NavDock } from './shell/NavDock';
import { CommandPalette } from './CommandPalette';
import { IconRestore } from './shell/Icons';

/* =============================================================================
   Application shell
   =============================================================================
   Two layouts out of one set of chrome.

   `canvas` is the live map: the child fills the viewport corner to corner and
   every piece of chrome floats on top of it. Nothing is beside the map, above
   it, or beneath it, because on this product the map is not a view — it is the
   surface the application is drawn on.

   Everything else is a page: the same dock, and the content in a raised sheet
   inset from all four edges so the background shows around it. That inset is
   not decoration. It is what makes a page read as the same kind of object as
   the panels floating on the map, instead of as a different application that
   happens to share a navigation bar.

   The shell also owns two things no single screen can own: the command palette,
   which must open from anywhere including from inside a text field, and focus
   mode, which must be able to hide the dock — and therefore cannot be
   controlled by anything the dock contains.
   ========================================================================== */

/** Dock width plus its margin on both sides. Quoted by the page inset below. */
const CONTENT_INSET = '5.3rem';

interface ShellState {
  /** Every piece of chrome is hidden and the map is unobstructed. */
  focus: boolean;
  setFocus: (value: boolean) => void;
  /** True while the command palette has the keyboard. */
  paletteOpen: boolean;
  openPalette: () => void;
}

const ShellCtx = createContext<ShellState>({
  focus: false,
  setFocus: () => {},
  paletteOpen: false,
  openPalette: () => {},
});

/**
 * Read by the screens that draw their own floating panels, so that one key can
 * clear every overlay in the product at once rather than each screen inventing
 * its own idea of what "hide the chrome" means.
 */
export function useShell(): ShellState {
  return useContext(ShellCtx);
}

export function AppShell({
  children,
  /** The live map: the child owns the whole viewport and all chrome floats. */
  canvas,
  /** A page whose child manages its own scrolling — a detail screen with a map. */
  fill,
}: {
  children: React.ReactNode;
  canvas?: boolean;
  fill?: boolean;
}) {
  const t = useT();
  const modKey = useModKeyLabel();
  const [focus, setFocus] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
   * Focus mode only means anything where there is something behind the chrome.
   * Leaving it latched on while the dispatcher walks to the orders screen would
   * hide the navigation on a page with nothing underneath it to look at.
   */
  useEffect(() => {
    if (!canvas) setFocus(false);
  }, [canvas]);

  useHotkeys({
    'mod+k': () => setPaletteOpen(true),
    // A bare letter, which useHotkeys will not deliver while anything is being
    // typed — so this can never fire out of the fleet search box.
    f: () => canvas && setFocus((v) => !v),
    escape: () => {
      // Only the outermost concern. The palette closes itself, and the screens
      // below handle their own selection, because Escape has to peel one layer
      // at a time rather than resetting everything at once.
      if (!paletteOpen && focus) setFocus(false);
    },
  });

  const chrome = !focus;

  return (
    <ShellCtx.Provider
      value={{ focus, setFocus, paletteOpen, openPalette: () => setPaletteOpen(true) }}
    >
      <div className="relative h-screen overflow-hidden bg-bg">
        {canvas ? (
          // The map. Nothing is layered under it and nothing shares its box.
          <div className="absolute inset-0 z-canvas">{children}</div>
        ) : (
          <div
            className="h-full py-3 pe-3"
            style={{ paddingInlineStart: CONTENT_INSET }}
          >
            <div className="kh-sheet flex h-full min-h-0 flex-col overflow-hidden rounded-2xl">
              {fill ? (
                children
              ) : (
                <div className="kh-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
                  {children}
                </div>
              )}
            </div>
          </div>
        )}

        {chrome && <NavDock onOpenPalette={() => setPaletteOpen(true)} modKey={modKey} />}

        {/*
          The way back.

          Focus mode removes every control including the one that turned it on,
          so something has to remain. This is the smallest thing that can: one
          tile in the corner the dock vacated, in the same place, so the hand
          that reached for the dock finds it without the eye being involved.
        */}
        {focus && (
          <button
            type="button"
            onClick={() => setFocus(false)}
            aria-label={t.shell.focusExit}
            title={`${t.shell.focusExit}  ·  F`}
            className="kh-glass kh-pop-in fixed start-3 top-3 z-dock grid h-9 w-9 place-items-center rounded-xl text-ink-2 transition-colors hover:text-ink"
          >
            <IconRestore />
          </button>
        )}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          modKey={modKey}
        />
      </div>
    </ShellCtx.Provider>
  );
}

/**
 * Client-side auth gate.
 *
 * The old pages each ran `useEffect(() => { if (!tokens.access) location.href = '/login' })`
 * and rendered their content in the meantime — a flash of the dispatcher
 * dashboard, complete with a failing API call, before the redirect landed.
 * Here nothing renders until the check has run.
 */
export function useRequireAuth(): boolean {
  const router = useRouter();
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (tokens.access) {
      setOk(true);
    } else {
      setOk(false);
      router.replace('/login');
    }
  }, [router]);

  return ok === true;
}
