'use client';

/* =============================================================================
   The lorries, drawn as solids
   =============================================================================
   A MapLibre custom layer that renders every vehicle in the fleet as an actual
   three-dimensional truck, in one instanced draw call, with no dependency
   beyond the WebGL context MapLibre already owns.

   Three things in here are not obvious and all three are load-bearing.

   1. FLOAT PRECISION. Mercator coordinates live in [0,1], so a metre is about
      2.5e-8 of one — and float32 resolves roughly 3e-8 near x = 0.58, which is
      where Turkey is. Handing raw mercator positions to the GPU as attributes
      therefore quantises every truck onto a ~1.2 m lattice and makes it twitch
      between two positions as it drives. The fix is the standard one: pick an
      anchor near the fleet, fold it into the projection matrix in JavaScript
      (which is double precision throughout), and give the shader only small
      anchor-relative offsets. MapLibre's customLayerMatrix() is a plain Array
      of doubles — verified, not assumed — so nothing is lost on the way in.

   2. THE MERCATOR Y FLIP. Web Mercator's +Y points south while every sane
      vehicle frame has +Y pointing north, so the model matrix contains a
      reflection. Push a normal through a reflection and it comes out
      inside-out, which lights the truck from underneath. Rather than carry a
      separate normal matrix, the lighting is computed in the model's own frame
      and the light direction is rotated into it — the reflection never touches
      a normal because no normal ever leaves model space.

   3. SIZE. A 16.5 m lorry at zoom 11 is a third of a pixel. Drawing it to scale
      would be honest and useless, so the model is inflated to hold a floor of
      ~26 px on screen and the inflation decays to 1.0 at around zoom 17.5,
      where a truck is finally a truck-sized object on a real street. Below
      zoom 9.5 the layer does not draw at all and the flat markers carry the
      map, because forty perspective lorries at country scale is not a fleet
      view, it is a mess.
   ========================================================================== */

import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';
import { buildTruckMesh, TRUCK_LENGTH_M, type TruckMesh } from './truckMesh';

/** One vehicle to draw. Positions are WGS84; the layer handles the rest. */
export interface Truck {
  id: string;
  lng: number;
  lat: number;
  /** Degrees clockwise from north. Parked vehicles keep their last heading. */
  bearingDeg: number;
  /** Status colour, sRGB 0-255 — the same value the flat markers use. */
  colour: [number, number, number];
  selected: boolean;
}

/** Below this the flat markers own the map; the layer early-returns. */
export const TRUCK_3D_MIN_ZOOM = 9.5;

/** Screen length the model is inflated to hold, in CSS pixels. */
const MIN_SCREEN_PX = 26;

/** Beyond this the wheels are sub-pixel and the hull-only index range is used. */
const WHEEL_LOD_ZOOM = 13.5;

const FLOATS_PER_INSTANCE = 9; // offset(3) bearing(1) scale(1) colour(3) glow(1)

const VERTEX_SRC = `
precision highp float;

attribute vec3 a_pos;        // metres, vehicle frame: +x right, +y forward, +z up
attribute vec3 a_normal;
attribute vec2 a_surface;    // x = share of the status colour, y = brightness

attribute vec3 i_offset;     // mercator units, relative to the anchor
attribute float i_bearing;   // radians clockwise from north
attribute float i_scale;     // metres -> mercator units at this latitude
attribute vec3 i_colour;     // linear 0-1
attribute float i_glow;

uniform mat4 u_matrix;       // projection * translate(anchor)
uniform float u_boost;       // visual inflation, 1.0 = true scale
uniform vec3 u_light;        // unit vector toward the key light, in (east, north, up)
uniform float u_ambient;

varying vec3 v_colour;

void main() {
    float s = sin(i_bearing);
    float c = cos(i_bearing);

    // Vehicle frame -> ENU. Forward maps to (sin, cos); right to (cos, -sin).
    vec3 enu = vec3(
        a_pos.x * c + a_pos.y * s,
       -a_pos.x * s + a_pos.y * c,
        a_pos.z
    );

    // ENU -> mercator. North is -Y, and metres become mercator units here.
    vec3 local = vec3(enu.x, -enu.y, enu.z) * (i_scale * u_boost);

    gl_Position = u_matrix * vec4(i_offset + local, 1.0);

    // ENU -> vehicle frame, the transpose of the rotation above. See note 2:
    // the light comes to the normal, never the other way round.
    vec3 L = vec3(
        u_light.x * c - u_light.y * s,
        u_light.x * s + u_light.y * c,
        u_light.z
    );

    vec3 n = normalize(a_normal);
    float key = max(dot(n, L), 0.0);
    // Sky bounce. Without it every roof — which is most of what is visible from
    // a dispatcher's camera angle — shades identically to a shadowed flank.
    float sky = max(n.z, 0.0) * 0.17;

    vec3 base = mix(vec3(0.60), i_colour, a_surface.x) * a_surface.y;
    v_colour = base * (u_ambient + key * 0.78 + sky) + i_glow * 0.20;
}
`;

const FRAGMENT_SRC = `
precision mediump float;
varying vec3 v_colour;
uniform float u_opacity;
void main() {
    // Premultiplied: MapLibre's translucent pass blends with ONE,
    // ONE_MINUS_SRC_ALPHA, and unpremultiplied colour haloes on the seams.
    gl_FragColor = vec4(clamp(v_colour, 0.0, 1.0) * u_opacity, u_opacity);
}
`;

/**
 * Mercator units per metre at a given latitude.
 *
 * Same quantity as MercatorCoordinate.meterInMercatorCoordinateUnits(), spelled
 * out so the layer does not need a MercatorCoordinate per truck per update —
 * forty allocations every two seconds, all of them thrown away.
 */
function metresToMercator(lat: number): number {
  return 1 / (6378137 * 2 * Math.PI * Math.cos((lat * Math.PI) / 180));
}

function mercatorX(lng: number): number {
  return (180 + lng) / 360;
}

function mercatorY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** sRGB 0-255 to the linear 0-1 the shader lights in. */
function toLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

interface GLBits {
  program: WebGLProgram;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  instanceBuffer: WebGLBuffer;
  attrib: Record<string, number>;
  uniform: Record<string, WebGLUniformLocation | null>;
  /** Normalised across WebGL2 and the WebGL1 ANGLE extension. */
  divisor: (index: number, value: number) => void;
  drawInstanced: (count: number, instances: number) => void;
}

export class TruckLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private bits: GLBits | null = null;
  private readonly mesh: TruckMesh;

  /**
   * Whether to draw at all.
   *
   * A flag rather than removing the layer: removing it destroys the GPU
   * objects and re-adding rebuilds a shader program, so a dispatcher toggling
   * the view twice would recompile it twice. It is also not `visibility`,
   * which MapLibre's custom-layer wrapper honours inconsistently across
   * versions — a boolean checked at the top of render cannot be got wrong.
   */
  enabled = true;

  private trucks: Truck[] = [];
  private instances = new Float32Array(0);
  private instanceCount = 0;
  private instancesDirty = false;

  /** Mercator anchor the offsets are relative to. See note 1 at the top. */
  private anchorX = 0;
  private anchorY = 0;

  /** Scratch, reused every frame so the render path allocates nothing. */
  private readonly matrix = new Float32Array(16);

  constructor(id = 'trucks-3d') {
    this.id = id;
    this.mesh = buildTruckMesh();
  }

  // ---- data ----------------------------------------------------------------

  /**
   * Replace the fleet.
   *
   * Cheap to call on every position frame: it rebuilds a typed array of nine
   * floats per vehicle and marks it for upload. The upload itself happens on
   * the next render, so a burst of socket frames between two paints costs one
   * bufferData rather than one per frame.
   */
  setTrucks(trucks: Truck[]) {
    this.trucks = trucks;
    this.rebuild();
    this.map?.triggerRepaint();
  }

  /**
   * Re-read terrain heights, and repaint only if any of them moved.
   *
   * DEM tiles stream in after the trucks are already placed, so a vehicle put
   * down while the elevation was still unknown sits at sea level — which in
   * the mountains north of Şırnak is two kilometres underground.
   *
   * The `changed` check is not an optimisation, it is what stops a render
   * loop. The obvious wiring for this is the map's `idle` event, and it is a
   * trap: idle fires after a paint, this triggers a paint, that paint fires
   * idle again, and the map never stops rendering for as long as the tab is
   * open. Returning false when nothing moved is what breaks that cycle — and
   * it also means the common case, a fleet on ground whose heights are already
   * known, costs one comparison per vehicle and no frame at all.
   */
  refreshElevation(): boolean {
    if (this.trucks.length === 0 || !this.map?.getTerrain()) return false;

    const before = this.instances.slice(0, this.instanceCount * FLOATS_PER_INSTANCE);
    this.rebuild();

    let changed = false;
    for (let n = 0; n < this.instanceCount; n++) {
      const at = n * FLOATS_PER_INSTANCE + 2;
      // Mercator units. A tenth of a metre at this latitude is ~2.5e-9, well
      // above float noise and well below anything a person could see.
      if (Math.abs(before[at] - this.instances[at]) > 2.5e-9) {
        changed = true;
        break;
      }
    }

    if (changed) this.map.triggerRepaint();
    return changed;
  }

  private rebuild() {
    const count = this.trucks.length;
    if (this.instances.length < count * FLOATS_PER_INSTANCE) {
      this.instances = new Float32Array(Math.max(count, 16) * FLOATS_PER_INSTANCE);
    }

    if (count > 0) {
      // Anchor on the fleet's mean position. Any point within a few hundred
      // kilometres would do — the spread, not the absolute location, is what
      // has to stay small enough for float32.
      let sx = 0;
      let sy = 0;
      for (const t of this.trucks) {
        sx += mercatorX(t.lng);
        sy += mercatorY(t.lat);
      }
      this.anchorX = sx / count;
      this.anchorY = sy / count;
    }

    const map = this.map;
    const array = this.instances;

    for (let n = 0; n < count; n++) {
      const t = this.trucks[n];
      const scale = metresToMercator(t.lat);

      // queryTerrainElevation returns null with terrain off, which is the
      // common case and correctly means "sit on the sea-level plane".
      let elevation = 0;
      if (map?.getTerrain()) {
        elevation = map.queryTerrainElevation({ lng: t.lng, lat: t.lat }) ?? 0;
      }

      const o = n * FLOATS_PER_INSTANCE;
      array[o] = mercatorX(t.lng) - this.anchorX;
      array[o + 1] = mercatorY(t.lat) - this.anchorY;
      array[o + 2] = elevation * scale;
      array[o + 3] = (t.bearingDeg * Math.PI) / 180;
      array[o + 4] = scale;
      array[o + 5] = toLinear(t.colour[0]);
      array[o + 6] = toLinear(t.colour[1]);
      array[o + 7] = toLinear(t.colour[2]);
      array[o + 8] = t.selected ? 1 : 0;
    }

    this.instanceCount = count;
    this.instancesDirty = true;
  }

  // ---- lifecycle -----------------------------------------------------------

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;

    const program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);

    const vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.vertices, gl.STATIC_DRAW);

    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);

    const instanceBuffer = gl.createBuffer()!;

    const attrib: Record<string, number> = {};
    for (const name of ['a_pos', 'a_normal', 'a_surface', 'i_offset', 'i_bearing', 'i_scale', 'i_colour', 'i_glow']) {
      attrib[name] = gl.getAttribLocation(program, name);
    }
    const uniform: Record<string, WebGLUniformLocation | null> = {};
    for (const name of ['u_matrix', 'u_boost', 'u_light', 'u_ambient', 'u_opacity']) {
      uniform[name] = gl.getUniformLocation(program, name);
    }

    /*
     * Instancing, whichever way this context provides it.
     *
     * MapLibre 4 will happily hand back a WebGL1 context on older hardware —
     * which in this fleet's case means the office machine in Gaziantep, not a
     * hypothetical. ANGLE_instanced_arrays has been in every browser since
     * 2013, so the fallback is real rather than theoretical, and the only
     * difference is the name of two functions.
     */
    const gl2 = (gl as WebGL2RenderingContext).drawElementsInstanced ? (gl as WebGL2RenderingContext) : null;
    const angle = gl2 ? null : gl.getExtension('ANGLE_instanced_arrays');
    if (!gl2 && !angle) {
      throw new Error('instanced rendering unavailable; 3D vehicles need it');
    }

    this.bits = {
      program,
      vertexBuffer,
      indexBuffer,
      instanceBuffer,
      attrib,
      uniform,
      divisor: gl2
        ? (index, value) => gl2.vertexAttribDivisor(index, value)
        : (index, value) => angle!.vertexAttribDivisorANGLE(index, value),
      drawInstanced: gl2
        ? (count, instances) => gl2.drawElementsInstanced(gl2.TRIANGLES, count, gl2.UNSIGNED_SHORT, 0, instances)
        : (count, instances) =>
            angle!.drawElementsInstancedANGLE(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0, instances),
    };

    if (this.trucks.length > 0) this.rebuild();
  }

  onRemove() {
    const gl = this.gl;
    const bits = this.bits;
    if (gl && bits) {
      gl.deleteProgram(bits.program);
      gl.deleteBuffer(bits.vertexBuffer);
      gl.deleteBuffer(bits.indexBuffer);
      gl.deleteBuffer(bits.instanceBuffer);
    }
    this.bits = null;
    this.gl = null;
    this.map = null;
  }

  // ---- render --------------------------------------------------------------

  /*
   * `matrix` is typed ArrayLike rather than Float64Array on purpose.
   *
   * MapLibre declares it as gl-matrix's `mat4`, which is an IndexedCollection —
   * a readonly indexable, not a typed array — and `render` is an interface
   * property rather than a method, so it is checked contravariantly. Naming a
   * narrower type here does not compile. At runtime it is a plain Array of
   * doubles (customLayerMatrix returns `this.mercatorMatrix.slice()`), which is
   * what the precision argument in note 1 depends on.
   */
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: ArrayLike<number>) {
    const bits = this.bits;
    const map = this.map;
    if (!bits || !map || !this.enabled || this.instanceCount === 0) return;

    const zoom = map.getZoom();
    if (zoom < TRUCK_3D_MIN_ZOOM) return;

    gl.useProgram(bits.program);

    /*
     * Fold the anchor translation into the projection matrix, in double
     * precision, before anything is narrowed to float32.
     *
     * Column-major, so the translation lands in the fourth column and every
     * other column is untouched. Doing this here rather than in the shader is
     * the entire point of note 1: JavaScript arithmetic is f64, so the large
     * cancellation happens where there are digits to spare.
     */
    const m = matrix;
    const ax = this.anchorX;
    const ay = this.anchorY;
    const out = this.matrix;
    for (let i = 0; i < 12; i++) out[i] = m[i];
    out[12] = m[0] * ax + m[4] * ay + m[12];
    out[13] = m[1] * ax + m[5] * ay + m[13];
    out[14] = m[2] * ax + m[6] * ay + m[14];
    out[15] = m[3] * ax + m[7] * ay + m[15];
    gl.uniformMatrix4fv(bits.uniform.u_matrix, false, out);

    /*
     * Inflation. Hold a floor of MIN_SCREEN_PX of length on screen, and never
     * shrink below true scale — a truck rendered smaller than a truck would be
     * a lie in the one situation where the map is finally showing reality.
     */
    const metresPerPixel =
      (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** zoom;
    const boost = Math.max(1, (MIN_SCREEN_PX * metresPerPixel) / TRUCK_LENGTH_M);
    gl.uniform1f(bits.uniform.u_boost, boost);

    // Key light from the north-west and well above the horizon: a low sun
    // throws the near flank into darkness at exactly the pitch a dispatcher
    // uses, and the plate label sits on that flank.
    gl.uniform3f(bits.uniform.u_light, -0.42, 0.55, 0.72);
    gl.uniform1f(bits.uniform.u_ambient, 0.46);
    gl.uniform1f(bits.uniform.u_opacity, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, bits.vertexBuffer);
    const stride = this.mesh.vertexStride;
    bindAttrib(gl, bits.attrib.a_pos, 3, stride, 0);
    bindAttrib(gl, bits.attrib.a_normal, 3, stride, 12);
    bindAttrib(gl, bits.attrib.a_surface, 2, stride, 24);

    gl.bindBuffer(gl.ARRAY_BUFFER, bits.instanceBuffer);
    if (this.instancesDirty) {
      gl.bufferData(gl.ARRAY_BUFFER, this.instances, gl.DYNAMIC_DRAW);
      this.instancesDirty = false;
    }
    const istride = FLOATS_PER_INSTANCE * 4;
    bindAttrib(gl, bits.attrib.i_offset, 3, istride, 0);
    bindAttrib(gl, bits.attrib.i_bearing, 1, istride, 12);
    bindAttrib(gl, bits.attrib.i_scale, 1, istride, 16);
    bindAttrib(gl, bits.attrib.i_colour, 3, istride, 20);
    bindAttrib(gl, bits.attrib.i_glow, 1, istride, 32);
    for (const name of ['i_offset', 'i_bearing', 'i_scale', 'i_colour', 'i_glow']) {
      if (bits.attrib[name] >= 0) bits.divisor(bits.attrib[name], 1);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bits.indexBuffer);

    /*
     * Face culling is deliberately left off.
     *
     * The mercator Y flip reverses the winding of every triangle, so culling
     * back faces here would cull the front ones instead — correctable with
     * frontFace(CW), but that is a second piece of state to set, restore, and
     * get wrong. The mesh is a closed solid and the depth buffer is already
     * doing the occlusion; culling would save fill rate on 350 triangles.
     */
    const indexCount = zoom >= WHEEL_LOD_ZOOM ? this.mesh.indices.length : this.mesh.hullIndexCount;
    bits.drawInstanced(indexCount, this.instanceCount);

    /*
     * Put the vertex attribute state back.
     *
     * MapLibre's Context caches depth, blend and cull state and restores those
     * itself, but it has no idea about attribute divisors or which arrays are
     * enabled. A divisor left at 1 on attribute location 3 turns MapLibre's
     * next symbol layer into a single smeared glyph — which is exactly the
     * kind of bug that gets blamed on the basemap for a week.
     */
    for (const name of ['i_offset', 'i_bearing', 'i_scale', 'i_colour', 'i_glow']) {
      if (bits.attrib[name] >= 0) bits.divisor(bits.attrib[name], 0);
    }
    for (const location of Object.values(bits.attrib)) {
      if (location >= 0) gl.disableVertexAttribArray(location);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }
}

function bindAttrib(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  location: number,
  size: number,
  stride: number,
  offset: number,
) {
  if (location < 0) return;
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
}

function linkProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`truck shader failed to compile: ${log}`);
    }
    return shader;
  };

  const vertex = compile(gl.VERTEX_SHADER, vertexSrc);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // Flagged for deletion now; the driver frees them when the program goes.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`truck shader failed to link: ${log}`);
  }
  return program;
}
