import * as THREE from 'three';
import { buildSurfaceSamples } from '../topProfile';
import type { TracePath } from './TracePath';
import { CirclePath } from './TracePath';

/** Tip friction torque scales (rad/s² and 1/s at friction = 1; slider max ≈ 2). */
const COULOMB_FRICTION = 3.0;
const VISCOUS_FRICTION = 0.07;
/** Extra tip load when tilted: multiplier = 1 + gain·sin²θ (≈3× when horizontal). */
const TILT_FRICTION_GAIN = 2.0;
const FALLEN_TILT = Math.PI / 2 - 0.08;
const SIDEWAYS_COLLAPSE_TILT = Math.PI / 3;

export interface TopParams {
  I_spin: number;
  mass: number;
  comHeight: number;
  gravity: number;
  /** 0 = frictionless; higher = heavier tip + air drag (slider max ≈ 2) */
  friction: number;
}

/**
 * Spinning top — fast-spin limit, fully deterministic.
 * Upright at rest. Precession when tilted + spinning (ψ̇ = m g ℓ sin θ / I₃ ωₛ).
 * Spin-down: Coulomb tip friction + viscous drag, scaled by tilt (heavier contact
 * when sideways). Below critical ω, upright tops tip over; sideways tops slump flat.
 */
export class SpinningTopPhysics {
  tilt = 0;
  azimuth = 0;
  spinAngle = 0;
  spinRate = 0;
  readonly params: TopParams;
  targetSpinRate: number;
  floorY = 0;

  readonly spinAxis = new THREE.Vector3(0, 1, 0);
  readonly tipPosition = new THREE.Vector3(0, 0, 0);

  /** Decaying kicks from table bumps. */
  bumpTiltVelocity = 0;
  bumpAzimuthVelocity = 0;
  /** Sustained gentle puff (not an impulse). */
  windBurstRemaining = 0;
  windBurstDuration = 0;
  windDirX = 0;
  windDirZ = 0;
  windBurstStrength = 0;
  /** Constrained rolling path — tip slides along curve with gyroscopic coupling. */
  tracePath: TracePath | null = null;
  pathS = 0;
  pathVelocity = 0;

  private readonly _surfaceSamples = buildSurfaceSamples();
  private readonly _orientation = new THREE.Quaternion();
  private readonly _spinQ = new THREE.Quaternion();
  private readonly _tiltQ = new THREE.Quaternion();
  private readonly _comWorld = new THREE.Vector3();
  private readonly _tau = new THREE.Vector3();
  private readonly _tip = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _worldPoint = new THREE.Vector3();
  private readonly _axisAfter = new THREE.Vector3();

  constructor(params: Partial<TopParams> = {}) {
    this.params = {
      I_spin: 0.00035,
      mass: 0.055,
      comHeight: 0.028,
      gravity: 9.81,
      friction: 0.55,
      ...params,
    };

    this.targetSpinRate = 25;
    this.reset();
  }

  reset(): void {
    this.tilt = 0;
    this.azimuth = 0;
    this.spinAngle = 0;
    this.spinRate = 0;
    this.bumpTiltVelocity = 0;
    this.bumpAzimuthVelocity = 0;
    this.windBurstRemaining = 0;
    this.windBurstDuration = 0;
    this.windBurstStrength = 0;
    this.tracePath = null;
    this.pathS = 0;
    this.pathVelocity = 0;
    this.syncSpinAxis();
    this.plantTip();
  }

  /** Brings the top to rest. */
  stopSpin(): void {
    this.spinRate = 0;
  }

  /** Set desired spin rate; applies immediately if the top is already spinning. */
  setTargetSpinRate(rate: number): void {
    this.targetSpinRate = rate;
    if (this.spinRate > 0) {
      this.spinRate = rate;
      if (this.tracePath && rate > 1) {
        this.prepareTraceRoll();
      }
    }
  }

  /** Flick the top — sets spin to the speed chosen on the slider. */
  spinUp(): void {
    this.spinRate = this.targetSpinRate;
    if (this.tracePath) {
      this.prepareTraceRoll();
      return;
    }
    if (this.tilt < 1e-4) {
      this.azimuth = Math.random() * Math.PI * 2;
      this.syncSpinAxis();
    }
  }

  /** Tap the table edge — sends a ripple impulse through the surface. */
  applyTableBump(hitX: number, hitZ: number, tableRadius: number): boolean {
    const dist = Math.hypot(hitX, hitZ);
    const edgeInner = tableRadius * 0.72;
    if (dist < edgeInner) return false;

    const edgeFactor = THREE.MathUtils.smoothstep(dist, edgeInner, tableRadius * 0.98);
    const nx = hitX / dist;
    const nz = hitZ / dist;
    const strength = 0.55 * edgeFactor;

    this.bumpTiltVelocity += strength * 3.2;
    this.bumpAzimuthVelocity += strength * 4.8;

    const targetAz = Math.atan2(nx, nz);
    if (this.tilt < 0.06) {
      this.azimuth = targetAz;
      this.tilt = Math.max(this.tilt, 0.045 * edgeFactor);
    } else {
      this.azimuth = lerpAngle(this.azimuth, targetAz, 0.28 * edgeFactor);
    }
    this.syncSpinAxis();
    return true;
  }

  /** Directional puff — sustained and gentle; tilts when slow, drags when fast. */
  applyWind(dirX: number, dirZ: number, strength: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-5 || strength < 1e-4) return;

    this.windDirX = dirX / len;
    this.windDirZ = dirZ / len;
    this.windBurstStrength = THREE.MathUtils.clamp(strength, 0.06, 0.75);
    this.windBurstDuration = 0.85;
    this.windBurstRemaining = this.windBurstDuration;
  }

  isWindActive(): boolean {
    return this.windBurstRemaining > 0;
  }

  /** Lock the tip to a drawn curve — rolling contact + gyroscopic precession. */
  setTracePath(path: TracePath | null, seedX = 0, seedZ = 0): boolean {
    if (!path) {
      this.tracePath = null;
      this.pathS = 0;
      this.pathVelocity = 0;
      this.plantTip();
      return true;
    }

    this.tracePath = path;
    this.pathS = path.closestParameter(seedX, seedZ);
    this.pathVelocity = 0;
    this.plantTip();
    this.prepareTraceRoll();
    return true;
  }

  clearTracePath(): void {
    this.setTracePath(null);
  }

  hasActiveTrace(): boolean {
    return this.tracePath !== null;
  }

  getPathSpeed(): number {
    return this.pathVelocity;
  }
  applyTipPivotDrag(
    q: THREE.Quaternion,
    spinAxisAtGrab: THREE.Vector3,
    spinAngleAtGrab: number,
  ): void {
    this.plantTip();
    this.spinAngle = spinAngleAtGrab;

    this._axisAfter.copy(spinAxisAtGrab).applyQuaternion(q).normalize();
    this.spinAxis.copy(this._axisAfter);
    this.setTiltAzimuthFromSpinAxis();

    if (this.getMinSurfaceY() < this.floorY) {
      this.clampSpinAxisBetween(spinAxisAtGrab, this._axisAfter);
    }
  }

  /** Spin animation only — used while the user is dragging. */
  stepSpinOnly(dt: number): void {
    this.plantTip();
    this.applySpinFriction(dt);
    this.spinAngle += this.spinRate * dt;
  }

  /** Critical spin rate below which the top can no longer stay upright. */
  getCriticalSpinRate(): number {
    const { mass, comHeight, gravity, I_spin } = this.params;
    return Math.sqrt((mass * gravity * comHeight) / I_spin) * 1.75;
  }

  /** Friction multiplier from tip contact load — higher when tilted / sideways. */
  getTiltFrictionScale(): number {
    const sinT = Math.sin(this.tilt);
    return 1 + TILT_FRICTION_GAIN * sinT * sinT;
  }

  isSideways(): boolean {
    return this.tilt >= SIDEWAYS_COLLAPSE_TILT;
  }

  /** Approximate seconds from ω₀ down to the stability threshold at current friction. */
  estimateSpinDownSeconds(fromRate: number): number {
    const f = this.params.friction;
    if (f <= 0 || fromRate <= 0) return Infinity;

    const target = this.getCriticalSpinRate();
    if (fromRate <= target) return 0;

    const coulomb = f * COULOMB_FRICTION;
    const viscous = f * VISCOUS_FRICTION;
    const avgDecel =
      (coulomb + viscous * (fromRate + target) * 0.5) * this.getTiltFrictionScale();
    return (fromRate - target) / Math.max(avgDecel, 1e-6);
  }

  private applySpinFriction(dt: number): void {
    const f = this.params.friction;
    if (f <= 0 || this.spinRate <= 0) return;

    const coulomb = f * COULOMB_FRICTION;
    const viscous = f * VISCOUS_FRICTION;
    let decel = (coulomb + viscous * this.spinRate) * this.getTiltFrictionScale();
    this.spinRate = Math.max(0, this.spinRate - decel * dt);
  }

  /** Bell-curved puff spread over ~0.85 s — no instant snap. */
  private applyWindBurst(dt: number): void {
    if (this.windBurstRemaining <= 0) return;

    this.windBurstRemaining = Math.max(0, this.windBurstRemaining - dt);
    const elapsed = this.windBurstDuration - this.windBurstRemaining;
    const envelope = Math.sin((elapsed / this.windBurstDuration) * Math.PI);

    const omega = this.spinRate;
    const slowFactor = 1 - THREE.MathUtils.smoothstep(10, 50, omega);
    const fastFactor = THREE.MathUtils.smoothstep(22, 88, omega);
    const s = this.windBurstStrength * envelope;

    if (slowFactor > 0.02) {
      this.increaseTilt(slowFactor * s * 0.28 * dt);
      const targetAz = Math.atan2(this.windDirX, this.windDirZ);
      this.azimuth = lerpAngle(this.azimuth, targetAz, slowFactor * s * 0.42 * dt);
      this.syncSpinAxis();
    }

    if (fastFactor > 0.02 && omega > 0) {
      this.spinRate = Math.max(0, this.spinRate - fastFactor * s * 1.4 * dt);
    }
  }

  private applyExternalImpulses(dt: number): void {
    if (this.bumpTiltVelocity > 1e-5) {
      this.increaseTilt(this.bumpTiltVelocity * dt);
      this.bumpTiltVelocity *= Math.exp(-8 * dt);
    }

    const azKick = this.bumpAzimuthVelocity * dt;
    if (Math.abs(azKick) > 1e-7) {
      this.azimuth += azKick;
      this.syncSpinAxis();
    }
    this.bumpAzimuthVelocity *= Math.exp(-6 * dt);
  }

  /** Gyroscopic stability loss — upright tops tip; sideways tops slump flat. */
  private applyStabilityLoss(dt: number, gravityEnabled: boolean): void {
    if (!gravityEnabled || this.spinRate <= 0) return;

    const omegaCrit = this.getCriticalSpinRate();

    if (this.tilt >= SIDEWAYS_COLLAPSE_TILT && this.spinRate < omegaCrit * 1.15) {
      this.applySidewaysCollapse(dt, omegaCrit);
      return;
    }

    if (this.spinRate < omegaCrit) {
      const instability = 1 - this.spinRate / omegaCrit;
      this.increaseTilt(instability * 3.2 * dt);
    } else if (this.spinRate < omegaCrit * 1.25 && this.tilt > 1e-4) {
      const wobble = (1 - this.spinRate / (omegaCrit * 1.25)) * 0.35;
      this.increaseTilt(wobble * dt);
    }

    if (this.tilt >= FALLEN_TILT) {
      this.setFallen();
    }
  }

  /** High tilt + fading spin: can't hold pose — drops flat and stops. */
  private applySidewaysCollapse(dt: number, omegaCrit: number): void {
    const urgency = THREE.MathUtils.clamp(1 - this.spinRate / (omegaCrit * 1.15), 0, 1);
    const tiltBefore = this.tilt;

    this.tilt = THREE.MathUtils.lerp(this.tilt, FALLEN_TILT, urgency * 4 * dt);
    this.syncSpinAxis();

    if (this.getMinSurfaceY() < this.floorY) {
      this.tilt = tiltBefore;
      this.syncSpinAxis();
    }

    this.spinRate = Math.max(
      0,
      this.spinRate * (1 - urgency * 6 * dt) - urgency * 1.5 * dt,
    );

    if (this.tilt >= FALLEN_TILT - 0.02 || this.spinRate < 0.5) {
      this.setFallen();
    }
  }

  private setFallen(): void {
    this.tilt = FALLEN_TILT;
    this.spinRate = 0;
    this.syncSpinAxis();
  }

  private increaseTilt(delta: number): void {
    if (delta <= 0) return;

    const tiltBefore = this.tilt;
    this.tilt = Math.min(FALLEN_TILT, this.tilt + delta);
    this.syncSpinAxis();

    if (this.getMinSurfaceY() < this.floorY) {
      this.tilt = tiltBefore;
      this.syncSpinAxis();
    }
  }

  getOrientation(out: THREE.Quaternion): THREE.Quaternion {
    this.syncSpinAxis();
    this._tiltQ.setFromUnitVectors(this._up, this.spinAxis);
    this._spinQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.spinAngle);
    return out.copy(this._tiltQ).multiply(this._spinQ);
  }

  private plantTip(): void {
    if (this.tracePath) {
      this.tracePath.sample(this.pathS, this.tipPosition);
      this.tipPosition.y = this.floorY;
    } else {
      this.tipPosition.set(0, this.floorY, 0);
      this.pathS = 0;
      this.pathVelocity = 0;
    }
  }

  /**
   * Rolling contact on a constrained curve: spin drives roll speed (v ≈ r_eff · ω_s);
   * friction damps slip against the ideal no-slip rate.
   */
  private applyTraceRolling(dt: number): void {
    const path = this.tracePath;
    if (!path) return;

    const { mass, comHeight, friction } = this.params;

    if (this.spinRate > 1 && this.tilt < 0.06) {
      this.applyTraceTilt(path);
    }

    if (this.spinRate > 1) {
      this.syncAzimuthToPath(path, dt);
    }

    const rollRate =
      this.spinRate > 1
        ? path.rollRateFromSpin(this.pathS, this.spinRate, this.tilt, comHeight)
        : 0;

    const slip = this.pathVelocity - rollRate;
    const load = mass * this.params.gravity * (0.65 + 0.35 * this.getTiltFrictionScale());
    const mu = friction;
    const frictionAccel = (-mu * load * Math.tanh(slip / 0.06)) / mass;
    const trackGain = 24 + mu * 14;
    const blend = 1 - Math.exp(-trackGain * dt);

    this.pathVelocity = THREE.MathUtils.lerp(this.pathVelocity, rollRate, blend);
    this.pathVelocity += frictionAccel * dt;

    if (Math.abs(slip) > 0.015 && mu > 0 && this.spinRate > 1) {
      this.spinRate = Math.max(0, this.spinRate - Math.abs(slip) * mu * 0.18 * dt);
    }

    if (this.spinRate <= 1) {
      this.pathVelocity = THREE.MathUtils.lerp(this.pathVelocity, 0, blend);
    }

    const nextS = this.pathS + this.pathVelocity * dt;
    if (path.loops) {
      this.pathS = path.clampS(nextS);
    } else if (nextS <= 0) {
      this.pathS = 0;
      this.pathVelocity = 0;
    } else if (nextS >= path.length) {
      this.pathS = path.length;
      this.pathVelocity = 0;
    } else {
      this.pathS = nextS;
    }
    this.plantTip();

    if (this.getMinSurfaceY() < this.floorY) {
      this.pathS = path.clampS(this.pathS - this.pathVelocity * dt);
      this.pathVelocity *= 0.35;
      this.plantTip();
    }
  }

  /** Minimum tilt + lean so the tip can roll as soon as spin is applied. */
  private applyTraceTilt(path: TracePath): void {
    if (path.kind === 'circle') {
      const circle = path as CirclePath;
      const toCenter = Math.atan2(circle.cx - this.tipPosition.x, circle.cz - this.tipPosition.z);
      this.azimuth = toCenter;
      this.tilt = Math.max(this.tilt, Math.min(0.14, circle.radius * 0.32));
    } else {
      path.tangent(this.pathS, this._tau);
      this.azimuth = Math.atan2(this._tau.x, this._tau.z);
      this.tilt = Math.max(this.tilt, path.kind === 'line' ? 0.1 : 0.09);
    }
    this.syncSpinAxis();
  }

  private syncAzimuthToPath(path: TracePath, dt: number): void {
    let targetAz: number;
    if (path.kind === 'circle') {
      const circle = path as CirclePath;
      path.sample(this.pathS, this._worldPoint);
      targetAz = Math.atan2(circle.cx - this._worldPoint.x, circle.cz - this._worldPoint.z);
    } else {
      path.tangent(this.pathS, this._tau);
      targetAz = Math.atan2(this._tau.x, this._tau.z);
    }
    this.azimuth = lerpAngle(this.azimuth, targetAz, 1 - Math.exp(-8 * dt));
    this.syncSpinAxis();
  }

  /** Align lean and set initial path speed when a trace is active. */
  private prepareTraceRoll(): void {
    const path = this.tracePath;
    if (!path) return;

    if (this.tilt < 0.06) {
      this.applyTraceTilt(path);
    }

    this.pathVelocity =
      this.spinRate > 1
        ? path.rollRateFromSpin(this.pathS, this.spinRate, this.tilt, this.params.comHeight)
        : 0;
    this.plantTip();
  }

  private getMinSurfaceY(): number {
    const orientation = this.getOrientation(this._orientation);
    let minY = Infinity;

    for (const sample of this._surfaceSamples) {
      this._worldPoint.copy(sample).applyQuaternion(orientation).add(this.tipPosition);
      if (this._worldPoint.y < minY) minY = this._worldPoint.y;
    }

    return minY;
  }

  private clampSpinAxisBetween(axisBefore: THREE.Vector3, axisAfter: THREE.Vector3): void {
    let tLo = 0;
    let tHi = 1;

    for (let i = 0; i < 12; i++) {
      const t = (tLo + tHi) / 2;
      this.spinAxis.copy(axisBefore).lerp(axisAfter, t).normalize();
      this.setTiltAzimuthFromSpinAxis();

      if (this.getMinSurfaceY() < this.floorY) {
        tHi = t;
      } else {
        tLo = t;
      }
    }

    this.spinAxis.copy(axisBefore).lerp(axisAfter, tLo).normalize();
    this.setTiltAzimuthFromSpinAxis();
  }

  private setTiltAzimuthFromSpinAxis(): void {
    this.tilt = Math.acos(THREE.MathUtils.clamp(this.spinAxis.y, -1, 1));
    if (this.tilt > 1e-5) {
      this.azimuth = Math.atan2(this.spinAxis.x, this.spinAxis.z);
    }
    this.syncSpinAxis();
  }

  private syncSpinAxis(): void {
    const sinT = Math.sin(this.tilt);
    const cosT = Math.cos(this.tilt);
    this.spinAxis.set(
      sinT * Math.sin(this.azimuth),
      cosT,
      sinT * Math.cos(this.azimuth),
    );
  }

  getTipPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.tipPosition);
  }

  getSpinAxis(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.spinAxis);
  }

  getSpinRate(): number {
    return this.spinRate;
  }

  isSpinning(): boolean {
    return this.spinRate > 1;
  }

  getCenterOfMass(out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(this.spinAxis)
      .multiplyScalar(this.params.comHeight)
      .add(this.getTipPosition(this._tip));
  }

  getAngularMomentum(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.spinAxis).multiplyScalar(this.params.I_spin * this.spinRate);
  }

  getGravityTorque(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    this.getCenterOfMass(this._comWorld);
    this._tau.set(0, -this.params.mass * this.params.gravity, 0);
    return out.crossVectors(this._comWorld, this._tau);
  }

  getTiltDegrees(): number {
    return this.tilt * (180 / Math.PI);
  }

  getPrecessionRate(gravityEnabled: boolean): number {
    if (!gravityEnabled || this.spinRate < 1 || this.tilt < 1e-4) return 0;
    const { mass, comHeight, gravity, I_spin } = this.params;
    return (mass * gravity * comHeight * Math.sin(this.tilt)) / (I_spin * this.spinRate);
  }

  step(dt: number, gravityEnabled: boolean): void {
    const { mass, comHeight, gravity, I_spin } = this.params;
    const azimuthBefore = this.azimuth;

    this.plantTip();
    this.applyExternalImpulses(dt);
    this.applyWindBurst(dt);

    let psiDot = 0;
    if (gravityEnabled && this.spinRate > 1 && this.tilt > 1e-4) {
      psiDot =
        (mass * gravity * comHeight * Math.sin(this.tilt)) / (I_spin * this.spinRate);
      psiDot = Math.min(psiDot, 18);
    }

    if (this.tracePath) {
      this.applyTraceRolling(dt);
    } else if (gravityEnabled && this.spinRate > 1 && this.tilt > 1e-4) {
      this.azimuth += psiDot * dt;
      this.syncSpinAxis();

      if (this.getMinSurfaceY() < this.floorY) {
        this.azimuth = azimuthBefore;
        this.syncSpinAxis();
      }
    } else {
      this.plantTip();
    }

    this.applySpinFriction(dt);
    this.applyStabilityLoss(dt, gravityEnabled);
    this.spinAngle += this.spinRate * dt;
    this.plantTip();
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export { SpinningTopPhysics as GyroscopePhysics };
