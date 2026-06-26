import * as THREE from 'three';
import type { SpinningTopPhysics } from '../physics/SpinningTopPhysics';
import { parseTracePath, type TracePath } from '../physics/TracePath';
import { TABLE_RADIUS, intersectPlayPlane } from '../scene/tableSurface';

export type InteractionMode = 'tilt' | 'bump' | 'wind' | 'trace';

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
  private committedPathLine: THREE.Line | null = null;
  private pathFadeLife = 0;
  private windArrow: THREE.ArrowHelper | null = null;
  private bumpRing: THREE.Mesh | null = null;
  private bumpRingLife = 0;

  private static readonly PATH_FADE_DURATION = 0.55;

  constructor(scene: THREE.Scene, physics: SpinningTopPhysics) {
    this.physics = physics;
    this.overlay.name = 'interactionOverlay';
    scene.add(this.overlay);
  }

  setMode(mode: InteractionMode): void {
    this.mode = mode;
    this.cancelGesture();
  }

  consumesTopDrag(): boolean {
    return this.mode !== 'tilt';
  }

  onPhysicsReset(): void {
    this.cancelGesture();
  }

  /** Fade out the committed path when the top starts spinning. */
  onSpin(): void {
    if (this.committedPathLine && this.pathFadeLife <= 0) {
      this.pathFadeLife = InteractionController.PATH_FADE_DURATION;
    }
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

    if (this.committedPathLine && this.pathFadeLife > 0) {
      this.pathFadeLife -= dt;
      const t = 1 - this.pathFadeLife / InteractionController.PATH_FADE_DURATION;
      (this.committedPathLine.material as THREE.LineBasicMaterial).opacity = 0.85 * (1 - t);
      if (this.pathFadeLife <= 0) {
        this.clearCommittedPath();
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
      const path = parseTracePath(this.tracePoints);
      const seed = this.tracePoints[0];
      if (path && this.physics.setTracePath(path, seed.x, seed.z)) {
        this.commitPath(path);
      } else {
        this.clearCommittedPath();
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
    this.clearCommittedPath();
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

  private commitPath(path: TracePath): void {
    this.clearCommittedPath();
    this.pathFadeLife = 0;

    const pts = path.getGuidePoints().map((p) => new THREE.Vector3(p.x, 0.002, p.z));
    const mat = new THREE.LineBasicMaterial({
      color: 0x004d2c,
      transparent: true,
      opacity: 0.85,
    });
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.committedPathLine = new THREE.Line(geo, mat);
    this.overlay.add(this.committedPathLine);
  }

  private clearCommittedPath(): void {
    if (!this.committedPathLine) return;
    this.overlay.remove(this.committedPathLine);
    this.committedPathLine.geometry.dispose();
    (this.committedPathLine.material as THREE.Material).dispose();
    this.committedPathLine = null;
    this.pathFadeLife = 0;
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
