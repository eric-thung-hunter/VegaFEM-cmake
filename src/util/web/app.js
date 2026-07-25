// Framework-free WebGL2 host for VegaFEM's WebAssembly reduced solver.
// Rendering, picking and orbiting are deliberately kept here instead of in a
// scene library so the demo has no JavaScript engine dependency.

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
const complianceValue = document.querySelector('#compliance-value');
const frequencyValue = document.querySelector('#frequency-value');
const massDampingValue = document.querySelector('#mass-damping-value');
const stiffnessDampingValue = document.querySelector('#stiffness-damping-value');
const linearModel = document.querySelector('#linear-model');
const staticOnly = document.querySelector('#static-only');
const wireframe = document.querySelector('#wireframe');
const forceMarker = document.querySelector('#force-marker');

let running = true;

// These are the original simpleBridge.config camera values, converted to the
// yaw/pitch convention used below. Keeping the same local frame also makes a
// pixel drag map to the same camera-oriented force as the desktop demo.
const camera = { yaw: 217 * Math.PI / 180, pitch: 30 * Math.PI / 180, distance: 24.844047, target: [-0.140183, 0.608348, -0.015778] };
const drag = { mode: '', pointerId: null, startX: 0, startY: 0, vertex: -1, force: [0, 0, 0] };

function supportsWasmSimd() {
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

function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, amount) { return [a[0] * amount, a[1] * amount, a[2] * amount]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function length(a) { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a) { const size = length(a) || 1; return scale(a, 1 / size); }

function perspective(out, fov, aspect, near, far) {
  const f = 1 / Math.tan(fov * 0.5);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}

function lookAt(out, eye, target, up) {
  const z = normalize(subtract(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  out.set([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
}

function cameraFrame(aspect) {
  const cp = Math.cos(camera.pitch);
  const eye = add(camera.target, [
    camera.distance * cp * Math.sin(camera.yaw),
    camera.distance * Math.sin(camera.pitch),
    camera.distance * cp * Math.cos(camera.yaw)
  ]);
  const forward = normalize(subtract(camera.target, eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const view = new Float32Array(16);
  const projection = new Float32Array(16);
  lookAt(view, eye, camera.target, up);
  perspective(projection, 42 * Math.PI / 180, aspect, 0.1, 100);
  return { eye, forward, right, up, view, projection };
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed.');
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL program link failed.');
  return program;
}

function createRenderer() {
  const gl = canvas.getContext('webgl2', { antialias: !matchMedia('(pointer: coarse)').matches, depth: true, alpha: false });
  if (!gl) throw new Error('WebGL2 is required by the raw renderer.');
  const surface = createProgram(gl,
    `#version 300 es
    in vec3 aPosition; in vec3 aNormal;
    uniform mat4 uView; uniform mat4 uProjection;
    out float vLight;
    void main() {
      vec3 normal = normalize(aNormal);
      vec3 light = normalize(vec3(0.35, 0.82, 0.58));
      vLight = 0.24 + 0.76 * max(dot(normal, light), 0.0);
      gl_Position = uProjection * uView * vec4(aPosition, 1.0);
    }`,
    `#version 300 es
    precision highp float;
    in float vLight; out vec4 color;
    void main() { color = vec4(vec3(0.18, 0.52, 0.73) * vLight, 1.0); }`);
  const helper = createProgram(gl,
    `#version 300 es
    in vec3 aPosition; uniform mat4 uView; uniform mat4 uProjection; uniform float uPointSize;
    void main() { gl_Position = uProjection * uView * vec4(aPosition, 1.0); gl_PointSize = uPointSize; }`,
    `#version 300 es
    precision highp float; uniform vec4 uColor; out vec4 color;
    void main() { color = uColor; }`);
  return { gl, surface, helper, position: gl.createBuffer(), normal: gl.createBuffer(), triangleIndex: gl.createBuffer(), edgeIndex: gl.createBuffer(), helperPosition: gl.createBuffer() };
}

function parseObjMesh(text) {
  const vertices = [];
  const triangles = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) vertices.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    if (parts[0] === 'f' && parts.length >= 4) {
      const face = parts.slice(1).map((entry) => {
        const rawIndex = Number(entry.split('/')[0]);
        return rawIndex < 0 ? vertices.length / 3 + rawIndex : rawIndex - 1;
      });
      for (let index = 1; index + 1 < face.length; ++index) triangles.push(face[0], face[index], face[index + 1]);
    }
  }
  if (!vertices.length || !triangles.length) throw new Error('Bridge OBJ contains no renderable geometry.');
  return { positions: new Float32Array(vertices), rest: new Float32Array(vertices), indices: new Uint32Array(triangles) };
}

function computeNormals(positions, indices, normals) {
  normals.fill(0);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3, b = indices[offset + 1] * 3, c = indices[offset + 2] * 3;
    const ab = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const ac = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const n = cross(ab, ac);
    for (const vertex of [a, b, c]) { normals[vertex] += n[0]; normals[vertex + 1] += n[1]; normals[vertex + 2] += n[2]; }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const n = normalize([normals[offset], normals[offset + 1], normals[offset + 2]]);
    normals[offset] = n[0]; normals[offset + 1] = n[1]; normals[offset + 2] = n[2];
  }
}

function makeEdges(indices) {
  const edges = new Uint32Array(indices.length * 2);
  let output = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2];
    edges.set([a, b, b, c, c, a], output); output += 6;
  }
  return edges;
}

async function loadBridgeAssets() {
  const [objResponse, modesResponse, cubicResponse] = await Promise.all([
    fetch('./assets/simpleBridge.obj'), fetch('./assets/simpleBridge.URendering.float'), fetch('./assets/simpleBridge.cub')
  ]);
  if (!objResponse.ok || !modesResponse.ok || !cubicResponse.ok) throw new Error('Unable to fetch the simpleBridge simulation assets.');
  const bridge = parseObjMesh(await objResponse.text());
  const buffer = await modesResponse.arrayBuffer();
  if (buffer.byteLength < 8) throw new Error('The modal matrix file is truncated.');
  const header = new DataView(buffer), rows = header.getInt32(0, true), modes = header.getInt32(4, true);
  if (rows !== bridge.rest.length || 8 + rows * modes * Float32Array.BYTES_PER_ELEMENT !== buffer.byteLength) throw new Error('Bridge modal matrix dimensions do not match its mesh.');
  return { ...bridge, rows, modes, normals: new Float32Array(rows), basis: new Float32Array(buffer, 8, rows * modes), cubicPolynomial: await cubicResponse.arrayBuffer() };
}

function uploadBridge(renderer, bridge) {
  const { gl } = renderer;
  bridge.edges = makeEdges(bridge.indices);
  computeNormals(bridge.positions, bridge.indices, bridge.normals);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.position); gl.bufferData(gl.ARRAY_BUFFER, bridge.positions, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.normal); gl.bufferData(gl.ARRAY_BUFFER, bridge.normals, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.triangleIndex); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bridge.indices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.edgeIndex); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bridge.edges, gl.STATIC_DRAW);
}

function resizeCanvas(renderer) {
  const width = Math.floor(innerWidth * Math.min(devicePixelRatio || 1, 2));
  const height = Math.floor(innerHeight * Math.min(devicePixelRatio || 1, 2));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  renderer.gl.viewport(0, 0, canvas.width, canvas.height);
}

function bindMatrixUniforms(gl, program, frame) {
  gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uView'), false, frame.view);
  gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uProjection'), false, frame.projection);
}

function drawHelpers(renderer, bridge, frame) {
  if (drag.mode !== 'pull' || !forceMarker.checked || drag.vertex < 0) return;
  const { gl, helper, helperPosition } = renderer;
  const offset = drag.vertex * 3;
  const base = [bridge.positions[offset], bridge.positions[offset + 1], bridge.positions[offset + 2]];
  const forceLength = length(drag.force);
  const direction = forceLength ? scale(drag.force, 1 / forceLength) : [1, 0, 0];
  const tip = add(base, scale(direction, Math.min(3.0, forceLength * 0.018)));
  const side = scale(frame.right, 0.25);
  const wingA = add(tip, add(scale(direction, -0.35), side));
  const wingB = add(tip, subtract(scale(direction, -0.35), side));
  const lines = new Float32Array([...base, ...tip, ...tip, ...wingA, ...tip, ...wingB]);
  gl.useProgram(helper); bindMatrixUniforms(gl, helper, frame);
  gl.bindBuffer(gl.ARRAY_BUFFER, helperPosition); gl.bufferData(gl.ARRAY_BUFFER, lines, gl.DYNAMIC_DRAW);
  const position = gl.getAttribLocation(helper, 'aPosition'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
  gl.uniform4f(gl.getUniformLocation(helper, 'uColor'), 1.0, 0.82, 0.32, 1.0); gl.uniform1f(gl.getUniformLocation(helper, 'uPointSize'), 1.0); gl.drawArrays(gl.LINES, 0, 6);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(base), gl.DYNAMIC_DRAW);
  gl.uniform4f(gl.getUniformLocation(helper, 'uColor'), 0.45, 1.0, 0.58, 1.0); gl.uniform1f(gl.getUniformLocation(helper, 'uPointSize'), 10.0); gl.drawArrays(gl.POINTS, 0, 1);
}

function render(renderer, bridge) {
  resizeCanvas(renderer);
  const { gl, surface, helper, position, normal, triangleIndex, edgeIndex } = renderer;
  const frame = cameraFrame(canvas.width / canvas.height);
  gl.enable(gl.DEPTH_TEST); gl.clearColor(0.063, 0.082, 0.11, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(surface); bindMatrixUniforms(gl, surface, frame);
  const positionLocation = gl.getAttribLocation(surface, 'aPosition'); gl.bindBuffer(gl.ARRAY_BUFFER, position); gl.enableVertexAttribArray(positionLocation); gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
  const normalLocation = gl.getAttribLocation(surface, 'aNormal'); gl.bindBuffer(gl.ARRAY_BUFFER, normal); gl.enableVertexAttribArray(normalLocation); gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triangleIndex); gl.drawElements(gl.TRIANGLES, bridge.indices.length, gl.UNSIGNED_INT, 0);
  if (wireframe.checked) {
    gl.useProgram(helper); bindMatrixUniforms(gl, helper, frame); gl.bindBuffer(gl.ARRAY_BUFFER, position);
    const linePosition = gl.getAttribLocation(helper, 'aPosition'); gl.enableVertexAttribArray(linePosition); gl.vertexAttribPointer(linePosition, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4f(gl.getUniformLocation(helper, 'uColor'), 0.78, 0.92, 1.0, 0.22); gl.uniform1f(gl.getUniformLocation(helper, 'uPointSize'), 1.0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeIndex); gl.drawElements(gl.LINES, bridge.edges.length, gl.UNSIGNED_INT, 0);
  }
  drawHelpers(renderer, bridge, frame);
  return frame;
}

function screenRay(event, frame) {
  const bounds = canvas.getBoundingClientRect();
  const x = ((event.clientX - bounds.left) / bounds.width * 2 - 1) * Math.tan(42 * Math.PI / 360) * (bounds.width / bounds.height);
  const y = (1 - (event.clientY - bounds.top) / bounds.height * 2) * Math.tan(42 * Math.PI / 360);
  return { origin: frame.eye, direction: normalize(add(frame.forward, add(scale(frame.right, x), scale(frame.up, y)))) };
}

function pickBridgeVertex(event, bridge, frame) {
  const ray = screenRay(event, frame);
  let closest = Infinity, picked = -1;
  for (let index = 0; index < bridge.indices.length; index += 3) {
    const ai = bridge.indices[index] * 3, bi = bridge.indices[index + 1] * 3, ci = bridge.indices[index + 2] * 3;
    const a = [bridge.positions[ai], bridge.positions[ai + 1], bridge.positions[ai + 2]];
    const edge1 = [bridge.positions[bi] - a[0], bridge.positions[bi + 1] - a[1], bridge.positions[bi + 2] - a[2]];
    const edge2 = [bridge.positions[ci] - a[0], bridge.positions[ci + 1] - a[1], bridge.positions[ci + 2] - a[2]];
    const p = cross(ray.direction, edge2), determinant = dot(edge1, p);
    if (Math.abs(determinant) < 1e-8) continue;
    const inverse = 1 / determinant, s = subtract(ray.origin, a), u = dot(s, p) * inverse;
    if (u < 0 || u > 1) continue;
    const q = cross(s, edge1), v = dot(ray.direction, q) * inverse;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(edge2, q) * inverse;
    if (distance <= 0 || distance >= closest) continue;
    closest = distance;
    const point = add(ray.origin, scale(ray.direction, distance));
    const candidates = [bridge.indices[index], bridge.indices[index + 1], bridge.indices[index + 2]];
    picked = candidates.reduce((best, candidate) => {
      const offset = candidate * 3, bestOffset = best * 3;
      const currentDistance = (bridge.positions[offset] - point[0]) ** 2 + (bridge.positions[offset + 1] - point[1]) ** 2 + (bridge.positions[offset + 2] - point[2]) ** 2;
      const bestDistance = (bridge.positions[bestOffset] - point[0]) ** 2 + (bridge.positions[bestOffset + 1] - point[1]) ** 2 + (bridge.positions[bestOffset + 2] - point[2]) ** 2;
      return currentDistance < bestDistance ? candidate : best;
    }, candidates[0]);
  }
  if (picked >= 0) return picked;

  // The bridge is a truss with plenty of screen-space gaps. A web demo must
  // not make the pull depend on landing on a sub-pixel triangle: any primary
  // drag on the simulation canvas targets the closest Bridge vertex. Camera
  // orbiting remains available through right-drag and the wheel.
  let nearestVertex = -1;
  let nearestDistanceSquared = Infinity;
  for (let vertex = 0; vertex < bridge.positions.length; vertex += 3) {
    const point = [bridge.positions[vertex], bridge.positions[vertex + 1], bridge.positions[vertex + 2]];
    const alongRay = dot(subtract(point, ray.origin), ray.direction);
    if (alongRay <= 0) continue;
    const separation = subtract(point, add(ray.origin, scale(ray.direction, alongRay)));
    const distanceSquared = dot(separation, separation);
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestVertex = vertex / 3;
    }
  }
  return nearestVertex;
}

async function main() {
  if (!window.WebAssembly) throw new Error('This browser does not provide WebAssembly.');
  const renderer = createRenderer();
  const bridge = await loadBridgeAssets();
  uploadBridge(renderer, bridge);
  const simd = supportsWasmSimd();
  const wasmImport = await import(simd ? './vegafem-web-sim-simd.js' : './vegafem-web-sim.js');
  const module = await wasmImport.default({ locateFile: (file) => new URL(file, import.meta.url).href });
  const simulation = module._vegafem_web_create();
  if (module._vegafem_web_mode_count() !== bridge.modes) throw new Error('Bridge modal count does not match the WebAssembly solver.');
  const basisPointer = module._malloc(bridge.basis.byteLength); module.HEAPF32.set(bridge.basis, basisPointer >> 2);
  if (module._vegafem_web_set_modal_basis(simulation, basisPointer, bridge.rows, bridge.modes) !== 0) throw new Error('The WebAssembly solver rejected the Bridge modal matrix.');
  module._free(basisPointer);
  const polynomialPointer = module._malloc(bridge.cubicPolynomial.byteLength); module.HEAPU8.set(new Uint8Array(bridge.cubicPolynomial), polynomialPointer);
  if (module._vegafem_web_set_stvk_cubic_polynomial(simulation, polynomialPointer, bridge.cubicPolynomial.byteLength) !== 0) throw new Error('The WebAssembly solver rejected the Bridge StVK polynomial.');
  module._free(polynomialPointer);
  const displacementPointer = module._vegafem_web_deformed_positions(simulation);
  if (!displacementPointer) throw new Error('The WebAssembly solver could not assemble Bridge displacements.');
  const displacement = module.HEAPF32.subarray(displacementPointer >> 2, (displacementPointer >> 2) + bridge.rows);
  status.textContent = `Raw WebGL2 renderer · ${simd ? 'SIMD' : 'baseline'} Wasm solver`;

  const parameter = (selector, output, id, formatter) => {
    const input = document.querySelector(selector);
    const update = () => { output.value = formatter(Number(input.value)); module._vegafem_web_set_parameter(simulation, id, Number(input.value)); };
    input.addEventListener('input', update); update();
  };
  parameter('#compliance', complianceValue, 0, (value) => value.toFixed(0));
  parameter('#frequency', frequencyValue, 1, (value) => value.toFixed(2));
  parameter('#mass-damping', massDampingValue, 2, (value) => value.toFixed(3));
  parameter('#stiffness-damping', stiffnessDampingValue, 3, (value) => value.toFixed(3));
  linearModel.addEventListener('change', () => module._vegafem_web_set_parameter(simulation, 4, linearModel.checked ? 1 : 0));
  staticOnly.addEventListener('change', () => module._vegafem_web_set_parameter(simulation, 5, staticOnly.checked ? 1 : 0));
  const clearPull = () => {
    if (drag.mode === 'pull') module._vegafem_web_clear_pull(simulation);
    drag.mode = ''; drag.pointerId = null; drag.vertex = -1; drag.force = [0, 0, 0]; pullStatus.textContent = 'Pick a bridge member to apply force';
  };
  pauseButton.addEventListener('click', () => { running = !running; pauseButton.textContent = running ? 'Pause' : 'Resume'; clearPull(); });
  resetButton.addEventListener('click', () => { module._vegafem_web_reset(simulation); clearPull(); });
  resetCameraButton.addEventListener('click', () => { camera.yaw = 0; camera.pitch = 0.21; camera.distance = 24.8; camera.target = [0, 1.2, 0]; });
  hidePanelButton.addEventListener('click', () => { panel.hidden = true; showPanelButton.hidden = false; });
  showPanelButton.addEventListener('click', () => { panel.hidden = false; showPanelButton.hidden = true; });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    clearPull();
    const frame = cameraFrame(canvas.width / canvas.height);
    drag.pointerId = event.pointerId; drag.startX = event.clientX; drag.startY = event.clientY;
    const vertex = event.button === 0 ? pickBridgeVertex(event, bridge, frame) : -1;
    if (vertex >= 0) { drag.mode = 'pull'; drag.vertex = vertex; pullStatus.textContent = `Pulling vertex ${vertex}`; }
    else drag.mode = 'orbit';
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (drag.mode === 'pull') {
      const frame = cameraFrame(canvas.width / canvas.height);
      const screenForce = add(scale(frame.right, dx), scale(frame.up, -dy));
      // Match reducedDynamicSolver-rt.cpp: transform raw pixel deltas into a
      // camera-oriented world vector, then let the native compliance and
      // implicit Newmark solver determine the response.
      drag.force = screenForce;
      module._vegafem_web_set_pull(simulation, drag.vertex, drag.force[0], drag.force[1], drag.force[2]);
      pullStatus.textContent = `Pulling vertex ${drag.vertex} · ${Math.hypot(dx, dy).toFixed(0)} px`;
    } else if (drag.mode === 'orbit') {
      camera.yaw -= dx * 0.008; camera.pitch = Math.max(-1.35, Math.min(1.35, camera.pitch - dy * 0.008)); drag.startX = event.clientX; drag.startY = event.clientY;
    }
  });
  const release = (event) => { if (event.pointerId === drag.pointerId) clearPull(); };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (event) => { event.preventDefault(); camera.distance = Math.max(12, Math.min(38, camera.distance * Math.exp(event.deltaY * 0.001))); }, { passive: false });
  addEventListener('resize', () => resizeCanvas(renderer));

  let previousTime = performance.now(), frameCount = 0;
  const tick = (now) => {
    const deltaSeconds = Math.max(0, Math.min((now - previousTime) / 1000, 0.05)); previousTime = now;
    if (running) module._vegafem_web_step(simulation, deltaSeconds);
    for (let offset = 0; offset < bridge.positions.length; ++offset) bridge.positions[offset] = bridge.rest[offset] + displacement[offset];
    const { gl } = renderer;
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.position); gl.bufferSubData(gl.ARRAY_BUFFER, 0, bridge.positions);
    if ((++frameCount & 1) === 0) { computeNormals(bridge.positions, bridge.indices, bridge.normals); gl.bindBuffer(gl.ARRAY_BUFFER, renderer.normal); gl.bufferSubData(gl.ARRAY_BUFFER, 0, bridge.normals); }
    render(renderer, bridge); frameTime.textContent = `${(deltaSeconds * 1000).toFixed(1)} ms`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch(showFailure);
