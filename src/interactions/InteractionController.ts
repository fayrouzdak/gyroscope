import * as THREE from 'three';
import type { SpinningTopPhysics } from '../physics/SpinningTopPhysics';
import { TABLE_RADIUS, intersectPlayPlane } from '../scene/tableSurface';

export type InteractionMode = 'tilt' | 'bump' | 'wind' | 'trace';

const MODE_HINTS: Record<InteractionMode, string> = {
  tilt: 'Drag the top to tilt it.',
  bump: 'Click near the outer edge to send a ripple impulse.',
  wind: 'Drag gently through open space — a soft puff, not a tap.',
  trace: 'Draw a closed circle in the air above the pivot to steer precession.',
};

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
  if (Math.hypot(first.x - last.x, first.z - last.z) > radius * 0.75) return null;

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }

  return { cx, cz, radius, clockwise: area < 0 };
}

export class InteractionController {
  mode: InteractionMode = 'tilt';

  private readonly physics: SpinningTopPhysics;
  private readonly overlay = new THREE.Group();

  private tableHit = new THREE.Vector3();
  private windOrigin = new THREE.Vector3();
  private windActive = false;
  private traceActive = false;
  private tracePoints: THREE.Vector3[] = [];

  private pathLine: THREE.Line | null = null;
  private circleLine: THREE.Line | null = null;
  private windArrow: THREE.ArrowHelper | null = null;
  private bumpRing: THREE.Mesh | null = null;
  private bumpRingLife = 0;

  constructor(scene: THREE.Scene, physics: SpinningTopPhysics) {
    this.physics = physics;
    this.overlay.name = 'interactionOverlay';
    scene.add(this.overlay);
  }

  setMode(mode: InteractionMode): void {
    this.mode = mode;
    this.cancelGesture();
  }

  getHint(): string {
    return MODE_HINTS[this.mode];
  }

  consumesTopDrag(): boolean {
    return this.mode !== 'tilt';
  }

  update(dt: number): void {
    if (this.bumpRing && this.bumpRingLife > 0) {
      this.bumpRingLife -= dt;
      const t = 1 - this.bumpRingLife / 0.45;
      const scale = 0.92 + t * 0.14;
      this.bumpRing.scale.set(scale, 1, scale);
      (this.bumpRing.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t);
      if (this.bumpRingLife <= 0) {
        this.overlay.remove(this.bumpRing);
        this.bumpRing.geometry.dispose();
        (this.bumpRing.material as THREE.Material).dispose();
        this.bumpRing = null;
      }
    }
  }

  handlePointerDown(raycaster: THREE.Raycaster): boolean {
    if (this.mode === 'tilt') return false;
    if (!this.hitTable(raycaster)) return false;

    if (this.mode === 'bump') {
      if (this.physics.applyTableBump(this.tableHit.x, this.tableHit.z, TABLE_RADIUS)) {
        this.showBumpRing(this.tableHit.x, this.tableHit.z);
      }
      return true;
    }

    if (this.mode === 'wind') {
      this.windOrigin.copy(this.tableHit);
      this.windActive = true;
      this.updateWindArrow(this.tableHit);
      return true;
    }

    if (this.mode === 'trace') {
      this.traceActive = true;
      this.tracePoints = [this.tableHit.clone()];
      this.updatePathLine();
      return true;
    }

    return false;
  }

  handlePointerMove(raycaster: THREE.Raycaster): boolean {
    if (this.mode === 'wind' && this.windActive && this.hitTable(raycaster)) {
      this.updateWindArrow(this.tableHit);
      return true;
    }

    if (this.mode === 'trace' && this.traceActive && this.hitTable(raycaster)) {
      const last = this.tracePoints[this.tracePoints.length - 1];
      if (last.distanceToSquared(this.tableHit) > 0.00008) {
        this.tracePoints.push(this.tableHit.clone());
        this.updatePathLine();
      }
      return true;
    }

    return false;
  }

  handlePointerUp(raycaster: THREE.Raycaster): boolean {
    if (this.mode === 'wind' && this.windActive) {
      if (this.hitTable(raycaster)) {
        const dx = this.tableHit.x - this.windOrigin.x;
        const dz = this.tableHit.z - this.windOrigin.z;
        const len = Math.hypot(dx, dz);
        if (len > 0.02) {
          this.physics.applyWind(dx, dz, THREE.MathUtils.clamp(len / 0.55, 0.08, 0.65));
        }
      }
      this.clearWindArrow();
      this.windActive = false;
      return true;
    }

    if (this.mode === 'trace' && this.traceActive) {
      const fit = fitCircle(this.tracePoints);
      if (fit && this.physics.setPrecessionFromCircle(fit.cx, fit.cz, fit.radius, fit.clockwise)) {
        this.showCircleGuide(fit);
      } else {
        this.clearCircleGuide();
      }
      this.clearPathLine();
      this.traceActive = false;
      this.tracePoints = [];
      return true;
    }

    return false;
  }

  cancelGesture(): void {
    this.windActive = false;
    this.traceActive = false;
    this.tracePoints = [];
    this.clearWindArrow();
    this.clearPathLine();
  }

  private hitTable(raycaster: THREE.Raycaster): boolean {
    return intersectPlayPlane(raycaster, this.tableHit);
  }

  private updatePathLine(): void {
    this.clearPathLine();
    if (this.tracePoints.length < 2) return;

    const mat = new THREE.LineBasicMaterial({ color: 0x004d2c, transparent: true, opacity: 0.85 });
    const geo = new THREE.BufferGeometry().setFromPoints(this.tracePoints);
    this.pathLine = new THREE.Line(geo, mat);
    this.pathLine.position.y = 0.002;
    this.overlay.add(this.pathLine);
  }

  private clearPathLine(): void {
    if (!this.pathLine) return;
    this.overlay.remove(this.pathLine);
    this.pathLine.geometry.dispose();
    (this.pathLine.material as THREE.Material).dispose();
    this.pathLine = null;
  }

  private showCircleGuide(fit: CircleFit): void {
    this.clearCircleGuide();
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        fit.cx + Math.cos(t) * fit.radius,
        0.002,
        fit.cz + Math.sin(t) * fit.radius,
      ));
    }
    const mat = new THREE.LineDashedMaterial({
      color: 0x004d2c,
      transparent: true,
      opacity: 0.45,
      dashSize: 0.04,
      gapSize: 0.025,
    });
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.circleLine = new THREE.Line(geo, mat);
    this.circleLine.computeLineDistances();
    this.overlay.add(this.circleLine);

    window.setTimeout(() => this.clearCircleGuide(), 2200);
  }

  private clearCircleGuide(): void {
    if (!this.circleLine) return;
    this.overlay.remove(this.circleLine);
    this.circleLine.geometry.dispose();
    (this.circleLine.material as THREE.Material).dispose();
    this.circleLine = null;
  }

  private updateWindArrow(target: THREE.Vector3): void {
    const dx = target.x - this.windOrigin.x;
    const dz = target.z - this.windOrigin.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.008) {
      this.clearWindArrow();
      return;
    }

    const dir = new THREE.Vector3(dx / len, 0, dz / len);
    const arrowLen = THREE.MathUtils.clamp(len, 0.04, 0.38);

    if (!this.windArrow) {
      this.windArrow = new THREE.ArrowHelper(
        dir,
        this.windOrigin,
        arrowLen,
        0x1a6b45,
        0.028,
        0.018,
      );
      this.windArrow.line.material = new THREE.LineBasicMaterial({
        color: 0x1a6b45,
        transparent: true,
        opacity: 0.45,
      });
      this.windArrow.cone.material = new THREE.MeshBasicMaterial({
        color: 0x1a6b45,
        transparent: true,
        opacity: 0.45,
      });
      this.overlay.add(this.windArrow);
    } else {
      this.windArrow.position.copy(this.windOrigin);
      this.windArrow.setDirection(dir);
      this.windArrow.setLength(arrowLen, 0.028, 0.018);
    }
  }

  private clearWindArrow(): void {
    if (!this.windArrow) return;
    this.overlay.remove(this.windArrow);
    this.windArrow.dispose();
    this.windArrow = null;
  }

  private showBumpRing(x: number, z: number): void {
    if (this.bumpRing) {
      this.overlay.remove(this.bumpRing);
      this.bumpRing.geometry.dispose();
      (this.bumpRing.material as THREE.Material).dispose();
    }

    const geo = new THREE.RingGeometry(0.04, 0.055, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x004d2c,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    this.bumpRing = new THREE.Mesh(geo, mat);
    this.bumpRing.rotation.x = -Math.PI / 2;
    this.bumpRing.position.set(x, 0.003, z);
    this.bumpRingLife = 0.45;
    this.overlay.add(this.bumpRing);
  }
}
