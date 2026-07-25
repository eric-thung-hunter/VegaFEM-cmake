# VegaFEM Web reduced-dynamics demo

This directory contains the browser front end for VegaFEM. It is deliberately
separate from the GLUT/ImGui native demo:

* `webBridge.cpp` exposes a small C ABI whose payload is the reduced modal
  state `q`.
* `app.js` owns the Three.js scene, input and rendering.
* Three's `WebGPURenderer` prefers WebGPU where available and uses a WebGL2
  backend when it is not. A direct `WebGLRenderer` fallback is retained if
  renderer initialisation itself fails.

The current bridge is a deterministic 20-mode development kernel. It proves
the build, input, frame-loop and renderer boundary without coupling the web
application to GLUT, Cg or native OpenGL. The next porting step is recorded in
`todo.md`: load the production reduced-StVK data and replace its analytical
mode shapes with the actual rendering modal matrix.

## Build

Install and activate an Emscripten SDK, then run:

```sh
emcmake cmake -S . -B build-web -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DVegaFEM_BUILD_WEB_DEMO=ON \
  -DVegaFEM_BUILD_MODEL_REDUCTION=OFF \
  -DVegaFEM_ENABLE_OpenGL_SUPPORT=OFF \
  -DVegaFEM_ENABLE_PTHREADS_SUPPORT=OFF
cmake --build build-web --target vegafem_web_demo --parallel
```

The self-contained deployable bundle is in `build-web/web`. The build pins the
Three.js browser modules by SHA-256 and ships them in that directory, so a
deployment does not rely on a CDN.

Serve the directory through HTTP(S); opening `index.html` from the filesystem
will not allow the browser to fetch the `.wasm` module. Configure the server to
send `.wasm` as `application/wasm` for streaming compilation.

## iOS Safari baseline

The compatibility contract is intentionally conservative:

* WebAssembly plus WebGL2 is the required rendering baseline.
* The shipped solver has no pthreads, `SharedArrayBuffer`, COOP/COEP headers,
  or WebGPU requirement.
* One-finger dragging applies force; two-finger interaction remains available
  for the Three.js orbit controls. The canvas disables browser gesture handling
  only while interacting with the simulation.
* The pixel ratio is capped at 2 and Wasm memory is fixed at 32 MiB to keep
  mobile memory/bandwidth predictable.

Desktop builds may later add a separate SIMD/pthread artifact. It must remain
an enhancement: do feature detection at the deployment layer and always ship
this baseline artifact for Safari and other browsers without shared-memory
threads.
