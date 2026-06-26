import * as THREE from 'three';

export const PROFILE_KEY: THREE.Vector2[] = [
  new THREE.Vector2(0.0, 0.0),
  new THREE.Vector2(0.012, 0.012),
  new THREE.Vector2(0.028, 0.018),
  new THREE.Vector2(0.055, 0.032),
  new THREE.Vector2(0.054, 0.038),
  new THREE.Vector2(0.028, 0.042),
  new THREE.Vector2(0.012, 0.048),
  new THREE.Vector2(0.007, 0.09),
  new THREE.Vector2(0.006, 0.13),
  new THREE.Vector2(0.007, 0.150),
  new THREE.Vector2(0.004, 0.158),
  new THREE.Vector2(0.0, 0.165),
];

/** Smooth lathe profile — centripetal Catmull-Rom avoids spline overshoot. */
export function createTopProfile(): THREE.Vector2[] {
  const curve = new THREE.CatmullRomCurve3(
    PROFILE_KEY.map((p) => new THREE.Vector3(p.x, p.y, 0)),
    false,
    'centripetal',
    0.5,
  );
  const points = curve.getPoints(64).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
  const apex = PROFILE_KEY[PROFILE_KEY.length - 1];
  points[points.length - 1].copy(apex);
  return points;
}

export function radiusAtHeight(profile: THREE.Vector2[], y: number): number {
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / (b.y - a.y);
      return a.x + t * (b.x - a.x);
    }
  }
  return 0;
}

function collectContourRingHeights(profile: THREE.Vector2[], yTop: number): number[] {
  const heights = new Set<number>();
  const minY = 0.006;
  const roundY = (y: number) => Math.round(y * 1000) / 1000;

  const maybeAdd = (y: number) => {
    if (y < minY || y >= yTop - 0.005) return;
    if (radiusAtHeight(profile, y) < 0.001) return;
    heights.add(roundY(y));
  };

  for (let y = minY; y < yTop - 0.005; y += 0.012) {
    maybeAdd(y);
  }

  return [...heights].sort((a, b) => a - b);
}

/**
 * Surface sample points in body space (tip at origin, +Y along symmetry axis).
 * Used for ground-contact tests.
 */
export function buildSurfaceSamples(): THREE.Vector3[] {
  const profile = createTopProfile();
  const yTop = profile[profile.length - 1].y;
  const samples: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];
  const azimuthCount = 16;

  for (let a = 0; a < azimuthCount; a++) {
    const az = (a / azimuthCount) * Math.PI * 2;
    const c = Math.cos(az);
    const s = Math.sin(az);
    for (const p of profile) {
      if (p.x < 0.0005 && p.y < 0.001) continue;
      samples.push(new THREE.Vector3(p.x * c, p.y, p.x * s));
    }
  }

  for (const y of collectContourRingHeights(profile, yTop)) {
    const r = radiusAtHeight(profile, y);
    const segments = r > 0.03 ? 32 : 24;
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      samples.push(new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r));
    }
  }

  return samples;
}
