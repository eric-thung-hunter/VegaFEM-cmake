# Modernization TODO

- [ ] Keep Windows as a first-class supported platform throughout the modernization.
  - Build with MSVC and CMake presets (at minimum x64 Debug and Release).
  - Keep the new GUI and rendering paths portable; target OpenGL 3.3 Core on Intel, AMD, and NVIDIA drivers rather than vendor-specific APIs.
  - Add Windows CI once the modern CMake build is in place.
  - Avoid POSIX-only assumptions in core, threading, filesystem, and build code.

- [ ] Complete the browser reduced-StVK asset pipeline.
  - Replace the analytical development bridge modes in `src/util/web` with the
    production `.URendering.float` modal matrix and reduced StVK force data.
  - Keep the default build non-threaded and fixed-memory for iOS Safari.
  - Add a separately deployed SIMD/pthread desktop build only after it is
    benchmarked; never make `SharedArrayBuffer` or COOP/COEP a requirement for
    the Safari/mobile fallback.
  - Benchmark WebGPU deformation/compute separately from the WebGL2 fallback.
