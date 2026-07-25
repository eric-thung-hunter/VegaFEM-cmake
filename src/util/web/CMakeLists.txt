# Browser front end for the reduced-dynamics demo.
#
# This target intentionally stays independent of the legacy OpenGL/GLUT
# application. The native and web front ends can therefore evolve separately
# while sharing the numerical model format in later porting steps.

set(VEGAFEM_WEB_OUTPUT_DIR "${CMAKE_BINARY_DIR}/web")

configure_file(index.html "${VEGAFEM_WEB_OUTPUT_DIR}/index.html" COPYONLY)
configure_file(app.js "${VEGAFEM_WEB_OUTPUT_DIR}/app.js" COPYONLY)
configure_file(style.css "${VEGAFEM_WEB_OUTPUT_DIR}/style.css" COPYONLY)
file(MAKE_DIRECTORY "${VEGAFEM_WEB_OUTPUT_DIR}/assets")
file(COPY
  "${CMAKE_CURRENT_SOURCE_DIR}/../reducedDynamicSolver-rt/realtime/simpleBridge/simpleBridge.obj"
  "${CMAKE_CURRENT_SOURCE_DIR}/../reducedDynamicSolver-rt/realtime/simpleBridge/simpleBridge.URendering.float"
  "${CMAKE_CURRENT_SOURCE_DIR}/../reducedDynamicSolver-rt/realtime/simpleBridge/simpleBridge.cub"
  DESTINATION "${VEGAFEM_WEB_OUTPUT_DIR}/assets")

function(vegafem_add_web_solver target output_name use_simd)
  add_executable(${target} webBridge.cpp)
  set_target_properties(${target} PROPERTIES
    OUTPUT_NAME "${output_name}"
    RUNTIME_OUTPUT_DIRECTORY "${VEGAFEM_WEB_OUTPUT_DIR}")
  target_compile_features(${target} PRIVATE cxx_std_11)
  target_compile_options(${target} PRIVATE -O3 -flto)
  target_link_options(${target} PRIVATE
    -O3
    -flto
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sENVIRONMENT=web
    -sFILESYSTEM=0
    -sALLOW_MEMORY_GROWTH=0
    -sINITIAL_MEMORY=33554432
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPF32','HEAPF64']"
    "-sEXPORTED_FUNCTIONS=['_vegafem_web_create','_vegafem_web_reset','_vegafem_web_step','_vegafem_web_set_force','_vegafem_web_set_pull','_vegafem_web_clear_pull','_vegafem_web_set_parameter','_vegafem_web_modal_state','_vegafem_web_mode_count','_vegafem_web_set_modal_basis','_vegafem_web_set_stvk_cubic_polynomial','_vegafem_web_deformed_positions','_malloc','_free']")
  if(use_simd)
    target_compile_options(${target} PRIVATE -msimd128)
    target_link_options(${target} PRIVATE -msimd128)
  endif()
endfunction()

# Every deployment carries the broad WebAssembly baseline and an auto-vectorized
# variant. app.js validates SIMD before it chooses the latter, so older Safari
# versions still receive a working solver instead of a Wasm validation error.
vegafem_add_web_solver(vegafem_web_sim "vegafem-web-sim" FALSE)
vegafem_add_web_solver(vegafem_web_simd "vegafem-web-sim-simd" TRUE)

# A named aggregate makes `cmake --build ... --target vegafem_web_demo` the
# stable public command even if the implementation target changes later.
add_custom_target(vegafem_web_demo DEPENDS vegafem_web_sim vegafem_web_simd)
