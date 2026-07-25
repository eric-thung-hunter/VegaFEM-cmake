# Modernization TODO

- [ ] Keep Windows as a first-class supported platform throughout the modernization.
  - Build with MSVC and CMake presets (at minimum x64 Debug and Release).
  - Keep the new GUI and rendering paths portable; target OpenGL 3.3 Core on Intel, AMD, and NVIDIA drivers rather than vendor-specific APIs.
  - Add Windows CI once the modern CMake build is in place.
  - Avoid POSIX-only assumptions in core, threading, filesystem, and build code.

