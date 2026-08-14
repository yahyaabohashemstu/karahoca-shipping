/* =============================================================================
   A lorry, generated rather than downloaded
   =============================================================================
   There is no .glb in this repository and there is not going to be one. A glTF
   loader is ~40 kB before the model itself, the model is another 100-300 kB of
   binary nobody in this repo can review or diff, and it has to be hosted,
   cached and versioned alongside the app. For a vehicle that is a dozen boxes
   and eight cylinders, that is a large amount of machinery to acquire a shape
   we can write down exactly.

   Written down, the shape is also *ours*: the proportions are a European
   cab-over tractor with a curtainsider semi-trailer, which is what actually
   leaves the Gaziantep plant, rather than the American long-nose rig every
   free 3D truck model on the internet turns out to be.

   Units are metres, in the vehicle's own frame:

       +X  right          +Y  forward (toward the cab)      +Z  up

   Origin sits on the road surface at the centre of the rig, so placing one is
   a translation to the fix and a rotation by the bearing — no offset to
   remember, and a truck at elevation 0 has its wheels on the ground.
   ========================================================================== */

/** Turkish/EU maximum rig: 16.5 m long, 2.55 m wide, 4.0 m tall. */
export const TRUCK_LENGTH_M = 16.5;

export interface TruckMesh {
  /** Interleaved: position(3) normal(3) tint(1) shade(1) — 8 floats per vertex. */
  readonly vertices: Float32Array;
  readonly indices: Uint16Array;
  /**
   * Index count for the low-detail draw.
   *
   * Geometry is ordered [hull | wheels], so drawing only this many indices
   * yields the body without the running gear. At the zoom levels a dispatcher
   * actually works at, a wheel is a third of a pixel — the whole rig is 26 px —
   * and the eight cylinders are 288 triangles of nothing. Above the threshold
   * the full count is used and the wheels appear.
   */
  readonly hullIndexCount: number;
  readonly vertexStride: number;
}

/* -----------------------------------------------------------------------------
   Surface classes

   `tint` is how much of the vehicle's status colour a surface takes, and
   `shade` is its brightness. Two floats instead of a material id keeps the
   fragment shader branchless: one mix, one multiply.

   The status colour has to survive this. A dispatcher reads vehicle state off
   colour — the map legend says so — and a model that renders every lorry in
   photoreal white would have thrown that away in exchange for looking nice.
   So the trailer, which is far the largest surface, is the status colour at
   full strength; the cab is the same hue slightly darker so the two read as
   one vehicle with a joint in it; only the running gear is neutral.
   -------------------------------------------------------------------------- */
const TRAILER = { tint: 1.0, shade: 1.0 };
const CAB     = { tint: 1.0, shade: 0.82 };
const CHASSIS = { tint: 0.15, shade: 0.34 };
const TYRE    = { tint: 0.0, shade: 0.20 };
const RIM     = { tint: 0.35, shade: 0.62 };
const GLASS   = { tint: 0.10, shade: 0.46 };

interface Surface { tint: number; shade: number }

class MeshBuilder {
  private readonly v: number[] = [];
  private readonly i: number[] = [];

  get vertexCount() { return this.v.length / 8; }
  get indexCount() { return this.i.length; }

  /**
   * An axis-aligned box with flat-shaded faces.
   *
   * Twenty-four vertices, not eight: sharing corners would average the three
   * face normals into a diagonal and the box would shade like a sphere. On a
   * vehicle whose whole silhouette is right angles that reads as a smudge.
   */
  box(
    min: [number, number, number],
    max: [number, number, number],
    s: Surface,
    faces: { top?: Surface; front?: Surface } = {},
  ) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const F: Array<[[number, number, number], Array<[number, number, number]>, Surface]> = [
      // normal, four corners counter-clockwise seen from outside, surface
      [[0, 0, 1],  [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], faces.top ?? s],
      [[0, 0, -1], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]], s],
      [[0, 1, 0],  [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], faces.front ?? s],
      [[0, -1, 0], [[x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y0, z0]], s],
      [[1, 0, 0],  [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], s],
      [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], s],
    ];
    for (const [n, corners, surface] of F) {
      const base = this.vertexCount;
      for (const c of corners) this.push(c, n, surface);
      this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /**
   * A wheel: a cylinder lying on its side, axis along X.
   *
   * The side wall gets radial normals so it catches the light as the truck
   * turns, which is most of what sells the model as three-dimensional at the
   * moment a dispatcher rotates the map. The outboard face is a flat disc in a
   * lighter shade, standing in for a rim.
   */
  wheel(cx: number, cy: number, cz: number, radius: number, halfWidth: number, segments: number) {
    const ring: Array<[number, number]> = [];
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      ring.push([Math.cos(a), Math.sin(a)]);
    }

    // Tread.
    const treadBase = this.vertexCount;
    for (const [cy0, cz0] of ring) {
      const n: [number, number, number] = [0, cy0, cz0];
      this.push([cx - halfWidth, cy + cy0 * radius, cz + cz0 * radius], n, TYRE);
      this.push([cx + halfWidth, cy + cy0 * radius, cz + cz0 * radius], n, TYRE);
    }
    for (let k = 0; k < segments; k++) {
      const a = treadBase + k * 2;
      const b = treadBase + ((k + 1) % segments) * 2;
      this.i.push(a, b, a + 1, b, b + 1, a + 1);
    }

    // Two discs, one per side.
    for (const side of [-1, 1] as const) {
      const centre = this.vertexCount;
      const n: [number, number, number] = [side, 0, 0];
      this.push([cx + side * halfWidth, cy, cz], n, RIM);
      for (const [cy0, cz0] of ring) {
        this.push([cx + side * halfWidth, cy + cy0 * radius, cz + cz0 * radius], n, RIM);
      }
      for (let k = 0; k < segments; k++) {
        const a = centre + 1 + k;
        const b = centre + 1 + ((k + 1) % segments);
        // Wound so both discs face outward; the sign flips with the side.
        if (side > 0) this.i.push(centre, a, b);
        else this.i.push(centre, b, a);
      }
    }
  }

  private push(p: [number, number, number], n: [number, number, number], s: Surface) {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], s.tint, s.shade);
  }

  finish(hullIndexCount: number): TruckMesh {
    if (this.vertexCount > 65535) {
      // Uint16 indices are the floor MapLibre's WebGL1 fallback can rely on.
      throw new Error(`truck mesh has ${this.vertexCount} vertices, over the 16-bit index limit`);
    }
    return {
      vertices: new Float32Array(this.v),
      indices: new Uint16Array(this.i),
      hullIndexCount,
      vertexStride: 8 * 4,
    };
  }
}

/**
 * Build the rig.
 *
 * `wheelSegments` is the only quality dial. Ten is deliberate: a wheel is
 * 0.52 m on a 16.5 m vehicle, so even filling a 1080-pixel screen it is
 * thirty-odd pixels across and the tenth chord is already below one pixel.
 * Sixteen segments costs 60% more triangles for a difference nobody can see.
 */
export function buildTruckMesh(wheelSegments = 10): TruckMesh {
  const b = new MeshBuilder();

  const halfWidth = 1.275;

  /* -- Tractor unit ------------------------------------------------------- */

  // Cab. Cab-over-engine, so the front face is vertical and flush with the
  // bumper — the shape that distinguishes a European tractor at a glance from
  // the long-bonnet American one.
  b.box([-1.25, 5.30, 1.10], [1.25, 8.20, 3.85], CAB, { front: GLASS });

  // Roof deflector, the wedge over the cab. Approximated as a shallow box: at
  // any zoom where the slope would be visible the truck is already 300 px and
  // the deflector is a 40 px detail nobody is looking at.
  b.box([-1.15, 5.45, 3.85], [1.15, 7.60, 4.15], CAB);

  // Tractor chassis rails and the fifth wheel the trailer sits on.
  b.box([-0.95, 2.30, 0.72], [0.95, 8.20, 1.10], CHASSIS);

  /* -- Semi-trailer -------------------------------------------------------- */

  // The body. This is the largest surface on the vehicle and therefore the one
  // carrying the status colour.
  b.box([-halfWidth, -8.30, 1.28], [halfWidth, 5.10, 4.05], TRAILER);

  // Underframe, visible as the dark line between body and wheels that stops
  // the trailer looking like a floating brick.
  b.box([-1.02, -8.20, 1.02], [1.02, 4.70, 1.28], CHASSIS);

  const hullIndexCount = b.indexCount;

  /* -- Running gear -------------------------------------------------------- */

  const R = 0.52;
  const W = 0.19;
  // Steer, drive, and a trailer bogie of two. Real axle positions: the gap
  // between drive and bogie is what makes the silhouette read as articulated
  // rather than as one long box on wheels.
  for (const y of [6.90, 3.55, -5.55, -7.00]) {
    b.wheel(-1.10, y, R, R, W, wheelSegments);
    b.wheel(1.10, y, R, R, W, wheelSegments);
  }

  return b.finish(hullIndexCount);
}
