import * as THREE from 'three';

export interface TopParams {
  I_spin: number;
  mass: number;
  comHeight: number;
  gravity: number;
  spinDrag: number;
}

/**
 * Spinning top — fast-spin limit, fully deterministic.
 * Upright at rest. Precession only when tilted + spinning (ψ̇ = m g ℓ sin θ / I₃ ωₛ).
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

  private readonly _orientation = new THREE.Quaternion();
  private readonly _spinQ = new THREE.Quaternion();
  private readonly _comWorld = new THREE.Vector3();
  private readonly _tau = new THREE.Vector3();
  private readonly _tip = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(params: Partial<TopParams> = {}) {
    this.params = {
      I_spin: 0.00035,
      mass: 0.055,
      comHeight: 0.028,
      gravity: 9.81,
      spinDrag: 0.00008,
      ...params,
    };

    this.targetSpinRate = 80;
    this.reset();
  }

  reset(): void {
    this.tilt = 0;
    this.azimuth = 0;
    this.spinAngle = 0;
    this.spinRate = 0;
    this.syncSpinAxis();
  }

  /** Flick the top — sets spin to the speed chosen on the slider. */
  spinUp(): void {
    this.spinRate = this.targetSpinRate;
  }

  /** Direct tilt/azimuth nudge from drag (rad). */
  applyDrag(dAzimuth: number, dTilt: number): void {
    this.azimuth += dAzimuth;
    this.tilt = THREE.MathUtils.clamp(this.tilt + dTilt, 0, Math.PI / 2 - 0.05);
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
    return out.set(0, this.floorY, 0);
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

  getOrientation(out: THREE.Quaternion): THREE.Quaternion {
    this.syncSpinAxis();
    this._orientation.setFromUnitVectors(this._up, this.spinAxis);
    this._spinQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.spinAngle);
    return out.copy(this._orientation).multiply(this._spinQ);
  }

  step(dt: number, gravityEnabled: boolean): void {
    const { mass, comHeight, gravity, I_spin, spinDrag } = this.params;

    // Precession only when spinning and slightly tilted
    if (gravityEnabled && this.spinRate > 5 && this.tilt > 1e-4) {
      const psiDot =
        (mass * gravity * comHeight * Math.sin(this.tilt)) / (I_spin * this.spinRate);
      this.azimuth += psiDot * dt;
    }

    // Spin slows from friction; no hidden motor
    this.spinRate = Math.max(0, this.spinRate - spinDrag * this.spinRate * dt);

    this.spinAngle += this.spinRate * dt;
    this.syncSpinAxis();
  }
}

export { SpinningTopPhysics as GyroscopePhysics };
