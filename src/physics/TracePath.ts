import * as THREE from 'three';

export type TracePathKind = 'line' | 'circle' | 'polyline';

export interface TracePath {
  readonly kind: TracePathKind;
  readonly length: number;
  /** When true, arc-length wraps — the tip keeps looping while spinning. */
  readonly loops: boolean;
  sample(s: number, out: THREE.Vector3): THREE.Vector3;
  tangent(s: number, out: THREE.Vector3): THREE.Vector3;
  /** Arc-length speed (m/s) from rolling without slip: v ≈ r_eff · ω_s. */
  rollRateFromSpin(
    s: number,
    spinRate: number,
    tilt: number,
    comHeight: number,
  ): number;
  closestParameter(x: number, z: number): number;
  clampS(s: number): number;
  getGuidePoints(segments?: number): THREE.Vector3[];
}

const _sample = new THREE.Vector3();

function wrapS(s: number, length: number): number {
  if (length <= 0) return 0;
  let w = s % length;
  if (w < 0) w += length;
  return w;
}

function clampS(s: number, length: number): number {
  return THREE.MathUtils.clamp(s, 0, length);
}

/** Effective rolling radius from tilt; v = r_eff · ω_s along the path tangent. */
function spinRollSpeed(
  spinRate: number,
  tilt: number,
  comHeight: number,
  extraRadius = 0,
): number {
  if (spinRate <= 0 || tilt <= 1e-4) return 0;
  const rEff = comHeight * Math.sin(tilt) + extraRadius;
  return rEff * spinRate;
}

export class LinePath implements TracePath {
  readonly kind = 'line' as const;
  readonly loops = false;
  readonly length: number;
  private readonly ax: number;
  private readonly az: number;
  private readonly dirX: number;
  private readonly dirZ: number;

  constructor(ax: number, az: number, bx: number, bz: number) {
    this.ax = ax;
    this.az = az;
    const dx = bx - ax;
    const dz = bz - az;
    this.length = Math.hypot(dx, dz);
    this.dirX = dx / this.length;
    this.dirZ = dz / this.length;
  }

  sample(s: number, out: THREE.Vector3): THREE.Vector3 {
    const u = clampS(s, this.length);
    return out.set(this.ax + this.dirX * u, 0, this.az + this.dirZ * u);
  }

  tangent(_s: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.dirX, 0, this.dirZ);
  }

  rollRateFromSpin(_s: number, spinRate: number, tilt: number, comHeight: number): number {
    return spinRollSpeed(spinRate, tilt, comHeight);
  }

  closestParameter(x: number, z: number): number {
    const px = x - this.ax;
    const pz = z - this.az;
    return clampS(px * this.dirX + pz * this.dirZ, this.length);
  }

  clampS(s: number): number {
    return clampS(s, this.length);
  }

  getGuidePoints(): THREE.Vector3[] {
    return [
      new THREE.Vector3(this.ax, 0.002, this.az),
      new THREE.Vector3(this.ax + this.dirX * this.length, 0.002, this.az + this.dirZ * this.length),
    ];
  }
}

export class CirclePath implements TracePath {
  readonly kind = 'circle' as const;
  readonly loops = true;
  readonly length: number;
  readonly clockwise: boolean;

  constructor(
    readonly cx: number,
    readonly cz: number,
    readonly radius: number,
    clockwise: boolean,
  ) {
    this.clockwise = clockwise;
    this.length = Math.PI * 2 * radius;
  }

  sample(s: number, out: THREE.Vector3): THREE.Vector3 {
    const u = wrapS(s, this.length);
    const angle = u / this.radius;
    return out.set(
      this.cx + Math.cos(angle) * this.radius,
      0,
      this.cz + Math.sin(angle) * this.radius,
    );
  }

  tangent(s: number, out: THREE.Vector3): THREE.Vector3 {
    const u = wrapS(s, this.length);
    const angle = u / this.radius;
    const sign = this.clockwise ? -1 : 1;
    return out.set(-Math.sin(angle) * sign, 0, Math.cos(angle) * sign);
  }

  rollRateFromSpin(_s: number, spinRate: number, tilt: number, comHeight: number): number {
    const sign = this.clockwise ? -1 : 1;
    return sign * spinRollSpeed(spinRate, tilt, comHeight, this.radius * 0.08);
  }

  closestParameter(x: number, z: number): number {
    const angle = Math.atan2(z - this.cz, x - this.cx);
    let s = angle * this.radius;
    if (s < 0) s += this.length;
    return s;
  }

  clampS(s: number): number {
    return wrapS(s, this.length);
  }

  getGuidePoints(segments = 96): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * this.length;
      this.sample(t, _sample);
      pts.push(new THREE.Vector3(_sample.x, 0.002, _sample.z));
    }
    return pts;
  }
}

export class PolylinePath implements TracePath {
  readonly kind = 'polyline' as const;
  readonly loops: boolean;
  readonly length: number;
  private readonly points: THREE.Vector3[];
  private readonly cumulative: number[];
  private readonly segmentCount: number;

  constructor(points: THREE.Vector3[], closed = false) {
    this.points = points;
    this.loops = closed && points.length >= 3;
    this.cumulative = [0];

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      this.cumulative.push(
        this.cumulative[i - 1] + Math.hypot(curr.x - prev.x, curr.z - prev.z),
      );
    }

    if (this.loops) {
      const last = points[points.length - 1];
      const first = points[0];
      this.cumulative.push(
        this.cumulative[points.length - 1] +
          Math.hypot(first.x - last.x, first.z - last.z),
      );
    }

    this.segmentCount = this.loops ? points.length : points.length - 1;
    this.length = this.cumulative[this.cumulative.length - 1];
  }

  private segmentEndpoints(seg: number): [THREE.Vector3, THREE.Vector3] {
    const a = this.points[seg];
    const b = this.points[(seg + 1) % this.points.length];
    return [a, b];
  }

  private locateSegment(u: number): number {
    let seg = 0;
    while (seg < this.segmentCount - 1 && this.cumulative[seg + 1] < u) seg++;
    return seg;
  }

  sample(s: number, out: THREE.Vector3): THREE.Vector3 {
    const u = this.loops ? wrapS(s, this.length) : clampS(s, this.length);
    const seg = this.locateSegment(u);
    const segStart = this.cumulative[seg];
    const segEnd = this.cumulative[seg + 1];
    const t = segEnd > segStart ? (u - segStart) / (segEnd - segStart) : 0;
    const [a, b] = this.segmentEndpoints(seg);
    return out.set(
      THREE.MathUtils.lerp(a.x, b.x, t),
      0,
      THREE.MathUtils.lerp(a.z, b.z, t),
    );
  }

  tangent(s: number, out: THREE.Vector3): THREE.Vector3 {
    const u = this.loops ? wrapS(s, this.length) : clampS(s, this.length);
    const seg = this.locateSegment(u);
    const [a, b] = this.segmentEndpoints(seg);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return out.set(dx / len, 0, dz / len);
  }

  rollRateFromSpin(_s: number, spinRate: number, tilt: number, comHeight: number): number {
    return spinRollSpeed(spinRate, tilt, comHeight);
  }

  closestParameter(x: number, z: number): number {
    let bestS = 0;
    let bestDist = Infinity;

    for (let i = 0; i < this.segmentCount; i++) {
      const [a, b] = this.segmentEndpoints(i);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLenSq = dx * dx + dz * dz;
      if (segLenSq < 1e-10) continue;

      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / segLenSq, 0, 1);
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const dist = Math.hypot(x - px, z - pz);
      if (dist < bestDist) {
        bestDist = dist;
        bestS = this.cumulative[i] + Math.sqrt(segLenSq) * t;
      }
    }

    return bestS;
  }

  clampS(s: number): number {
    return this.loops ? wrapS(s, this.length) : clampS(s, this.length);
  }

  getGuidePoints(): THREE.Vector3[] {
    const pts = this.points.map((p) => new THREE.Vector3(p.x, 0.002, p.z));
    if (this.loops && pts.length > 0) {
      pts.push(pts[0].clone());
    }
    return pts;
  }
}

interface CircleFit {
  cx: number;
  cz: number;
  radius: number;
  clockwise: boolean;
}

function fitCircle(points: THREE.Vector3[]): CircleFit | null {
  if (points.length < 10) return null;

  let cx = 0;
  let cz = 0;
  for (const p of points) {
    cx += p.x;
    cz += p.z;
  }
  cx /= points.length;
  cz /= points.length;

  let radius = 0;
  for (const p of points) {
    radius += Math.hypot(p.x - cx, p.z - cz);
  }
  radius /= points.length;
  if (radius < 0.04) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const closeGap = Math.hypot(first.x - last.x, first.z - last.z);
  if (closeGap > Math.min(radius * 0.3, 0.05)) return null;

  let maxRadialError = 0;
  let sumSqError = 0;
  for (const p of points) {
    const err = Math.abs(Math.hypot(p.x - cx, p.z - cz) - radius);
    maxRadialError = Math.max(maxRadialError, err);
    sumSqError += err * err;
  }
  const rmsError = Math.sqrt(sumSqError / points.length);
  if (maxRadialError > radius * 0.1 || rmsError > radius * 0.05) return null;

  let turning = 0;
  for (let i = 1; i < points.length; i++) {
    const a = Math.atan2(points[i - 1].z - cz, points[i - 1].x - cx);
    const b = Math.atan2(points[i].z - cz, points[i].x - cx);
    let delta = b - a;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    turning += Math.abs(delta);
  }
  if (turning < Math.PI * 1.5 || turning > Math.PI * 2.6) return null;

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  const enclosed = Math.abs(area) * 0.5;
  const circleArea = Math.PI * radius * radius;
  if (enclosed < circleArea * 0.65 || enclosed > circleArea * 1.35) return null;

  return { cx, cz, radius, clockwise: area < 0 };
}

function fitLine(points: THREE.Vector3[]): LinePath | null {
  if (points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dz = last.z - first.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.06) return null;

  const dirX = dx / len;
  const dirZ = dz / len;
  let maxDist = 0;
  for (const p of points) {
    const px = p.x - first.x;
    const pz = p.z - first.z;
    const dist = Math.abs(px * dirZ - pz * dirX);
    maxDist = Math.max(maxDist, dist);
  }
  if (maxDist > len * 0.08) return null;

  return new LinePath(first.x, first.z, last.x, last.z);
}

function resamplePolyline(points: THREE.Vector3[], spacing = 0.012): THREE.Vector3[] | null {
  const out: THREE.Vector3[] = [points[0].clone()];
  let carry = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-6) continue;

    let t = (spacing - carry) / segLen;
    while (t <= 1) {
      out.push(new THREE.Vector3(a.x + dx * t, 0, a.z + dz * t));
      t += spacing / segLen;
    }
    carry = (1 - (t - spacing / segLen)) * segLen;
  }

  const end = points[points.length - 1];
  if (out[out.length - 1].distanceToSquared(end) > spacing * spacing * 0.25) {
    out.push(end.clone());
  }

  return out.length >= 2 ? out : null;
}

/** Stroke closes back near its start — treat as a loop, not an open path. */
function isClosedStroke(points: THREE.Vector3[]): boolean {
  if (points.length < 4) return false;

  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(first.x - last.x, first.z - last.z);

  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    pathLen += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }

  return gap < Math.max(0.04, pathLen * 0.1);
}

/** Turn a drawn stroke into a constrained rolling path (line, circle, or polyline). */
export function parseTracePath(points: THREE.Vector3[]): TracePath | null {
  if (points.length < 2) return null;

  const line = fitLine(points);
  if (line) return line;

  const resampled = resamplePolyline(points);
  if (resampled && resampled.length >= 2) {
    const closed = isClosedStroke(resampled);
    const polyline = new PolylinePath(resampled, closed);
    if (polyline.length >= 0.06) {
      const circle = fitCircle(points);
      if (circle) {
        return new CirclePath(circle.cx, circle.cz, circle.radius, circle.clockwise);
      }
      return polyline;
    }
  }

  const circle = fitCircle(points);
  if (circle) {
    return new CirclePath(circle.cx, circle.cz, circle.radius, circle.clockwise);
  }

  return null;
}
