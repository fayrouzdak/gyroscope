import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SpinningTopPhysics } from './physics/SpinningTopPhysics';
import {
  createSpinningTopMesh,
  createGround,
  createTable,
  createVectorArrow,
  updateSpinningTopMesh,
  updateSpinningTopLineResolution,
  updateVectorArrow,
} from './scene/GyroscopeScene';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const statsEl = document.getElementById('stats')!;
const spinBtn = document.getElementById('spin') as HTMLButtonElement;
const spinSlider = document.getElementById('spin-speed') as HTMLInputElement;
const spinValue = document.getElementById('spin-value')!;
const gravityCheck = document.getElementById('gravity') as HTMLInputElement;
const vectorsCheck = document.getElementById('vectors') as HTMLInputElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12151c);

const camera = new THREE.PerspectiveCamera(
  40,
  window.innerWidth / window.innerHeight,
  0.01,
  30,
);
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

scene.add(new THREE.AmbientLight(0x505870, 0.55));

const keyLight = new THREE.DirectionalLight(0xfff8f0, 1.8);
keyLight.position.set(1.2, 2, 1.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x8090b0, 0.55);
fillLight.position.set(-1.5, 0.6, -0.8);
scene.add(fillLight);

scene.add(createTable());
scene.add(createGround());

const physics = new SpinningTopPhysics();
const topMesh = createSpinningTopMesh();
scene.add(topMesh);

const L_ARROW = createVectorArrow(0x4ecdc4, 0.25);
const TAU_ARROW = createVectorArrow(0xff6b6b, 0.25);
const AXIS_ARROW = createVectorArrow(0xd8dde6, 0.2);
scene.add(L_ARROW, TAU_ARROW, AXIS_ARROW);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const _origin = new THREE.Vector3();
const _L = new THREE.Vector3();
const _tau = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dragPrev = new THREE.Vector2();

let dragging = false;
let hovered = false;

function setPointerFromEvent(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function hitTop(): boolean {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(topMesh, true).length > 0;
}

function syncSpinUi(): void {
  spinSlider.value = String(Math.round(physics.targetSpinRate));
  spinValue.textContent = `${Math.round(physics.targetSpinRate)} rad/s`;
}

canvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 2) return;
  setPointerFromEvent(e);
  hovered = hitTop();
  canvas.style.cursor = dragging ? 'grabbing' : hovered ? 'grab' : 'default';

  if (dragging) {
    const dx = e.clientX - _dragPrev.x;
    const dy = e.clientY - _dragPrev.y;
    _dragPrev.set(e.clientX, e.clientY);
    physics.applyDrag(-dx * 0.004, dy * 0.003);
  }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  setPointerFromEvent(e);
  if (hitTop()) {
    dragging = true;
    _dragPrev.set(e.clientX, e.clientY);
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  dragging = false;
  controls.enabled = true;
  canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('pointerleave', () => {
  dragging = false;
  controls.enabled = true;
});

spinBtn.addEventListener('click', () => {
  physics.spinUp();
});

spinSlider.addEventListener('input', () => {
  physics.targetSpinRate = Number(spinSlider.value);
  spinValue.textContent = `${Math.round(physics.targetSpinRate)} rad/s`;
});

resetBtn.addEventListener('click', () => {
  physics.reset();
  syncSpinUi();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateSpinningTopLineResolution(topMesh, window.innerWidth, window.innerHeight);
});

const FIXED_DT = 1 / 120;
let accumulator = 0;
let lastTime = performance.now();

function updateStats(): void {
  const spin = physics.getSpinRate();
  physics.getAngularMomentum(_L);
  physics.getGravityTorque(_tau);
  const precession = physics.getPrecessionRate(gravityCheck.checked);
  const status = physics.isSpinning() ? 'spinning' : 'at rest';

  statsEl.innerHTML = [
    `Status: ${status}`,
    `Spin ω<sub>s</sub>: ${spin.toFixed(1)} rad/s (${(spin / (2 * Math.PI)).toFixed(1)} rev/s)`,
    `|L|: ${_L.length().toFixed(4)} kg·m²/s`,
    `Precession Ω: ${precession.toFixed(3)} rad/s`,
    `Tilt: ${physics.getTiltDegrees().toFixed(1)}° from vertical`,
  ].join('<br>');
}

function animate(now: number): void {
  requestAnimationFrame(animate);

  const frameDt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  accumulator += frameDt;

  while (accumulator >= FIXED_DT) {
    physics.step(FIXED_DT, gravityCheck.checked);
    accumulator -= FIXED_DT;
  }

  updateSpinningTopMesh(topMesh, physics);
  physics.getCenterOfMass(_origin);

  if (vectorsCheck.checked) {
    physics.getAngularMomentum(_L);
    physics.getGravityTorque(_tau);
    physics.getSpinAxis(_axis);

    updateVectorArrow(L_ARROW, _origin, _L, 0.12);
    updateVectorArrow(TAU_ARROW, _origin, _tau, 0.35);
    updateVectorArrow(AXIS_ARROW, physics.getTipPosition(_origin), _axis, 0.22);
  } else {
    L_ARROW.visible = false;
    TAU_ARROW.visible = false;
    AXIS_ARROW.visible = false;
  }

  updateStats();
  controls.update();
  renderer.render(scene, camera);
}

syncSpinUi();
animate(performance.now());
