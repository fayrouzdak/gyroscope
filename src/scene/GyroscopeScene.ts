import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { SpinningTopPhysics } from '../physics/SpinningTopPhysics';
import { createTopProfile, radiusAtHeight } from '../topProfile';
import { TABLE_RADIUS } from './tableSurface';

export { TABLE_RADIUS };

const LINE_COLOR = 0x7a1515;
const BOLD_WIDTH = 2;
const FINE_WIDTH = 1;

function meridianPoints(profile: THREE.Vector2[], azimuth: number): THREE.Vector3[] {
  const c = Math.cos(azimuth);
  const s = Math.sin(azimuth);
  return profile.map((p) => new THREE.Vector3(p.x * c, p.y, p.x * s));
}

function radiusDerivative(profile: THREE.Vector2[], y: number): number {
  const h = 0.0015;
  const y0 = Math.max(h, y);
  return (radiusAtHeight(profile, y0 + h) - radiusAtHeight(profile, y0 - h)) / (2 * h);
}

/** Wide-to-narrow collar — where the flare meets the stem. */
function findCollarBand(profile: THREE.Vector2[]): { start: number; end: number } {
  let maxR = 0;
  let yPeak = 0;
  for (const p of profile) {
    if (p.x > maxR) {
      maxR = p.x;
      yPeak = p.y;
    }
  }

  let yEnd = yPeak;
  for (const p of profile) {
    if (p.y > yPeak && p.x < maxR * 0.4) {
      yEnd = p.y;
      break;
    }
  }

  return { start: yPeak - 0.006, end: yEnd + 0.003 };
}

function collectContourRingHeights(
  profile: THREE.Vector2[],
  yTop: number,
  skipY?: number,
): number[] {
  const heights = new Set<number>();
  const minY = 0.006;
  const roundY = (y: number) => Math.round(y * 1000) / 1000;

  const maybeAdd = (y: number) => {
    if (y < minY || y >= yTop - 0.005) return;
    if (skipY !== undefined && Math.abs(y - skipY) < 0.004) return;
    if (radiusAtHeight(profile, y) < 0.001) return;
    heights.add(roundY(y));
  };

  for (let y = minY; y < yTop - 0.005; ) {
    maybeAdd(y);

    const r = radiusAtHeight(profile, y);
    const drDy = radiusDerivative(profile, y);
    const narrowing = drDy < -0.08;
    const narrowRate = -drDy;

    let step = 0.022;
    if (narrowing && narrowRate > 0.55) step = 0.003;
    else if (narrowing && narrowRate > 0.3) step = 0.005;
    else if (narrowing && narrowRate > 0.12) step = 0.008;
    else if (r > 0.035) step = 0.006;
    else if (r > 0.022) step = 0.010;
    else if (r > 0.012) step = 0.016;

    y += step;
  }

  // Extra rings at the wide→narrow collar (the curved undercut below the disk).
  const collar = findCollarBand(profile);
  for (let y = collar.start; y <= collar.end; y += 0.003) {
    maybeAdd(y);
  }

  return [...heights].sort((a, b) => a - b);
}

function circlePoints(y: number, radius: number, segments: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(t) * radius, y, Math.sin(t) * radius));
  }
  return pts;
}

function makeLine(
  points: THREE.Vector3[],
  linewidth: number,
  color: number,
  tag: 'bold' | 'fine',
): Line2 {
  const flat: number[] = [];
  for (const p of points) flat.push(p.x, p.y, p.z);

  const geometry = new LineGeometry();
  geometry.setPositions(flat);

  const material = new LineMaterial({
    color,
    linewidth,
    worldUnits: false,
    transparent: true,
    opacity: tag === 'bold' ? 1 : 0.8,
  });
  material.resolution.set(window.innerWidth, window.innerHeight);

  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.userData.lineTag = tag;
  return line;
}

export function createSpinningTopMesh(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'spinningTop';

  const tiltGroup = new THREE.Group();
  tiltGroup.name = 'tiltGroup';
  root.add(tiltGroup);

  const spinGroup = new THREE.Group();
  spinGroup.name = 'spinGroup';
  tiltGroup.add(spinGroup);

  const profile = createTopProfile();
  const yTop = profile[profile.length - 1].y;
  const diskY = 0.032;
  const diskR = 0.055;
  // Default camera in main.ts: position (0.28, 0.18, 0.42)
  const viewAzimuth = Math.atan2(0.42, 0.28);

  // ── Bold 2 px — outer envelope ──
  const outerGroup = new THREE.Group();
  outerGroup.name = 'outerLines';
  spinGroup.add(outerGroup);

  // Vertical: silhouette meridians (side edges from this view)
  outerGroup.add(
    makeLine(meridianPoints(profile, viewAzimuth + Math.PI / 2), BOLD_WIDTH, LINE_COLOR, 'bold'),
  );
  outerGroup.add(
    makeLine(meridianPoints(profile, viewAzimuth - Math.PI / 2), BOLD_WIDTH, LINE_COLOR, 'bold'),
  );

  // Horizontal: widest disk contour
  outerGroup.add(makeLine(circlePoints(diskY, diskR, 80), BOLD_WIDTH, LINE_COLOR, 'bold'));

  // ── Fine 1 px — interior grid following the same surface ──
  const innerGroup = new THREE.Group();
  innerGroup.name = 'innerLines';
  spinGroup.add(innerGroup);

  // Vertical: front-side ribs between the bold silhouette edges
  innerGroup.add(
    makeLine(meridianPoints(profile, viewAzimuth + Math.PI / 4), FINE_WIDTH, LINE_COLOR, 'fine'),
  );
  innerGroup.add(
    makeLine(meridianPoints(profile, viewAzimuth - Math.PI / 4), FINE_WIDTH, LINE_COLOR, 'fine'),
  );
  // Vertical: back-side ribs (visible through the wireframe)
  innerGroup.add(
    makeLine(meridianPoints(profile, viewAzimuth), FINE_WIDTH, LINE_COLOR, 'fine'),
  );
  innerGroup.add(
    makeLine(meridianPoints(profile, viewAzimuth + Math.PI), FINE_WIDTH, LINE_COLOR, 'fine'),
  );

  // Central spin axis
  innerGroup.add(
    makeLine(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, yTop, 0)],
      FINE_WIDTH,
      LINE_COLOR,
      'fine',
    ),
  );

  // Horizontal: contour rings — denser on the wide flare, sparser on the stem
  for (const y of collectContourRingHeights(profile, yTop, diskY)) {
    const r = radiusAtHeight(profile, y);
    const segments = r > 0.03 ? 72 : 56;
    innerGroup.add(makeLine(circlePoints(y, r, segments), FINE_WIDTH, LINE_COLOR, 'fine'));
  }

  return root;
}

/** Keep screen-space lines crisp on resize. */
export function updateSpinningTopLineResolution(
  mesh: THREE.Group,
  width: number,
  height: number,
): void {
  mesh.traverse((obj) => {
    if (obj instanceof Line2) {
      (obj.material as LineMaterial).resolution.set(width, height);
    }
  });
}

export function updateSpinningTopMesh(
  mesh: THREE.Group,
  physics: SpinningTopPhysics,
): void {
  mesh.position.copy(physics.getTipPosition(new THREE.Vector3()));

  const tiltGroup = mesh.getObjectByName('tiltGroup') as THREE.Group;
  const spinGroup = mesh.getObjectByName('spinGroup') as THREE.Group;

  const up = new THREE.Vector3(0, 1, 0);
  const axis = physics.getSpinAxis(new THREE.Vector3());

  if (axis.distanceToSquared(up) > 1e-8) {
    tiltGroup.quaternion.setFromUnitVectors(up, axis);
  } else {
    tiltGroup.quaternion.identity();
  }

  spinGroup.rotation.y = physics.spinAngle;
}

export function createVectorArrow(
  color: number,
  length = 0.5,
): THREE.ArrowHelper {
  const dir = new THREE.Vector3(0, 1, 0);
  return new THREE.ArrowHelper(dir, new THREE.Vector3(), length, color, 0.04, 0.02);
}

export function updateVectorArrow(
  arrow: THREE.ArrowHelper,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  scale: number,
  minLength = 0.02,
): void {
  const dirLen = direction.length();
  if (!Number.isFinite(dirLen) || dirLen < 1e-10) {
    arrow.visible = false;
    return;
  }
  const len = dirLen * scale;
  if (len < minLength) {
    arrow.visible = false;
    return;
  }
  arrow.visible = true;
  arrow.position.copy(origin);
  arrow.setDirection(direction.clone().normalize());
  arrow.setLength(len, len * 0.12, len * 0.06);
}

export const createGyroscopeMesh = createSpinningTopMesh;
export const updateGyroscopeMesh = updateSpinningTopMesh;
