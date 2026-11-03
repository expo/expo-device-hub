/**
 * Calculated bending for the foldables' flexible meshes, ported from
 * expo/expo-simulators-3d-models at 644e92e4 (`scripts/procedural_duo_bend.mjs`
 * and `scripts/procedural_pixel_bend.mjs`). The GLBs store only the open
 * shape of these meshes; their bend at another hinge angle is calculated
 * here. Inputs and outputs are mesh-local meters. The angle is 0 closed and
 * 180 open. The math is unchanged; only the types and names are new.
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

// iPhone Duo: `scripts/procedural_duo_bend.mjs`, from the authored hinge formula.
const DUO_PIVOT = 0.260577;
const DUO_HALF_WIDTH = 4;

type DuoPose = { ct: number; st: number; c: number; s: number };

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

function duoPose(openAngle: number): DuoPose {
  const theta = ((180 - clamp(openAngle, 0, 180)) * Math.PI) / 180;
  return {
    ct: Math.cos(theta),
    st: Math.sin(theta),
    c: Math.cos(theta / 2),
    s: Math.sin(theta / 2),
  };
}

function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The bent centerline at `x` mm: position, tangent, and its derivative, in X/Z. */
function duoCenterline(x: number, q: DuoPose, out: Float64Array) {
  const A = DUO_HALF_WIDTH;
  const P = DUO_PIVOT;
  if (x <= -A) return write(out, x, 0, 1, 0, 0, 0);
  if (x >= A) return write(out, x * q.ct + P * q.st, P + x * q.st - P * q.ct, q.ct, q.st, 0, 0);
  const t = x / A;
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t2 * t2;
  const one = 1 - t2;
  const k = 3.7026371828962583;
  const d = 0.762;
  const u0 = P * (1.5 * t - 0.5 * t3) + k * t * one * one;
  const v0 = A + 0.5 * A * (t2 - 1) - d * one * one;
  const du0 = P * (1.5 - 1.5 * t2) + k * (1 - 6 * t2 + 5 * t4);
  const dv0 = t * (A + 4 * d * one);
  const ddu0 = -3 * P * t + k * (-12 * t + 20 * t3);
  const ddv0 = A + 4 * d - 12 * d * t2;
  const u = A * q.c * t + q.s * u0;
  const v = -P * q.c + q.s * v0;
  const du = A * q.c + q.s * du0;
  const dv = q.s * dv0;
  const ddu = q.s * ddu0;
  const ddv = q.s * ddv0;
  out[0] = q.c * u - q.s * v;
  out[1] = P + q.s * u + q.c * v;
  out[2] = q.c * du - q.s * dv;
  out[3] = q.s * du + q.c * dv;
  out[4] = q.c * ddu - q.s * ddv;
  out[5] = q.s * ddu + q.c * ddv;
  return out;
}

function duoMapPoint(
  x: number,
  z: number,
  q: DuoPose,
  seal: boolean,
  out: Float64Array,
  scratch: Float64Array,
  probe: Float64Array,
) {
  duoCenterline(x, q, scratch);
  const xx = scratch[0]!;
  const zz = scratch[1]!;
  const dx = scratch[2]!;
  const dz = scratch[3]!;
  const length = Math.hypot(dx, dz);
  if (seal) {
    let curvature = (dx * scratch[5]! - dz * scratch[4]!) / length ** 3;
    if (z > 0) z *= 1 - 0.36 * q.s ** 8 * (1 - smooth(4.5, 6, Math.abs(x)));
    if (Math.abs(x) >= DUO_HALF_WIDTH) {
      duoCenterline((DUO_HALF_WIDTH - 1e-7) * (x >= 0 ? 1 : -1), q, probe);
      const distance = Math.min(1, (Math.abs(x) - DUO_HALF_WIDTH) / 2.5);
      const taper = 1 - distance * distance * (3 - 2 * distance);
      curvature =
        (taper * (probe[2]! * probe[5]! - probe[3]! * probe[4]!)) /
        Math.hypot(probe[2]!, probe[3]!) ** 3;
    }
    const compression = Math.max(0, z * curvature) / 0.68;
    z /= (1 + compression ** 4) ** 0.25;
  }
  out[0] = xx - (z * dz) / length;
  out[1] = zz + (z * dx) / length;
  return out;
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
  const probe = new Float64Array(6);
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
            duoMapPoint(x, z, q, kind === "seal", point, scratch, probe);
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

// Pixel 9 Pro Fold: `scripts/procedural_pixel_bend.mjs`, from the authored builder.
const MM = 0.001;
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
  tx: number;
  tz: number;
  dxoff: number;
  dzoff: number;
};

function pixelFrame(openAngle: number): PixelFrame {
  const angle = clamp(openAngle, 0, 180);
  const theta = ((180 - angle) * Math.PI) / 180;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  const px = 1.085;
  const pz = -0.813486;
  const pivot = 0.4;
  const tx = -px + 2 * px * c - px * ct + pz * st;
  const tz = pz + 2 * px * s - px * st - pz * ct;
  return { angle, ct, st, c, s, tx, tz, dxoff: tx - pivot * st, dzoff: tz - (pivot - pivot * ct) };
}

/** X/Z in mm, then the 2x2 X/Z Jacobian, for the bent bridge at station (x, z). */
function pixelBendXZ(x: number, z: number, f: PixelFrame, out: Float64Array) {
  const a = 4.3;
  if (x <= -a) return write(out, x, z, 1, 0, 0, 1);
  if (x >= a) {
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
  const t = x / a;
  const tt = t * t;
  const pivot = 0.4;
  const k = 3.25;
  const d = 0.94;
  const u0 = pivot * (1.5 * t - 0.5 * t * tt) + k * t * (1 - tt) ** 2;
  const v0 = a + 0.5 * a * (tt - 1) - d * (1 - tt) ** 2;
  const du0 = pivot * (1.5 - 1.5 * tt) + k * (1 - 6 * tt + 5 * tt * tt);
  const dv0 = t * (a + 4 * d * (1 - tt));
  const ddu0 = -3 * pivot * t + k * (-12 * t + 20 * t * tt);
  const ddv0 = a + 4 * d - 12 * d * tt;
  const u = a * f.c * t + f.s * u0;
  const v = -pivot * f.c + f.s * v0;
  const du = a * f.c + f.s * du0;
  const dv = f.s * dv0;
  const q = (t + 1) / 2;
  const weight = q * q * (3 - 2 * q);
  const dw = 3 * q * (1 - q);
  const ddw = -1.5 * t;
  const cx = f.c * u - f.s * v + weight * f.dxoff;
  const cz = pivot + f.s * u + f.c * v + weight * f.dzoff;
  const dx = (f.c * du - f.s * dv + dw * f.dxoff) / a;
  const dz = (f.s * du + f.c * dv + dw * f.dzoff) / a;
  const ddx = (f.c * f.s * ddu0 - f.s * f.s * ddv0 + ddw * f.dxoff) / (a * a);
  const ddz = (f.s * f.s * ddu0 + f.c * f.s * ddv0 + ddw * f.dzoff) / (a * a);
  const length = Math.hypot(dx, dz);
  const ux = dx / length;
  const uz = dz / length;
  const projected = ux * ddx + uz * ddz;
  const dux = (ddx - ux * projected) / length;
  const duz = (ddz - uz * projected) / length;
  out[0] = cx - z * uz;
  out[1] = cz + z * ux;
  out[2] = dx - z * duz;
  out[3] = -uz;
  out[4] = dz + z * dux;
  out[5] = ux;
  return out;
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
