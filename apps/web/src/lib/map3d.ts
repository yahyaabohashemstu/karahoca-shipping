'use client';

/* =============================================================================
   Turning the basemap into a world
   =============================================================================
   Four separate things make a MapLibre map read as three-dimensional, and they
   are independent — each can be switched off on its own when the hardware or
   the network cannot carry it:

     camera     a pitched, rotatable view. Free, and the only one that is
                strictly required: without pitch nothing else is visible.
     sky        an atmosphere at the horizon. Free. Without it a pitched map
                ends in a hard edge against the page background, which reads as
                a rendering bug rather than as distance.
     buildings  fill-extrusion over the basemap's own building polygons. Costs
                nothing extra to fetch — the geometry is already in the vector
                tiles the map is downloading anyway — and is what makes a truck
                driving into Gaziantep look like it is driving into a city.
     terrain    real elevation. The expensive one, and the only one needing a
                source we do not already have.

   On terrain and why it is proxied: MapLibre decodes DEM tiles by reading
   their pixels, which a browser will not allow across origins without CORS.
   Checked, rather than assumed — the AWS Open Data terrarium bucket serves the
   tiles at 200 but sends no Access-Control-Allow-Origin, so the canvas taints
   and every elevation reads as zero. MapTiler and friends want an API key. So
   the API carries a small passthrough that adds the header and caches, and
   NEXT_PUBLIC_TERRAIN_URL points somewhere else when an operator has their own.
   ========================================================================== */

import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { API_BASE } from './api';

const TERRAIN_SOURCE = 'kh-terrain';
const BUILDINGS_LAYER = 'kh-buildings-3d';

/** Vertical exaggeration. 1.0 is true scale and looks disappointingly flat. */
const TERRAIN_EXAGGERATION = 1.25;

const TERRAIN_URL =
  process.env.NEXT_PUBLIC_TERRAIN_URL?.trim() || `${API_BASE}/terrain/{z}/{x}/{y}.png`;

/**
 * The first symbol layer in the style.
 *
 * Extrusions have to go under the labels or a town name ends up buried inside
 * a block of flats. Found rather than named, because the answer differs
 * between positron and dark and would differ again for a self-hosted style.
 */
function firstSymbolLayer(map: MapLibreMap): string | undefined {
  const layers = (map.getStyle() as StyleSpecification | undefined)?.layers ?? [];
  return layers.find((l) => l.type === 'symbol')?.id;
}

/** The vector source the basemap draws its own geometry from. */
function vectorSourceId(map: MapLibreMap): string | undefined {
  const sources = (map.getStyle() as StyleSpecification | undefined)?.sources ?? {};
  return Object.keys(sources).find((id) => sources[id]?.type === 'vector');
}

/**
 * Extruded buildings, in the theme's own greys.
 *
 * Height comes from `render_height`, which the OpenMapTiles schema fills in
 * from OSM's `height` and `building:levels` tags. Where neither exists the
 * coalesce puts the building at 8 m — one storey more than nothing, which
 * keeps a city block from looking like a car park while being honest that the
 * number is a guess.
 *
 * Opacity is below 1 on purpose. Solid extrusions swallow the trucks: a
 * vehicle on a street between two blocks disappears behind the near one at any
 * pitch worth having, and a dispatcher who cannot see a truck does not care how
 * good the buildings look.
 */
export function installBuildings(map: MapLibreMap, theme: 'light' | 'dark') {
  if (map.getLayer(BUILDINGS_LAYER)) return;
  const source = vectorSourceId(map);
  if (!source) return;

  const wall = theme === 'dark' ? '#2b3440' : '#d8dee6';
  const roof = theme === 'dark' ? '#3a4654' : '#eef1f5';

  try {
    map.addLayer(
      {
        id: BUILDINGS_LAYER,
        type: 'fill-extrusion',
        source,
        'source-layer': 'building',
        // Below this the extrusions are a grey haze over the whole city and
        // cost a full geometry upload for it. 12.5 rather than 13 because
        // FleetMap's fit-to-fleet caps at zoom 13: with the ramp starting at 13
        // every building was exactly 0 m tall at the zoom the map opens on.
        minzoom: 12.5,
        paint: {
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8],
            0, wall,
            60, roof,
          ],
          'fill-extrusion-height': [
            // Grow out of the ground between z13 and z14.5 rather than popping
            // into existence at full height on a zoom threshold.
            'interpolate', ['linear'], ['zoom'],
            12.5, 0,
            14, ['coalesce', ['get', 'render_height'], 8],
          ],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.82,
          // Darkens each wall toward its base. One property, and it does more
          // for the sense of height than the geometry does.
          'fill-extrusion-vertical-gradient': true,
        },
      },
      firstSymbolLayer(map),
    );
  } catch {
    /*
     * A style without a `building` source-layer is a legitimate configuration
     * — NEXT_PUBLIC_MAP_STYLE can point anywhere — and it is not worth failing
     * the map over. Everything else 3D still works.
     */
  }
}

export function removeBuildings(map: MapLibreMap) {
  if (map.getLayer(BUILDINGS_LAYER)) map.removeLayer(BUILDINGS_LAYER);
}

/**
 * Atmosphere.
 *
 * `atmosphere-blend` is keyed to zoom rather than left constant: at country
 * scale a strong horizon haze reads as fog over the whole map, and at street
 * scale no haze at all leaves the skyline pasted on. The fog colour is warmer
 * than the sky so distance goes slightly amber, which is what distance
 * actually does.
 */
export function installSky(map: MapLibreMap, theme: 'light' | 'dark') {
  const dark = theme === 'dark';
  map.setSky({
    'sky-color': dark ? '#0b1622' : '#a8c9e8',
    'horizon-color': dark ? '#1d2c3d' : '#dce8f3',
    'fog-color': dark ? '#0e1a26' : '#e8eef4',
    'fog-ground-blend': 0.5,
    'horizon-fog-blend': 0.62,
    'sky-horizon-blend': 0.72,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.2, 8, 0.6, 13, 0.28],
  });
}

/**
 * Elevation.
 *
 * Deliberately not awaited and deliberately not fatal. DEM tiles are the
 * slowest thing on the page and the one most likely to fail — a proxy that is
 * down, an operator who set NEXT_PUBLIC_TERRAIN_URL to something wrong, a
 * dispatcher on hotel wifi. In every one of those cases the map must still be
 * a working fleet map, tilted, with buildings, minus the hills.
 */
function installTerrain(map: MapLibreMap) {
  if (map.getTerrain()) return;
  try {
    if (!map.getSource(TERRAIN_SOURCE)) {
      map.addSource(TERRAIN_SOURCE, {
        type: 'raster-dem',
        tiles: [TERRAIN_URL],
        // Terrarium: elevation packed as (r * 256 + g + b / 256) - 32768.
        // The alternative, Mapbox's terrain-rgb, is not openly licensed.
        encoding: 'terrarium',
        tileSize: 256,
        // The source data is SRTM/ASTER at roughly 30 m; asking for z16 tiles
        // gets upsampled mush and four times the requests.
        maxzoom: 14,
        attribution:
          '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a>',
      });
    }
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
  } catch {
    /* No hills. Everything else still works. */
  }
}

export function removeTerrain(map: MapLibreMap) {
  try {
    map.setTerrain(null);
  } catch {
    /* already gone */
  }
}

/*
 * Terrain has a ceiling, and it is not a performance tweak.
 *
 * Gaziantep sits at 850 m. Exaggerated 1.25×, that is a 1,060 m plateau. Zoom
 * past ~15 with the camera pitched over and the eye point descends below that
 * surface — the camera ends up inside the hill it is standing on. MapLibre
 * notices and clamps the pitch, which is the least bad thing it can do, and
 * the result on screen is the ground gone, the extrusions floating, and two
 * black slabs across the view where the inside of the terrain mesh is. That is
 * not a description of a theory: it is a screenshot, taken on this machine's
 * real GPU at zoom 15.4 and pitch 62, with MapLibre reporting back a pitch of
 * 56 it had silently corrected to.
 *
 * The ceiling costs nothing, because terrain has nothing to say at street
 * zoom. A city block is flat; what carries the third dimension there is the
 * buildings and the vehicles, both of which keep working. It also happens to
 * be exactly where the DEM source runs out of real data.
 *
 * The two thresholds are hysteresis. One value means a dispatcher parked on the
 * boundary tears terrain down and builds it back up on every wheel notch, and
 * each rebuild refetches DEM tiles.
 */
const TERRAIN_ON_BELOW = 13.6;
const TERRAIN_OFF_ABOVE = 14.4;

/**
 * Bring terrain into line with the current zoom, cheaply enough to call on
 * every zoom event.
 */
export function syncTerrain(map: MapLibreMap, dimensional: boolean) {
  const has = !!map.getTerrain();
  if (!dimensional) {
    if (has) removeTerrain(map);
    return;
  }
  const zoom = map.getZoom();
  if (has && zoom > TERRAIN_OFF_ABOVE) removeTerrain(map);
  else if (!has && zoom < TERRAIN_ON_BELOW) installTerrain(map);
}

/* -----------------------------------------------------------------------------
   Camera
   -------------------------------------------------------------------------- */

/** Pitch the 3D view settles at. Steeper hides more map behind the trucks. */
export const DEFAULT_PITCH = 52;

export function setDimensional(map: MapLibreMap, on: boolean, animate = true) {
  if (on) {
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.setMaxPitch(75);
  }

  const target = { pitch: on ? DEFAULT_PITCH : 0, bearing: on ? map.getBearing() : 0 };
  // freezeElevation for the reason spelled out in FleetMap's follow-selection
  // easeTo: this animation runs at exactly the moment terrain is being added or
  // removed, which is the worst possible time for MapLibre to re-read it.
  if (animate) map.easeTo({ ...target, duration: 700, freezeElevation: true });
  else {
    map.setPitch(target.pitch);
    map.setBearing(target.bearing);
  }

  if (!on) {
    // Only after the easeTo has been issued: disabling the handler first would
    // not stop the animation, but disabling max pitch would clamp it mid-flight
    // and the camera would jump instead of settling.
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    window.setTimeout(() => {
      if (map.getPitch() === 0) map.setMaxPitch(0);
    }, animate ? 750 : 0);
  }
}
