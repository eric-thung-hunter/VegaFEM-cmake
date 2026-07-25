import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.querySelector('#simulation');
const status = document.querySelector('#renderer-status');
const failure = document.querySelector('#failure');
const frameTime = document.querySelector('#frame-time');
const pauseButton = document.querySelector('#pause');
const resetButton = document.querySelector('#reset');
const resetCameraButton = document.querySelector('#reset-camera');
const panel = document.querySelector('.panel');
const hidePanelButton = document.querySelector('#hide-panel');
const showPanelButton = document.querySelector('#show-panel');
const pullStatus = document.querySelector('#pull-status');
const compliance = document.querySelector('#compliance');
const complianceValue = document.querySelector('#compliance-value');
const frequency = document.querySelector('#frequency');
const frequencyValue = document.querySelector('#frequency-value');
const massDamping = document.querySelector('#mass-damping');
const massDampingValue = document.querySelector('#mass-damping-value');
const stiffnessDamping = document.querySelector('#stiffness-damping');
const stiffnessDampingValue = document.querySelector('#stiffness-damping-value');
const linearModel = document.querySelector('#linear-model');
const staticOnly = document.querySelector('#static-only');
const wireframe = document.querySelector('#wireframe');
const forceMarker = document.querySelector('#force-marker');

let running = true;
let draggingBridge = false;
let activePointerId = null;
let pulledVertex = -1;
const dragStart = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const worldForce = new THREE.Vector3();

function supportsWasmSimd() {
  // i8x16.splat is a minimal feature probe; validate capabilities instead of
  // guessing from an iOS/Safari user-agent string.
  const probe = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x1a, 0x0b
  ]);
  return WebAssembly.validate(probe);
}

function showFailure(error) {
  console.error(error);
  failure.hidden = false;
  failure.textContent = `Unable to start the Web demo: ${error.message || error}`;
}

async function createRenderer() {
  // Three chooses WebGPU where it exists and its WebGL2 backend otherwise. A
  // direct WebGL renderer is retained for devices where renderer setup fails.
  try {
    const renderer = new WebGPURenderer({ canvas, antialias: !matchMedia('(pointer: coarse)').matches });
    await renderer.init();
    const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback';
    status.textContent = `${backend} renderer · CPU Wasm solver`;
    return renderer;
  } catch (error) {
    console.warn('WebGPU renderer initialisation failed; using WebGL.', error);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: !matchMedia('(pointer: coarse)').matches });
    status.textContent = 'WebGL2 fallback renderer · CPU Wasm solver';
    return renderer;
  }
}

function parseObjMesh(text) {
  const vertices = [];
  const indices = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      vertices.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const face = parts.slice(1).map((entry) => {
        const rawIndex = Number(entry.split('/')[0]);
        return rawIndex < 0 ? vertices.length / 3 + rawIndex : rawIndex - 1;
      });
      for (let index = 1; index + 1 < face.length; ++index) indices.push(face[0], face[index], face[index + 1]);
    }
  }
  if (vertices.length === 0 || indices.length === 0) throw new Error('Bridge OBJ contains no renderable geometry.');

  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.Float32BufferAttribute(vertices, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, positions, rest: positions.array.slice() };
}

async function loadBridgeAssets() {
  const [objResponse, modesResponse, cubicResponse] = await Promise.all([
    fetch('./assets/simpleBridge.obj'),
    fetch('./assets/simpleBridge.URendering.float'),
    fetch('./assets/simpleBridge.cub')
  ]);
  if (!objResponse.ok || !modesResponse.ok || !cubicResponse.ok) throw new Error('Unable to fetch the simpleBridge simulation assets.');

  const bridge = parseObjMesh(await objResponse.text());
  const buffer = await modesResponse.arrayBuffer();
  if (buffer.byteLength < 8) throw new Error('The modal matrix file is truncated.');
  const header = new DataView(buffer);
  const rows = header.getInt32(0, true);
  const modes = header.getInt32(4, true);
  const expectedBytes = 8 + rows * modes * Float32Array.BYTES_PER_ELEMENT;
  if (rows !== bridge.rest.length || expectedBytes !== buffer.byteLength) {
    throw new Error(`Modal matrix dimensions (${rows} × ${modes}) do not match the Bridge mesh.`);
  }
  return {
    ...bridge,
    rows,
    modes,
    basis: new Float32Array(buffer, 8, rows * modes),
    cubicPolynomial: await cubicResponse.arrayBuffer()
  };
}

function createBridge(scene, data) {
  const mesh = new THREE.Mesh(
    data.geometry,
    new THREE.MeshStandardMaterial({ color: 0x4e97c7, metalness: 0.2, roughness: 0.55, side: THREE.DoubleSide })
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const edges = new THREE.Mesh(
    data.geometry,
    new THREE.MeshBasicMaterial({ color: 0xd0ebfc, wireframe: true, transparent: true, opacity: 0.18 })
  );
  mesh.add(edges);
  scene.add(mesh);
  return { ...data, mesh, edges };
}

function applyModalDeformation(bridge, displacement, updateNormals) {
  const positions = bridge.positions.array;
  for (let offset = 0; offset < positions.length; ++offset) positions[offset] = bridge.rest[offset] + displacement[offset];
  bridge.positions.needsUpdate = true;
  if (updateNormals) bridge.geometry.computeVertexNormals();
}

function closestHitVertex(bridge, hit) {
  const index = bridge.geometry.index;
  if (!index || hit.faceIndex === undefined) return 0;
  const offset = hit.faceIndex * 3;
  const candidates = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
  const position = bridge.positions;
  let result = candidates[0];
  let distance = Infinity;
  for (const candidate of candidates) {
    const dx = position.getX(candidate) - hit.point.x;
    const dy = position.getY(candidate) - hit.point.y;
    const dz = position.getZ(candidate) - hit.point.z;
    const candidateDistance = dx * dx + dy * dy + dz * dz;
    if (candidateDistance < distance) {
      result = candidate;
      distance = candidateDistance;
    }
  }
  return result;
}

function pickBridgeVertex(event, camera, bridge) {
  const bounds = canvas.getBoundingClientRect();
  pointer.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(bridge.mesh, false)[0];
  return hit ? closestHitVertex(bridge, hit) : -1;
}

async function main() {
  if (!window.WebAssembly) throw new Error('This browser does not provide WebAssembly.');

  const renderer = await createRenderer();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151c);
  scene.fog = new THREE.Fog(0x10151c, 19, 45);

  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 6.2, 24.8);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.2, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 12;
  controls.maxDistance = 38;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xc7eaff, 0x24313a, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(3, 8, 7);
  key.castShadow = true;
  scene.add(key);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x18232c, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.08;
  floor.receiveShadow = true;
  scene.add(floor);

  status.textContent = 'Loading reduced Bridge assets…';
  const bridge = createBridge(scene, await loadBridgeAssets());
  const simd = supportsWasmSimd();
  const wasmImport = await import(simd ? './vegafem-web-sim-simd.js' : './vegafem-web-sim.js');
  const module = await wasmImport.default({ locateFile: (file) => new URL(file, import.meta.url).href });
  const simulation = module._vegafem_web_create();
  const modeCount = module._vegafem_web_mode_count();
  if (bridge.modes !== modeCount) throw new Error(`Bridge requires ${bridge.modes} modes, but the solver exports ${modeCount}.`);

  const basisPointer = module._malloc(bridge.basis.byteLength);
  module.HEAPF32.set(bridge.basis, basisPointer >> 2);
  const basisStatus = module._vegafem_web_set_modal_basis(simulation, basisPointer, bridge.rows, bridge.modes);
  module._free(basisPointer);
  if (basisStatus !== 0) throw new Error('The WebAssembly solver rejected the Bridge modal matrix.');

  const polynomialPointer = module._malloc(bridge.cubicPolynomial.byteLength);
  module.HEAPU8.set(new Uint8Array(bridge.cubicPolynomial), polynomialPointer);
  const polynomialStatus = module._vegafem_web_set_stvk_cubic_polynomial(simulation, polynomialPointer, bridge.cubicPolynomial.byteLength);
  module._free(polynomialPointer);
  if (polynomialStatus !== 0) throw new Error('The WebAssembly solver rejected the Bridge StVK polynomial.');

  const displacementPointer = module._vegafem_web_deformed_positions(simulation);
  if (!displacementPointer) throw new Error('The WebAssembly solver could not assemble Bridge displacements.');
  const displacement = module.HEAPF32.subarray(displacementPointer >> 2, (displacementPointer >> 2) + bridge.rows);
  status.textContent = `${renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'} renderer · ${simd ? 'SIMD' : 'baseline'} Wasm solver`;

  const parameter = (id, output, parameterIndex, formatter) => {
    const input = document.querySelector(id);
    const update = () => {
      output.value = formatter(Number(input.value));
      module._vegafem_web_set_parameter(simulation, parameterIndex, Number(input.value));
    };
    input.addEventListener('input', update);
    update();
  };
  parameter('#compliance', complianceValue, 0, (value) => value.toFixed(0));
  parameter('#frequency', frequencyValue, 1, (value) => value.toFixed(2));
  parameter('#mass-damping', massDampingValue, 2, (value) => value.toFixed(3));
  parameter('#stiffness-damping', stiffnessDampingValue, 3, (value) => value.toFixed(3));
  linearModel.addEventListener('change', () => module._vegafem_web_set_parameter(simulation, 4, linearModel.checked ? 1 : 0));
  staticOnly.addEventListener('change', () => module._vegafem_web_set_parameter(simulation, 5, staticOnly.checked ? 1 : 0));
  wireframe.addEventListener('change', () => { bridge.edges.visible = wireframe.checked; });

  const pulledMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 18, 12),
    new THREE.MeshBasicMaterial({ color: 0x77ff94 })
  );
  const pullArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.1, 0xffd15c, 0.25, 0.14);
  pulledMarker.visible = false;
  pullArrow.visible = false;
  scene.add(pulledMarker, pullArrow);
  const clearPull = () => {
    draggingBridge = false;
    activePointerId = null;
    pulledVertex = -1;
    controls.enabled = true;
    module._vegafem_web_clear_pull(simulation);
    pulledMarker.visible = false;
    pullArrow.visible = false;
    pullStatus.textContent = 'Pick a bridge member to apply force';
  };

  pauseButton.addEventListener('click', () => {
    running = !running;
    pauseButton.textContent = running ? 'Pause' : 'Resume';
    clearPull();
  });
  resetButton.addEventListener('click', () => { module._vegafem_web_reset(simulation); clearPull(); });
  resetCameraButton.addEventListener('click', () => {
    camera.position.set(0, 6.2, 24.8);
    controls.target.set(0, 1.2, 0);
    controls.update();
  });
  hidePanelButton.addEventListener('click', () => { panel.hidden = true; showPanelButton.hidden = false; });
  showPanelButton.addEventListener('click', () => { panel.hidden = false; showPanelButton.hidden = true; });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' && event.isPrimary === false) return;
    const vertex = pickBridgeVertex(event, camera, bridge);
    if (vertex < 0) return;
    draggingBridge = true;
    activePointerId = event.pointerId;
    pulledVertex = vertex;
    dragStart.set(event.clientX, event.clientY);
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
    const vertexPosition = new THREE.Vector3().fromBufferAttribute(bridge.positions, vertex);
    bridge.mesh.localToWorld(vertexPosition);
    pulledMarker.position.copy(vertexPosition);
    pulledMarker.visible = forceMarker.checked;
    pullStatus.textContent = `Pulling vertex ${vertex}`;
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!draggingBridge || event.pointerId !== activePointerId) return;
    const forceX = event.clientX - dragStart.x;
    const forceY = dragStart.y - event.clientY;
    const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    worldForce.copy(cameraRight).multiplyScalar(forceX).addScaledVector(cameraUp, forceY);
    module._vegafem_web_set_pull(simulation, pulledVertex, worldForce.x, worldForce.y, worldForce.z);
    const magnitude = worldForce.length();
    if (magnitude > 0.1) {
      pullArrow.position.copy(pulledMarker.position);
      pullArrow.setDirection(worldForce.clone().normalize());
      pullArrow.setLength(Math.min(3.0, 0.018 * magnitude), 0.25, 0.14);
      pullArrow.visible = forceMarker.checked;
    }
    pullStatus.textContent = `Pulling vertex ${pulledVertex} · ${magnitude.toFixed(0)} px`;
  });
  function releasePointer(event) {
    if (event.pointerId !== activePointerId) return;
    clearPull();
  }
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  let previousTime = performance.now();
  let frame = 0;
  renderer.setAnimationLoop((now) => {
    const deltaSeconds = Math.max(0, Math.min((now - previousTime) / 1000, 0.05));
    previousTime = now;
    if (running) module._vegafem_web_step(simulation, deltaSeconds);
    module._vegafem_web_deformed_positions(simulation);
    applyModalDeformation(bridge, displacement, (++frame % 2) === 0);
    controls.update();
    renderer.render(scene, camera);
    frameTime.textContent = `${(deltaSeconds * 1000).toFixed(1)} ms`;
  });
}

main().catch(showFailure);
