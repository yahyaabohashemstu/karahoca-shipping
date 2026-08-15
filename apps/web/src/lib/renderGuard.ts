'use client';

/* =============================================================================
   Stopping one thrown error from killing the map for good
   =============================================================================
   MapLibre 4.7 has a latch in it. From
   node_modules/maplibre-gl/dist/maplibre-gl-unminified.js, verbatim:

       run(timeStamp = 0) {
           if (this._currentlyRunning) throw new Error('Attempting to run(), but is already running.');
           const queue = this._currentlyRunning = this._queue;
           this._queue = [];
           for (const task of queue) {
               if (task.cancelled) continue;
               task.callback(timeStamp);          // <- anything may throw here
               if (this._cleared) break;
           }
           this._cleared = false;
           this._currentlyRunning = false;        // <- never reached if it did
       }

   There is no try/finally. So a single throw out of any queued task leaves
   `_currentlyRunning` holding an array — truthy — for ever. `Map._render` calls
   `this._renderTaskQueue.run(...)` as its first real statement, so from that
   moment every frame throws on line one and `painter.render` is never reached
   again. The canvas holds its last painted frame permanently. `_renderTaskQueue`
   is only cleared by `Map.remove()`, so nothing short of destroying the map
   recovers it.

   Worse, it is silent. `triggerRepaint` awaits `_render` under a bare
   `.catch(() => { })`, so neither the original error nor the thousands of
   "already running" errors after it reach the console. A dispatcher reports a
   frozen map with a clean console, which is exactly what happened here and
   exactly why two rounds of fixes could not be confirmed.

   And it takes the input handlers with it: HandlerManager queues its frame into
   the same queue and clears its `_frameId` from inside that task, so with the
   queue latched the flag is never cleared and wheel-zoom and drag stop driving
   the camera too.

   This restores the missing try/finally from outside, and — the part that
   matters more — makes the failure loud. The specific throw that was found has
   been fixed at source (see freezeElevation in FleetMap and map3d); this is so
   that the NEXT one costs a stutter and a log line instead of a dead map and a
   week of guessing.

   Remove it if MapLibre ever ships the try/finally. Until then the patch is
   shape-checked and declines to apply if the internals have moved.
   ========================================================================== */

import type { Map as MapLibreMap } from 'maplibre-gl';

interface TaskQueueLike {
  run: (timeStamp?: number) => void;
  _currentlyRunning: unknown;
  _cleared: boolean;
}

interface PatchableMap {
  _renderTaskQueue?: TaskQueueLike;
}

/**
 * Wrap the map's render task queue so a throwing task cannot latch it.
 *
 * Returns true if the patch was applied. `onError` is called with the original
 * error, once per throw, so the application can surface something rather than
 * leaving the user to wonder.
 */
export function guardRenderQueue(
  map: MapLibreMap,
  onError: (error: unknown) => void,
): boolean {
  const queue = (map as unknown as PatchableMap)._renderTaskQueue;
  if (!queue || typeof queue.run !== 'function' || !('_currentlyRunning' in queue)) {
    // A different MapLibre. Leave it alone rather than break something that
    // may no longer need this at all.
    return false;
  }
  if ((queue.run as { __khGuarded?: boolean }).__khGuarded) return true;

  const original = queue.run.bind(queue);
  const guarded = (timeStamp?: number) => {
    try {
      original(timeStamp);
    } catch (error) {
      /*
       * Exactly what the missing finally would have done, and nothing more.
       *
       * `_currentlyRunning` is set to the queue array on entry and back to
       * false on exit; restoring it is what lets the next frame start. The
       * `_cleared` flag is reset for the same reason — run() clears it at the
       * end and a task that threw after Map.remove() would otherwise leave it
       * set and truncate the following queue.
       */
      queue._currentlyRunning = false;
      queue._cleared = false;
      onError(error);
    }
  };
  (guarded as { __khGuarded?: boolean }).__khGuarded = true;
  queue.run = guarded;
  return true;
}
