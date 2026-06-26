import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { SpinningTopPhysics } from '../physics/SpinningTopPhysics';

const OUTER_GREEN = 0x3dff7a;
const INNER_GREEN = 0x8fd4a8;
const BOLD_WIDTH = 2;
const FINE_WIDTH = 1;

/** Build a lathe profile matching the totem-style spinning top. */
function createTopProfile(): THREE.Vector2[] {
  const key = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.012, 0.012),
    new THREE.Vector2(0.028, 0.018),
    new THREE.Vector2(0.055, 0.032),
    new THREE.Vector2(0.054, 0.038),
    new THREE.Vector2(0.028, 0.042),
    new THREE.Vector2(0.012, 0.048),
    new THREE.Vector2(0.007, 0.09),
    new THREE.Vector2(0.006, 0.13),
    new THREE.Vector2(0.007, 0.155),
    new THREE.Vector2(0.003, 0.165),
  ];
  // Smooth spline so meridians hug the curved outer edge
  const curve = new THREE.SplineCurve(key);
  return curve.getPoints(72);
}

function meridianPoints(profile: THREE.Vector2[], azimuth: number): THREE.Vector3[] {
  const c = Math.cos(azimuth);
  const s = Math.sin(azimuth);
  return profile.map((p) => new THREE.Vector3(p.x * c, p.y, p.x * s));
}

/** Meridian arc on one curved outer section (continuous). */
function meridianSection(
  profile: THREE.Vector2[],
  azimuth: number,
  yMin: number,
  yMax: number,
): THREE.Vector3[] {
  const c = Math.cos(azimuth);
  const s = Math.sin(azimuth);
  return profile
    .filter((p) => p.y >= yMin && p.y <= yMax)
    .map((p) => new THREE.Vector3(p.x * c, p.y, p.x * s));
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
    opacity: tag === 'bold' ? 1 : 0.7,
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

  // ── Bold 2 px outer silhouette ──
  const outerGroup = new THREE.Group();
  outerGroup.name = 'outerLines';
  spinGroup.add(outerGroup);

  // Elevation outlines (meridians)
  outerGroup.add(makeLine(meridianPoints(profile, 0), BOLD_WIDTH, OUTER_GREEN, 'bold'));
  outerGroup.add(makeLine(meridianPoints(profile, Math.PI / 2), BOLD_WIDTH, OUTER_GREEN, 'bold'));

  // Bold outermost contour rings
  outerGroup.add(makeLine(circlePoints(0.032, 0.055, 72), BOLD_WIDTH, OUTER_GREEN, 'bold'));
  outerGroup.add(makeLine(circlePoints(yTop, 0.003, 32), BOLD_WIDTH, OUTER_GREEN, 'bold'));

  // ── Fine 1 px — few meridians hugging the curved outer edge ──
  const innerGroup = new THREE.Group();
  innerGroup.name = 'innerLines';
  spinGroup.add(innerGroup);

  const fineAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  // Curved outer sections: tip cone + disk flare
  const edgeSections: [number, number][] = [
    [0, 0.022],
    [0.015, 0.045],
  ];
  for (const az of fineAngles) {
    for (const [yMin, yMax] of edgeSections) {
      const pts = meridianSection(profile, az, yMin, yMax);
      if (pts.length > 2) {
        innerGroup.add(makeLine(pts, FINE_WIDTH, INNER_GREEN, 'fine'));
      }
    }
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

export function createGround(): THREE.Mesh {
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1.2, 64),
    new THREE.MeshStandardMaterial({
      color: 0x0e1218,
      metalness: 0.2,
      roughness: 0.85,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  return ground;
}

export function createTable(): THREE.Group {
  const table = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({
    color: 0x141820,
    metalness: 0.05,
    roughness: 0.9,
  });

  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 0.025, 64),
    wood,
  );
  top.position.y = -0.012;
  table.add(top);

  return table;
}

export const createGyroscopeMesh = createSpinningTopMesh;
export const updateGyroscopeMesh = updateSpinningTopMesh;
export const createPivotStand = createTable;
