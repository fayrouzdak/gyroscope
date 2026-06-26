import * as THREE from 'three';

/** Invisible interaction boundary in the XZ plane. */
export const TABLE_RADIUS = 1.2;

const PLAY_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _planeHit = new THREE.Vector3();

/** Raycast onto the y = 0 play plane (no visible floor). */
export function intersectPlayPlane(raycaster: THREE.Raycaster, out: THREE.Vector3): boolean {
  const hit = raycaster.ray.intersectPlane(PLAY_PLANE, _planeHit);
  if (!hit) return false;
  if (Math.hypot(_planeHit.x, _planeHit.z) > TABLE_RADIUS) return false;
  out.copy(_planeHit);
  return true;
}
