import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SpinningTopPhysics } from './physics/SpinningTopPhysics';
import {
  createSpinningTopMesh,
  createVectorArrow,
  updateSpinningTopMesh,
  updateSpinningTopLineResolution,
  updateVectorArrow,
} from './scene/GyroscopeScene';
import {
  InteractionController,
  type InteractionMode,
} from './interactions/InteractionController';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const canvasFrame = document.getElementById('canvas-frame')!;
const statsEl = document.getElementById('stats')!;
const spinBtn = document.getElementById('spin') as HTMLButtonElement;
const spinSlider = document.getElementById('spin-speed') as HTMLInputElement;
const spinValue = document.getElementById('spin-value')!;
const frictionSlider = document.getElementById('friction') as HTMLInputElement;
const frictionValue = document.getElementById('friction-value')!;
const gravityCheck = document.getElementById('gravity') as HTMLInputElement;
const vectorsCheck = document.getElementById('vectors') as HTMLInputElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const interactionHint = document.getElementById('interaction-hint')!;
const modeButtons = document.querySelectorAll<HTMLButtonElement>('.mode-btn');

const CREAM = 0xf8f8f8;
const FOREST = 0x004d2c;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(CREAM);

const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 30);
camera.position.set(0.28, 0.18, 0.42);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 0.07, 0);
controls.minDistance = 0.12;
controls.maxDistance = 2;
controls.enablePan = false;
controls.mouseButtons = {
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};

scene.add(new THREE.AmbientLight(0xf8f8f8, 0.75));

const keyLight = new THREE.DirectionalLight(0xfff8f0, 1.4);
keyLight.position.set(1.2, 2, 1.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xe8f0ea, 0.45);
fillLight.position.set(-1.5, 0.6, -0.8);
scene.add(fillLight);

const physics = new SpinningTopPhysics();
const topMesh = createSpinningTopMesh();
scene.add(topMesh);

const interactions = new InteractionController(scene, physics);

const L_ARROW = createVectorArrow(FOREST, 0.25);
const TAU_ARROW = createVectorArrow(0x8b3a3a, 0.25);
const AXIS_ARROW = createVectorArrow(0x333333, 0.2);
scene.add(L_ARROW, TAU_ARROW, AXIS_ARROW);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const _origin = new THREE.Vector3();
const _L = new THREE.Vector3();
const _tau = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _grabHit = new THREE.Vector3();
const _grabDir = new THREE.Vector3();
const _grabCurr = new THREE.Vector3();
const _grabQuat = new THREE.Quaternion();
const _grabSphere = new THREE.Sphere();
const _grabSpinAxis = new THREE.Vector3();
const _rayClosest = new THREE.Vector3();

const TABLE_TOP = new THREE.Vector3(0, 0, 0);

let dragging = false;
let hovered = false;
let grabRadius = 0.06;
let grabSpinAngle = 0;

function setPointerFromEvent(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function hitTop(): boolean {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(topMesh, true).length > 0;
}

function pointerToSphereDir(out: THREE.Vector3): boolean {
  _grabSphere.center.copy(TABLE_TOP);
  _grabSphere.radius = grabRadius;
  raycaster.setFromCamera(pointer, camera);

  const hit = raycaster.ray.intersectSphere(_grabSphere, _grabHit);
  if (hit) {
    out.copy(_grabHit).sub(TABLE_TOP);
  } else {
    raycaster.ray.closestPointToPoint(_grabSphere.center, _rayClosest);
    out.copy(_rayClosest).sub(TABLE_TOP);
  }

  if (out.lengthSq() < 1e-8) return false;
  out.normalize();
  return true;
}

function beginGrab(): boolean {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(topMesh, true);
  if (hits.length === 0) return false;

  _grabHit.copy(hits[0].point);
  grabRadius = Math.max(_grabHit.distanceTo(TABLE_TOP), 0.04);
  _grabDir.copy(_grabHit).sub(TABLE_TOP).normalize();
  physics.getSpinAxis(_grabSpinAxis);
  grabSpinAngle = physics.spinAngle;
  return true;
}

const FRICTION_MAX = 1;

function frictionSliderToValue(value: number): number {
  const t = value / 100;
  return t * t * FRICTION_MAX;
}

function frictionValueToSlider(friction: number): number {
  if (friction <= 0) return 0;
  return Math.round(Math.sqrt(friction / FRICTION_MAX) * 100);
}

function formatFrictionLabel(friction: number): string {
  if (friction <= 0) return 'none';
  const rate = physics.spinRate > 0 ? physics.spinRate : physics.targetSpinRate;
  const seconds = physics.estimateSpinDownSeconds(rate);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds >= 60) return `~${(seconds / 60).toFixed(1)} min to fall`;
  if (seconds < 10) return `~${seconds.toFixed(1)} s to fall`;
  return `~${seconds.toFixed(0)} s to fall`;
}

function syncSpinUi(): void {
  spinSlider.value = String(Math.round(physics.targetSpinRate));
  spinValue.textContent = `${Math.round(physics.targetSpinRate)} rad/s`;
}

function syncFrictionUi(): void {
  frictionSlider.value = String(frictionValueToSlider(physics.params.friction));
  frictionValue.textContent = formatFrictionLabel(physics.params.friction);
}

function updateSpinButton(): void {
  const spinning = physics.isSpinning();
  const label = spinBtn.querySelector('.cta-btn-label');
  if (label) label.textContent = spinning ? 'Stop' : 'Spin';
  spinBtn.classList.toggle('active', spinning);
  spinBtn.setAttribute('aria-pressed', String(spinning));
}

const toolbar = document.querySelector('.toolbar') as HTMLElement;
const toolbarMenus = document.querySelector('.toolbar-menus') as HTMLElement;
let hideMenuTimer: ReturnType<typeof setTimeout> | null = null;

function setActiveMenu(menu: string | null): void {
  if (menu) {
    toolbar.dataset.activeMenu = menu;
    toolbarMenus.removeAttribute('aria-hidden');
  } else {
    delete toolbar.dataset.activeMenu;
    toolbarMenus.setAttribute('aria-hidden', 'true');
  }
}

function cancelHideMenu(): void {
  if (hideMenuTimer !== null) {
    clearTimeout(hideMenuTimer);
    hideMenuTimer = null;
  }
}

function scheduleHideMenu(): void {
  cancelHideMenu();
  hideMenuTimer = setTimeout(() => setActiveMenu(null), 180);
}

document.querySelectorAll<HTMLElement>('.toolbar-popover').forEach((trigger) => {
  trigger.addEventListener('mouseenter', () => {
    cancelHideMenu();
    setActiveMenu(trigger.dataset.menu ?? null);
  });
  trigger.addEventListener('mouseleave', scheduleHideMenu);
});

toolbarMenus.addEventListener('mouseenter', cancelHideMenu);
toolbarMenus.addEventListener('mouseleave', scheduleHideMenu);

document.querySelectorAll<HTMLElement>('.popover-anchor').forEach((anchor) => {
  anchor.addEventListener('focusin', () => {
    cancelHideMenu();
    setActiveMenu(anchor.dataset.menu ?? null);
  });
  anchor.addEventListener('focusout', (e) => {
    if (!anchor.contains(e.relatedTarget as Node)) scheduleHideMenu();
  });
});

canvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 2) return;
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, camera);

  if (interactions.handlePointerMove(raycaster)) {
    canvas.style.cursor = interactions.mode === 'trace' ? 'crosshair' : 'pointer';
    return;
  }

  hovered = hitTop();
  const modeCursor =
    interactions.mode === 'bump'
      ? 'pointer'
      : interactions.mode === 'wind' || interactions.mode === 'trace'
        ? 'crosshair'
        : dragging
          ? 'grabbing'
          : hovered
            ? 'grab'
            : 'default';
  canvas.style.cursor = modeCursor;

  if (dragging && pointerToSphereDir(_grabCurr)) {
    _grabQuat.setFromUnitVectors(_grabDir, _grabCurr);
    physics.applyTipPivotDrag(_grabQuat, _grabSpinAxis, grabSpinAngle);
  }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, camera);

  if (interactions.handlePointerDown(raycaster)) {
    if (interactions.mode === 'wind' || interactions.mode === 'trace') {
      canvas.setPointerCapture(e.pointerId);
    }
    return;
  }
  if (interactions.consumesTopDrag()) return;

  if (beginGrab()) {
    dragging = true;
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, camera);
  interactions.handlePointerUp(raycaster);

  dragging = false;
  controls.enabled = true;
  canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('pointerleave', () => {
  dragging = false;
  controls.enabled = true;
  interactions.cancelGesture();
});

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode as InteractionMode;
    interactions.setMode(mode);
    modeButtons.forEach((b) => b.classList.toggle('active', b === btn));
    interactionHint.textContent = interactions.getHint();
  });
});

spinBtn.addEventListener('click', () => {
  if (physics.isSpinning()) {
    physics.stopSpin();
  } else {
    physics.spinUp();
    interactions.onSpin();
  }
  updateSpinButton();
});

spinSlider.addEventListener('input', () => {
  physics.setTargetSpinRate(Number(spinSlider.value));
  spinValue.textContent = `${Math.round(physics.targetSpinRate)} rad/s`;
});

frictionSlider.addEventListener('input', () => {
  physics.params.friction = frictionSliderToValue(Number(frictionSlider.value));
  frictionValue.textContent = formatFrictionLabel(physics.params.friction);
});

resetBtn.addEventListener('click', () => {
  dragging = false;
  controls.enabled = true;
  physics.reset();
  interactions.onPhysicsReset();
  syncSpinUi();
  updateSpinButton();
  updateSpinningTopMesh(topMesh, physics);
});

function resize(): void {
  const { width, height } = canvasFrame.getBoundingClientRect();
  if (width < 1 || height < 1) return;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  updateSpinningTopLineResolution(topMesh, width, height);
}

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(canvasFrame);
window.addEventListener('resize', resize);
resize();

const FIXED_DT = 1 / 120;
let accumulator = 0;
let lastTime = performance.now();

function updateStats(): void {
  const spin = physics.getSpinRate();
  physics.getAngularMomentum(_L);
  physics.getGravityTorque(_tau);
  const precession = physics.getPrecessionRate(gravityCheck.checked);
  const fallen = physics.getTiltDegrees() > 80;
  const status = fallen
    ? 'fallen'
    : physics.isSpinning()
      ? physics.isSideways()
        ? 'sideways'
        : physics.getTiltDegrees() > 2
          ? 'wobbling'
          : 'spinning'
      : 'at rest';

  statsEl.innerHTML = [
    `Status: ${status}`,
    `Spin ω<sub>s</sub>: ${spin.toFixed(1)} rad/s (${(spin / (2 * Math.PI)).toFixed(1)} rev/s)`,
    `|L|: ${_L.length().toFixed(4)} kg·m²/s`,
    `Precession Ω: ${precession.toFixed(3)} rad/s`,
    `Tilt: ${physics.getTiltDegrees().toFixed(1)}° from vertical`,
    physics.hasActiveTrace()
      ? `Path speed: ${physics.getPathSpeed().toFixed(3)} m/s`
      : '',
  ].filter(Boolean).join('<br>');
}

function animate(now: number): void {
  requestAnimationFrame(animate);

  const frameDt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  accumulator += frameDt;

  while (accumulator >= FIXED_DT) {
    if (dragging) {
      physics.stepSpinOnly(FIXED_DT);
    } else {
      physics.step(FIXED_DT, gravityCheck.checked);
    }
    accumulator -= FIXED_DT;
  }

  updateSpinningTopMesh(topMesh, physics);
  physics.getCenterOfMass(_origin);

  if (vectorsCheck.checked) {
    physics.getAngularMomentum(_L);
    physics.getGravityTorque(_tau);
    physics.getSpinAxis(_axis);

    updateVectorArrow(L_ARROW, _origin, _L, 0.07);
    updateVectorArrow(TAU_ARROW, _origin, _tau, 0.2);
    updateVectorArrow(AXIS_ARROW, physics.getTipPosition(_origin), _axis, 0.2);
  } else {
    L_ARROW.visible = false;
    TAU_ARROW.visible = false;
    AXIS_ARROW.visible = false;
  }

  updateStats();
  updateSpinButton();
  interactions.update(frameDt);
  controls.update();
  renderer.render(scene, camera);
}

syncSpinUi();
syncFrictionUi();
updateSpinButton();
animate(performance.now());
