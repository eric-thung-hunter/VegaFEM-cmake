import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.querySelector('#simulation');
const status = document.querySelector('#renderer-status');
const failure = document.querySelector('#failure');
const forceScale = document.querySelector('#force-scale');
const forceValue = document.querySelector('#force-value');
const frameTime = document.querySelector('#frame-time');
const pauseButton = document.querySelector('#pause');
const resetButton = document.querySelector('#reset');

let running = true;
let draggingBridge = false;
let activePointerId = null;

function showFailure(error) {
  console.error(error);
  failure.hidden = false;
  failure.textContent = `Unable to start the Web demo: ${error.message || error}`;
}

async function createRenderer() {
  // WebGPURenderer selects WebGPU where it exists and uses a WebGL2 backend
  // otherwise. If initialisation itself fails, use the established WebGL2
  // renderer directly. This keeps iOS Safari on the supported baseline.
  try {
    const renderer = new WebGPURenderer({ canvas, antialias: !matchMedia('(pointer: coarse)').matches });
    await renderer.init();
    const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback';
    status.textContent = `${backend} renderer · CPU Wasm solver`;
    return renderer;
  } catch (error) {
    console.warn('WebGPU renderer initialisation failed; using WebGL2.', error);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: !matchMedia('(pointer: coarse)').matches });
    status.textContent = 'WebGL2 fallback renderer · CPU Wasm solver';
    return renderer;
  }
}

function createBridge(scene) {
  const geometry = new THREE.PlaneGeometry(5.8, 0.9, 72, 14);
  const positions = geometry.attributes.position;
  const rest = positions.array.slice();
  positions.setUsage(THREE.DynamicDrawUsage);

  const bridge = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x4e97c7, metalness: 0.2, roughness: 0.55, side: THREE.DoubleSide })
  );
  bridge.castShadow = true;
  bridge.receiveShadow = true;
  scene.add(bridge);

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xd0ebfc, transparent: true, opacity: 0.36 })
  );
  bridge.add(wire);

  const supportMaterial = new THREE.MeshStandardMaterial({ color: 0x344553, roughness: 0.8 });
  for (const x of [-2.65, -1.95, 1.95, 2.65]) {
    const support = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.45, 0.32), supportMaterial);
    support.position.set(x, -1.05, 0);
    support.castShadow = true;
    support.receiveShadow = true;
    scene.add(support);
  }

  return { geometry, positions, rest, wire };
}

function applyModalDeformation(bridge, q) {
  const position = bridge.positions.array;
  for (let offset = 0; offset < position.length; offset += 3) {
    const x = bridge.rest[offset];
    const y = bridge.rest[offset + 1];
    const x01 = (x + 2.9) / 5.8;
    const edgeWeight = Math.max(0, 1 - Math.abs(y) / 0.45);
    let vertical = 0;
    let depth = 0;

    for (let mode = 0; mode < q.length; ++mode) {
      const wave = Math.sin((mode % 4 + 1) * Math.PI * x01);
      const width = mode % 3 === 0 ? 1 : Math.cos((mode % 3) * Math.PI * y / 0.9);
      vertical += q[mode] * wave * width * (mode % 2 ? 0.02 : 0.045);
      depth += q[mode] * wave * edgeWeight * (mode % 2 ? 0.038 : 0.012);
    }

    position[offset] = x;
    position[offset + 1] = y + vertical;
    position[offset + 2] = depth;
  }
  bridge.positions.needsUpdate = true;
  bridge.geometry.computeVertexNormals();
  bridge.wire.geometry.dispose();
  bridge.wire.geometry = new THREE.WireframeGeometry(bridge.geometry);
}

async function main() {
  if (!window.WebAssembly) {
    throw new Error('This browser does not provide WebAssembly.');
  }

  const renderer = await createRenderer();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151c);
  scene.fog = new THREE.Fog(0x10151c, 7, 15);

  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 1.1, 7.2);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, -0.1, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 4.5;
  controls.maxDistance = 12;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xc7eaff, 0x24313a, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(3, 5, 4);
  key.castShadow = true;
  scene.add(key);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0x18232c, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.78;
  floor.receiveShadow = true;
  scene.add(floor);

  const bridge = createBridge(scene);
  const wasmImport = await import('./vegafem-web-sim.js');
  const module = await wasmImport.default({
    locateFile: (file) => new URL(file, import.meta.url).href
  });
  const simulation = module._vegafem_web_create();
  const modeCount = module._vegafem_web_mode_count();
  const statePointer = module._vegafem_web_modal_state(simulation);
  const q = module.HEAPF64.subarray(statePointer >> 3, (statePointer >> 3) + modeCount);

  forceScale.addEventListener('input', () => { forceValue.value = forceScale.value; });
  pauseButton.addEventListener('click', () => {
    running = !running;
    pauseButton.textContent = running ? 'Pause' : 'Resume';
    module._vegafem_web_set_force(simulation, 0);
  });
  resetButton.addEventListener('click', () => module._vegafem_web_reset(simulation));

  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' && event.isPrimary === false) return;
    draggingBridge = true;
    activePointerId = event.pointerId;
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!draggingBridge || event.pointerId !== activePointerId) return;
    const bounds = canvas.getBoundingClientRect();
    const normalizedX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
    module._vegafem_web_set_force(simulation, normalizedX * Number(forceScale.value));
  });
  function releasePointer(event) {
    if (event.pointerId !== activePointerId) return;
    draggingBridge = false;
    activePointerId = null;
    controls.enabled = true;
    module._vegafem_web_set_force(simulation, 0);
  }
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  let previousTime = performance.now();
  renderer.setAnimationLoop((now) => {
    const deltaSeconds = Math.min((now - previousTime) / 1000, 0.05);
    previousTime = now;
    if (running) module._vegafem_web_step(simulation, deltaSeconds);
    applyModalDeformation(bridge, q);
    controls.update();
    renderer.render(scene, camera);
    frameTime.textContent = `${(deltaSeconds * 1000).toFixed(1)} ms`;
  });
}

main().catch(showFailure);
