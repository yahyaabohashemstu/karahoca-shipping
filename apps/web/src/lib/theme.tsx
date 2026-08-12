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
}

const Ctx = createContext<ThemeCtx>({ pref: 'system', resolved: 'light', setPref: () => {} });

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

  useEffect(() => {
    let stored: ThemePref = 'system';
    try {
      stored = (localStorage.getItem(KEY) as ThemePref) || 'system';
    } catch {
      /* storage unavailable — stay on system */
    }
    setPrefState(stored);
    setResolved(stored === 'system' ? (systemDark() ? 'dark' : 'light') : stored);
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

  return <Ctx.Provider value={{ pref, resolved, setPref }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
