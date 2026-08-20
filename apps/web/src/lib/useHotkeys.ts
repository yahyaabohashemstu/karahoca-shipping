'use client';

import { useEffect, useRef, useState } from 'react';

/* =============================================================================
   Keyboard shortcuts
   =============================================================================
   The dispatcher's hands are on a keyboard and a telephone, not on a mouse.
   Everything the dashboard does frequently — find a lorry, clear the screen,
   step down the list, dismiss a panel — has a key, and this is the one place
   that decides what a key press means.

   Two rules make the difference between shortcuts that help and shortcuts that
   sabotage:

     A bare letter must never fire while someone is typing. `s` is the silent
     filter and it is also the fourth letter of "Şırnak". Typing a customer name
     into the search box would otherwise reorder the list underneath the cursor.

     A modifier combination must fire even while someone is typing. Ctrl+K is
     how you reach the command palette *from* the search box, and a dispatcher
     who has to click out of a field first has lost the seconds the palette
     existed to save.
   ========================================================================== */

/**
 * `mod` is Command on a Mac and Control everywhere else — which is what a
 * keyboard shortcut means when it is written ⌘K on one machine and Ctrl+K on
 * the next, and the office runs both.
 */
export type Hotkey = string;

type Handler = (event: KeyboardEvent) => void;

/** Does this event originate from somewhere that text is being entered? */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Turn a KeyboardEvent into the same string shape the bindings are written in.
 *
 * `event.key`, not `event.code`. A Turkish keyboard maps physical keys
 * differently from a US one, and a shortcut has to follow the letter printed on
 * the cap the dispatcher is looking at.
 */
function describe(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(event.key.toLowerCase());
  return parts.join('+');
}

/**
 * Bind a set of shortcuts for as long as the component is mounted.
 *
 * The binding table is read through a ref, so handlers may close over fresh
 * state without the listener being torn down and rebuilt on every render —
 * which, on a dashboard that re-renders every second from a position feed,
 * would mean adding and removing a document listener sixty times a minute.
 */
export function useHotkeys(bindings: Record<Hotkey, Handler>, enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      // A dead key or an IME composition is not a shortcut. Without this, every
      // Arabic and Turkish letter entered through a composition sequence would
      // be tested against the table mid-word.
      if (event.isComposing) return;

      const combo = describe(event);
      const handler = ref.current[combo];
      if (!handler) return;

      const modified = combo.startsWith('mod') || combo.startsWith('alt');
      // Escape is the universal way out and must work from inside a field.
      if (isTyping(event.target) && !modified && event.key !== 'Escape') return;

      event.preventDefault();
      handler(event);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/**
 * ⌘ or Ctrl, whichever this machine actually uses.
 *
 * Resolved after mount rather than during render: the server has no way to know
 * which platform is asking, and a shortcut hint that says ⌘ for one frame and
 * then Ctrl is worse than one that appears a frame late.
 */
export function useModKeyLabel(): string {
  const [label, setLabel] = useState('Ctrl');
  useEffect(() => {
    const platform =
      // userAgentData is the non-deprecated source; navigator.platform is the
      // fallback that still works in Firefox and Safari.
      (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform ??
      '';
    if (/mac|iphone|ipad/i.test(platform)) setLabel('⌘');
  }, []);
  return label;
}
