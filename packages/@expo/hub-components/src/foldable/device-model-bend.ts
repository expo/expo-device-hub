/**
 * Calculated bending for the foldables' flexible meshes, ported from the
 * "tighter fold" runtimes of expo/expo-simulators-3d-models at 319fd4bf
 * (`scripts/procedural_duo_tight_bend.mjs` and
 * `scripts/procedural_pixel_tight_bend.mjs`). The GLBs store only the open
 * shape of these meshes; their bend at another hinge angle is calculated
 * here. Flat X is arc length along the bend, so the stream, mapped once on the
 * open display, keeps its scale over the hinge. Inputs and outputs are
 * mesh-local meters. The angle is 0 closed and 180 open. The math is
 * unchanged; only the types and names are new.
 */

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export interface FlexDeformer {
  /** Write the mesh's positions and normals at `openAngle` into the output arrays. */
  apply(openAngle: number, positions: Float32Array, normals: Float32Array): void;
}

export interface FlexMesh {
  /** The GLB mesh's source object name. */
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** The deformer for a flexible mesh of the iPhone Duo or the Pixel 9 Pro Fold, or null for a rigid one. */
export function createFlexDeformer(bend: "duo" | "pixel", mesh: FlexMesh): FlexDeformer | null {
  return bend === "duo" ? createDuoDeformer(mesh) : createPixelDeformer(mesh);
}

/**
 * Smooth normals weighted by corner angle, from the current triangles. Split
 * vertices keep the export's hard edges.
 */
function angleWeightedNormals(
  positions: ArrayLike<number>,
  indices: Uint32Array,
  output: Float32Array,
  sums: Float64Array,
) {
  sums.fill(0);
  for (let j = 0; j < indices.length; j += 3) {
    const ia = indices[j]! * 3;
    const ib = indices[j + 1]! * 3;
    const ic = indices[j + 2]! * 3;
    const ax = positions[ib]! - positions[ia]!;
    const ay = positions[ib + 1]! - positions[ia + 1]!;
    const az = positions[ib + 2]! - positions[ia + 2]!;
    const bx = positions[ic]! - positions[ia]!;
    const by = positions[ic + 1]! - positions[ia + 1]!;
    const bz = positions[ic + 2]! - positions[ia + 2]!;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(length > 0)) throw new Error(`Degenerate flexible triangle ${j / 3}`);
    const ab2 = ax * ax + ay * ay + az * az;
    const ac2 = bx * bx + by * by + bz * bz;
    const dot = ax * bx + ay * by + az * bz;
    const wa = Math.atan2(length, dot) / length;
    const wb = Math.atan2(length, ab2 - dot) / length;
    const wc = Math.atan2(length, ac2 - dot) / length;
    sums[ia]! += nx * wa;
    sums[ia + 1]! += ny * wa;
    sums[ia + 2]! += nz * wa;
    sums[ib]! += nx * wb;
    sums[ib + 1]! += ny * wb;
    sums[ib + 2]! += nz * wb;
    sums[ic]! += nx * wc;
    sums[ic + 1]! += ny * wc;
    sums[ic + 2]! += nz * wc;
  }
  for (let i = 0; i < output.length; i += 3) {
    const x = sums[i]!;
    const y = sums[i + 1]!;
    const z = sums[i + 2]!;
    const length = Math.sqrt(x * x + y * y + z * z);
    if (!(length > 0)) throw new Error(`Flexible vertex ${i / 3} has no normal`);
    output[i] = x / length;
    output[i + 1] = y / length;
    output[i + 2] = z / length;
  }
}

function write(
  out: Float64Array,
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
) {
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = e;
  out[5] = f;
  return out;
}

// iPhone Duo: `scripts/procedural_duo_tight_bend.mjs`. A cubic ramp of the
// tangent angle joins straight shoulders. The turn's width is solved from the
// rigid leaves' end points, and stations advance evenly in arc length.
const DUO_PIVOT = 0.260577;
const DUO_HALF_WIDTH = 4;
const DUO_STEPS = 1024;

type DuoPose = {
  angle: number;
  ct: number;
  st: number;
  c: number;
  s: number;
  h: number;
  /** Half the turn's width in flat mm; straight shoulders lie between it and DUO_HALF_WIDTH. */
  b: number;
  /** Half the turn's arc length in mm: `b`, stretched slightly near flat to meet the leaves. */
  ell: number;
  v: number;
  /** The integrals of the cosine and the sine of the tangent angle over the turn, per step. */
  cos: Float64Array;
  sin: Float64Array;
};

const duoTangentProfile = (t: number) => 1.5 * t - 0.5 * t * t * t;

let duoLastPose: DuoPose | undefined;

function duoPose(openAngle: number): DuoPose {
  const angle = clamp(openAngle, 0, 180);
  if (duoLastPose?.angle === angle) return duoLastPose;
  const theta = ((180 - angle) * Math.PI) / 180;
  const h = theta / 2;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const cos = new Float64Array(DUO_STEPS + 1);
  const sin = new Float64Array(DUO_STEPS + 1);
  const dt = 1 / DUO_STEPS;
  let ca = 1;
  let sa = 0;
  for (let i = 1; i <= DUO_STEPS; i++) {
    const mid = h * duoTangentProfile((i - 0.5) * dt);
    const end = h * duoTangentProfile(i * dt);
    const cb = Math.cos(end);
    const sb = Math.sin(end);
    cos[i] = cos[i - 1]! + (dt * (ca + 4 * Math.cos(mid) + cb)) / 6;
    sin[i] = sin[i - 1]! + (dt * (sa + 4 * Math.sin(mid) + sb)) / 6;
    ca = cb;
    sa = sb;
  }
  // A rigid shoulder's U is b·cos(h) + pivot·sin(h), and a turn of half-length
  // b spans b·∫cos(φ). Past DUO_HALF_WIDTH, the fixed end points need a slight,
  // even stretch near flat.
  const total = cos[DUO_STEPS]!;
  const solved = angle === 180 || total <= c ? DUO_HALF_WIDTH : (DUO_PIVOT * s) / (total - c);
  const b = Math.min(DUO_HALF_WIDTH, solved);
  const scale = angle === 180 ? 1 : (b * c + DUO_PIVOT * s) / (b * total);
  duoLastPose = {
    angle,
    ct: Math.cos(theta),
    st: Math.sin(theta),
    c,
    s,
    h,
    b,
    ell: b * scale,
    v: b * s - DUO_PIVOT * c,
    cos,
    sin,
  };
  return duoLastPose;
}

/** Cubic Hermite interpolation of an integral table; its end slopes are the turn's unit tangents. */
function duoPrimitive(table: Float64Array, t: number, q: DuoPose, isSin: boolean) {
  const cell = Math.min(DUO_STEPS - 1, Math.floor(t * DUO_STEPS));
  const v = t * DUO_STEPS - cell;
  const v2 = v * v;
  const v3 = v2 * v;
  const a = q.h * duoTangentProfile(cell / DUO_STEPS);
  const b = q.h * duoTangentProfile((cell + 1) / DUO_STEPS);
  const da = isSin ? Math.sin(a) : Math.cos(a);
  const db = isSin ? Math.sin(b) : Math.cos(b);
  return (
    (2 * v3 - 3 * v2 + 1) * table[cell]! +
    ((v3 - 2 * v2 + v) * da) / DUO_STEPS +
    (-2 * v3 + 3 * v2) * table[cell + 1]! +
    ((v3 - v2) * db) / DUO_STEPS
  );
}

/** The bent centerline at `x` mm: position and unit tangent in X/Z, then the curvature. */
function duoCenterline(x: number, q: DuoPose, out: Float64Array) {
  if (x <= -q.b) return write(out, x, 0, 1, 0, 0, 0);
  if (x >= q.b) {
    return write(
      out,
      x * q.ct + DUO_PIVOT * q.st,
      DUO_PIVOT + x * q.st - DUO_PIVOT * q.ct,
      q.ct,
      q.st,
      0,
      0,
    );
  }
  const t = x / q.b;
  const at = Math.abs(t);
  const sign = Math.sign(t);
  const u = sign * q.ell * duoPrimitive(q.cos, at, q, false);
  const v = q.v - q.ell * (q.sin[DUO_STEPS]! - duoPrimitive(q.sin, at, q, true));
  const alpha = q.h * (1 + duoTangentProfile(t));
  out[0] = q.c * u - q.s * v;
  out[1] = DUO_PIVOT + q.s * u + q.c * v;
  out[2] = Math.cos(alpha);
  out[3] = Math.sin(alpha);
  out[4] = (q.h * 1.5 * (1 - t * t)) / q.ell;
  return out;
}

function duoMapPoint(
  x: number,
  z: number,
  q: DuoPose,
  seal: boolean,
  out: Float64Array,
  scratch: Float64Array,
) {
  const p = duoCenterline(x, q, scratch);
  if (seal) {
    if (z > 0) z *= 1 - 0.36 * q.s ** 8 * (1 - smooth(4.5, 6, Math.abs(x)));
    // The seal's hooked underside yields around the turn, clear of the rigid
    // spine's end cap.
    const compression = Math.abs(z * p[4]!) / (z < 0 ? 0.3 : 0.68);
    z /= (1 + compression ** 4) ** 0.25;
  }
  out[0] = p[0]! - z * p[3]!;
  out[1] = p[1]! + z * p[2]!;
  return out;
}

function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function duoFlexKind(name: string): "display" | "seal" | null {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "flexcontinuousinneroled" || key === "flexinnercoverrim") return "display";
  if (key === "hingeflexibleblackdisplayedgebottom" || key === "hingeflexibleblackdisplayedgetop") {
    return "seal";
  }
  return null;
}

function createDuoDeformer({ name, positions, normals, indices }: FlexMesh): FlexDeformer | null {
  const kind = duoFlexKind(name);
  if (!kind) return null;
  if (positions.length !== normals.length || positions.length % 3 || indices.length % 3) {
    throw new Error("Invalid Duo vertex arrays");
  }
  const base = new Float32Array(positions);
  const vertices = base.length / 3;
  const triangles = new Uint32Array(indices);
  // Vertices that share an X/Z station bend together; evaluate each station once.
  const stations: { x: number; z: number }[] = [];
  const lookup = new Map<string, number>();
  const stationOf = new Uint32Array(vertices);
  for (let i = 0; i < vertices; i++) {
    const x = base[3 * i]! * 1000;
    const z = base[3 * i + 2]! * 1000;
    const key = `${x},${z}`;
    let station = lookup.get(key);
    if (station === undefined) {
      station = stations.length;
      lookup.set(key, station);
      stations.push({ x, z });
    }
    stationOf[i] = station;
  }
  const evaluated = new Float64Array(stations.length * 2);
  const scratch = new Float64Array(6);
  const point = new Float64Array(2);
  const sums = new Float64Array(base.length);
  const cachedPositions = new Float32Array(base.length);
  const cachedNormals = new Float32Array(base.length);
  let previousAngle = Number.NaN;
  return {
    apply(openAngle, outPositions, outNormals) {
      const angle = clamp(openAngle, 0, 180);
      if (angle !== previousAngle) {
        if (angle === 180) cachedPositions.set(base);
        else {
          const q = duoPose(angle);
          for (let i = 0; i < stations.length; i++) {
            const { x, z } = stations[i]!;
            duoMapPoint(x, z, q, kind === "seal", point, scratch);
            evaluated[i * 2] = point[0]! / 1000;
            evaluated[i * 2 + 1] = point[1]! / 1000;
          }
          for (let i = 0; i < vertices; i++) {
            const station = stationOf[i]! * 2;
            cachedPositions[i * 3] = evaluated[station]!;
            cachedPositions[i * 3 + 1] = base[i * 3 + 1]!;
            cachedPositions[i * 3 + 2] = evaluated[station + 1]!;
          }
        }
        // Calculated normals at 180° too, so the open pose has no normal jump.
        angleWeightedNormals(cachedPositions, triangles, cachedNormals, sums);
        previousAngle = angle;
      }
      outPositions.set(cachedPositions);
      outNormals.set(cachedNormals);
    },
  };
}

// Pixel 9 Pro Fold: `scripts/procedural_pixel_tight_bend.mjs`. A circular
// middle, straight shoulders, and eased joins into the rigid screen planes.
// Flat X is arc length; the bridge keeps its 8.6 mm.
const MM = 0.001;
const PIXEL_HALF_WIDTH = 4.3;
const PIXEL_LOCK_X = 3.25;
const PIXEL_EASE_LENGTH = 0.8;
const PIXEL_EASE_START = PIXEL_LOCK_X - PIXEL_EASE_LENGTH;
// Sixteen-point Gauss–Legendre quadrature for the eased shoulder; the circular
// and straight parts are integrated exactly. Three weights are written in the
// shortest form of the same 64-bit value as upstream.
const GAUSS_X = [
  0.09501250983763744, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438,
  0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499,
];
const GAUSS_W = [
  0.1894506104550685, 0.1826034150449236, 0.16915651939500254, 0.14959598881657674,
  0.12462897125553388, 0.09515851168249279, 0.06225352393864789, 0.027152459411754096,
];
const PIXEL_BRIDGES = new Set([
  "FLEX • continuous inner OLED bridge",
  "Top • flexible hinge edge bridge",
  "Bottom • flexible hinge edge bridge",
]);

type PixelSpec = { kind: "bend" } | { kind: "lip"; baseMM: number; heightMM: number };

function pixelSpec(name: string): PixelSpec | null {
  if (PIXEL_BRIDGES.has(name)) return { kind: "bend" };
  if (name === "L • inner display perimeter") {
    return { kind: "lip", baseMM: 0.118446, heightMM: 0.205757 };
  }
  if (name === "R • inner display perimeter") {
    return { kind: "lip", baseMM: -0.262816, heightMM: 0.206342 };
  }
  return null;
}

type PixelFrame = {
  angle: number;
  ct: number;
  st: number;
  c: number;
  s: number;
  h: number;
  tx: number;
  tz: number;
  midpointU: number;
  /** Half the circular middle's arc length, in mm. */
  width: number;
  /** The tangent angle of the straight shoulders, solved to meet the rigid planes. */
  beta: number;
  centerV: number;
};

function pixelShoulderIntegral(to: number, f: PixelFrame, out: Float64Array) {
  const mid = to / 2;
  let u = 0;
  let v = 0;
  for (let i = 0; i < GAUSS_X.length; i++) {
    for (const sign of [-1, 1]) {
      const t = mid * (1 + sign * GAUSS_X[i]!);
      const a = f.beta + (f.h - f.beta) * t * t * (3 - 2 * t);
      u += GAUSS_W[i]! * Math.cos(a);
      v += GAUSS_W[i]! * Math.sin(a);
    }
  }
  out[0] = u * mid * PIXEL_EASE_LENGTH;
  out[1] = v * mid * PIXEL_EASE_LENGTH;
  return out;
}

/** The unit tangent, integrated from the center to the arc station `x` ≥ 0 mm. */
function pixelHalfIntegral(x: number, f: PixelFrame, out: Float64Array) {
  const central = Math.min(x, f.width);
  const k = f.beta / f.width;
  let u: number;
  let v: number;
  if (Math.abs(k) < 1e-10) {
    u = central;
    v = 0.5 * k * central * central;
  } else {
    u = Math.sin(k * central) / k;
    v = (2 * Math.sin((k * central) / 2) ** 2) / k;
  }
  if (x > f.width) {
    const straight = Math.min(x, PIXEL_EASE_START) - f.width;
    if (straight > 0) {
      u += straight * Math.cos(f.beta);
      v += straight * Math.sin(f.beta);
    }
  }
  if (x > PIXEL_EASE_START) {
    pixelShoulderIntegral(Math.min(1, (x - PIXEL_EASE_START) / PIXEL_EASE_LENGTH), f, out);
    u += out[0]!;
    v += out[1]!;
  }
  if (x > PIXEL_LOCK_X) {
    u += (x - PIXEL_LOCK_X) * f.c;
    v += (x - PIXEL_LOCK_X) * f.s;
  }
  out[0] = u;
  out[1] = v;
  return out;
}

let pixelLastFrame: PixelFrame | undefined;

function pixelFrame(openAngle: number): PixelFrame {
  const angle = clamp(openAngle, 0, 180);
  if (pixelLastFrame?.angle === angle) return pixelLastFrame;
  const theta = ((180 - angle) * Math.PI) / 180;
  const h = theta / 2;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const c = Math.cos(h);
  const s = Math.sin(h);
  const px = 1.085;
  const pz = -0.813486;
  const tx = -px + 2 * px * c - px * ct + pz * st;
  const tz = pz + 2 * px * s - px * st - pz * ct;
  const translationU = 2 * px * (1 - c) + 2 * pz * s;
  const chord = 2 * PIXEL_HALF_WIDTH * c + translationU;
  const f: PixelFrame = {
    angle,
    ct,
    st,
    c,
    s,
    h,
    tx,
    tz,
    midpointU: translationU / 2,
    width: (Math.PI * 0.543028) / 4 + 0.55 * c,
    beta: 0,
    centerV: 0,
  };
  if (angle !== 180) {
    // The arc length is 2·PIXEL_HALF_WIDTH by construction; solving the
    // shoulders' angle meets the chord between the rigid planes.
    let low = 0;
    let high = Math.PI * 0.65;
    const scratch = new Float64Array(2);
    for (let i = 0; i < 52; i++) {
      f.beta = (low + high) / 2;
      if (pixelHalfIntegral(PIXEL_HALF_WIDTH, f, scratch)[0]! > chord / 2) low = f.beta;
      else high = f.beta;
    }
    f.beta = (low + high) / 2;
    pixelHalfIntegral(PIXEL_HALF_WIDTH, f, scratch);
    f.centerV = PIXEL_HALF_WIDTH * s - scratch[1]!;
  }
  pixelLastFrame = f;
  return f;
}

/** The bent centerline at `x` mm: position and unit tangent in X/Z, then the tangent's derivative. */
function pixelCenterline(x: number, f: PixelFrame, out: Float64Array) {
  const ax = Math.abs(x);
  const sign = Math.sign(x);
  pixelHalfIntegral(ax, f, out);
  const u = f.midpointU + sign * out[0]!;
  const v = f.centerV + out[1]!;
  let alpha: number;
  let curvature: number;
  if (ax <= f.width) {
    alpha = (f.beta * ax) / f.width;
    curvature = f.beta / f.width;
  } else if (ax <= PIXEL_EASE_START) {
    alpha = f.beta;
    curvature = 0;
  } else {
    const t = clamp((ax - PIXEL_EASE_START) / PIXEL_EASE_LENGTH, 0, 1);
    alpha = f.beta + (f.h - f.beta) * t * t * (3 - 2 * t);
    curvature = ((f.h - f.beta) * 6 * t * (1 - t)) / PIXEL_EASE_LENGTH;
  }
  const angle = f.h + sign * alpha;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  return write(out, f.c * u - f.s * v, f.s * u + f.c * v, dx, dz, -curvature * dz, curvature * dx);
}

/** X/Z in mm, then the 2x2 X/Z Jacobian, for the bent bridge at station (x, z). */
function pixelBendXZ(x: number, z: number, f: PixelFrame, out: Float64Array) {
  if (x <= -PIXEL_LOCK_X || f.angle === 180) return write(out, x, z, 1, 0, 0, 1);
  if (x >= PIXEL_LOCK_X) {
    return write(
      out,
      x * f.ct + f.tx - z * f.st,
      x * f.st + f.tz + z * f.ct,
      f.ct,
      -f.st,
      f.st,
      f.ct,
    );
  }
  pixelCenterline(x, f, out);
  const cx = out[0]!;
  const cz = out[1]!;
  const dx = out[2]!;
  const dz = out[3]!;
  const ddx = out[4]!;
  const ddz = out[5]!;
  return write(out, cx - z * dz, cz + z * dx, dx - z * ddz, -dz, dz + z * ddx, dx);
}

function pixelLipScale(spec: { heightMM: number }, f: PixelFrame) {
  let t = clamp((15 - f.angle) / 15, 0, 1);
  t = t * t * (3 - 2 * t);
  return 1 - (0.075 * t) / spec.heightMM;
}

function createPixelDeformer({ name, positions, normals, indices }: FlexMesh): FlexDeformer | null {
  const spec = pixelSpec(name);
  if (!spec) return null;
  if (positions.length !== normals.length || positions.length % 3) {
    throw new Error("Invalid Pixel vertex arrays");
  }
  const base = new Float32Array(positions);
  const normal = new Float32Array(normals);
  const count = base.length / 3;
  // The display and its lips follow their bent triangles; the end bridges carry
  // their own normals through the Jacobian, as tiny tip triangles shade unstably.
  const topologyNormals = spec.kind === "lip" || name === "FLEX • continuous inner OLED bridge";
  if (topologyNormals && indices.length % 3) throw new Error("Invalid Pixel triangle indices");
  const topology = topologyNormals ? new Uint32Array(indices) : null;
  const sums = new Float64Array(base.length);
  const stationOf = new Uint32Array(count);
  const xs: number[] = [];
  const zs: number[] = [];
  if (spec.kind === "bend") {
    const lookup = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const x = base[i * 3]!;
      const z = base[i * 3 + 2]!;
      const key = `${x},${z}`;
      let station = lookup.get(key);
      if (station === undefined) {
        station = xs.length;
        lookup.set(key, station);
        xs.push(x / MM);
        zs.push(z / MM);
      }
      stationOf[i] = station;
    }
  }
  const evaluated = new Float64Array(xs.length * 6);
  const scratch = new Float64Array(6);
  return {
    apply(openAngle, positionsOut, normalsOut) {
      const f = pixelFrame(openAngle);
      if (f.angle === 180) {
        positionsOut.set(base);
        normalsOut.set(normal);
      } else if (spec.kind === "lip") {
        const baseZ = spec.baseMM * MM;
        const scale = pixelLipScale(spec, f);
        const inverse = 1 / scale;
        for (let i = 0; i < base.length; i += 3) {
          positionsOut[i] = base[i]!;
          positionsOut[i + 1] = base[i + 1]!;
          positionsOut[i + 2] = baseZ + (base[i + 2]! - baseZ) * scale;
          const nx = normal[i]!;
          const ny = normal[i + 1]!;
          const nz = normal[i + 2]! * inverse;
          const length = 1 / Math.hypot(nx, ny, nz);
          normalsOut[i] = nx * length;
          normalsOut[i + 1] = ny * length;
          normalsOut[i + 2] = nz * length;
        }
      } else {
        for (let i = 0; i < xs.length; i++) {
          pixelBendXZ(xs[i]!, zs[i]!, f, scratch);
          evaluated.set(scratch, i * 6);
        }
        for (let i = 0; i < count; i++) {
          const at = i * 3;
          const off = stationOf[i]! * 6;
          positionsOut[at] = evaluated[off]! * MM;
          positionsOut[at + 1] = base[at + 1]!;
          positionsOut[at + 2] = evaluated[off + 1]! * MM;
          const a = evaluated[off + 2]!;
          const b = evaluated[off + 3]!;
          const c = evaluated[off + 4]!;
          const d = evaluated[off + 5]!;
          const determinant = a * d - b * c;
          if (!(determinant > 0)) throw new Error("Non-positive bend Jacobian");
          const nx = (d * normal[at]! - c * normal[at + 2]!) / determinant;
          const ny = normal[at + 1]!;
          const nz = (-b * normal[at]! + a * normal[at + 2]!) / determinant;
          const length = 1 / Math.hypot(nx, ny, nz);
          normalsOut[at] = nx * length;
          normalsOut[at + 1] = ny * length;
          normalsOut[at + 2] = nz * length;
        }
      }
      if (topology) angleWeightedNormals(positionsOut, topology, normalsOut, sums);
    },
  };
}
