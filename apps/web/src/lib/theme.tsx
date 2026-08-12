'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type Resolved = 'light' | 'dark';

const KEY = 'kh.theme';

/**
 * Runs before first paint, inlined into <head>.
 *
 * Without this the page renders light, React hydrates, and the theme snaps to
 * dark — a white flash straight into the eyes of someone who chose dark mode
 * precisely because they stare at this screen all day. It has to be a blocking
 * inline script; there is no React lifecycle early enough.
 *
 * Kept deliberately tiny and wrapped in try/catch: localStorage throws in
 * private-mode Safari and in an iframe with third-party cookies blocked, and a
 * throw here would leave the document unstyled.
 */
export const THEME_SCRIPT = `(function(){try{
var p=localStorage.getItem('${KEY}')||'system';
var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.setAttribute('data-theme',d?'dark':'light');
}catch(e){document.documentElement.setAttribute('data-theme','light')}})()`;

interface ThemeCtx {
  pref: ThemePref;
  resolved: Resolved;
  setPref: (p: ThemePref) => void;
  /**
   * False until the stored preference has been read.
   *
   * `resolved` starts at 'light' so the server and the first client render
   * agree, then flips to the real value in an effect. Anything that merely
   * paints can ignore that one frame — but anything that BUILDS something from
   * the theme must wait, because rebuilding it costs more than a repaint.
   *
   * MapLibre is the case that forced this. Child effects run before parent
   * effects in React, so a map created in FleetMap's mount effect was always
   * constructed with 'light'; the provider then resolved to 'dark' and the map
   * had to setStyle, which discards every source and layer the application
   * added. Re-adding them from a `styledata` handler races the style load and
   * leaves a source that exists in JavaScript and has no tiles behind it — the
   * features are present, the layers are visible, and MapLibre paints nothing.
   *
   * Gating construction on this removes the swap, and with it the whole race.
   */
  ready: boolean;
}

const Ctx = createContext<ThemeCtx>({
  pref: 'system',
  resolved: 'light',
  setPref: () => {},
  ready: false,
});

function systemDark() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Both initialisers must match what the server rendered, or React logs a
  // hydration mismatch. The real value is applied in the effect below, and the
  // inline script has already put the correct attribute on <html>, so nothing
  // is visibly wrong during the one frame they disagree.
  const [pref, setPrefState] = useState<ThemePref>('system');
  const [resolved, setResolved] = useState<Resolved>('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: ThemePref = 'system';
    try {
      stored = (localStorage.getItem(KEY) as ThemePref) || 'system';
    } catch {
      /* storage unavailable — stay on system */
    }
    setPrefState(stored);
    setResolved(stored === 'system' ? (systemDark() ? 'dark' : 'light') : stored);
    setReady(true);
  }, []);

  // Follow the OS only while the user has not made an explicit choice.
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    setResolved(p === 'system' ? (systemDark() ? 'dark' : 'light') : p);
    try {
      if (p === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {
      /* nothing to do; the choice simply will not survive a reload */
    }
  }, []);

  return <Ctx.Provider value={{ pref, resolved, setPref, ready }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
