# Browser front end for the reduced-dynamics demo.
#
# This target intentionally stays independent of the legacy OpenGL/GLUT
# application. The native and web front ends can therefore evolve separately
# while sharing the numerical model format in later porting steps.

set(VEGAFEM_WEB_OUTPUT_DIR "${CMAKE_BINARY_DIR}/web")
file(MAKE_DIRECTORY "${VEGAFEM_WEB_OUTPUT_DIR}/addons/controls")

# Pin the renderer files that are shipped alongside the generated Wasm files.
# Keeping them in the build output (instead of a CDN) makes offline and
# air-gapped deployments behave the same as CI.
function(vegafem_download_web_asset relative_path source_path sha256)
  set(destination "${VEGAFEM_WEB_OUTPUT_DIR}/${relative_path}")
  get_filename_component(destination_directory "${destination}" DIRECTORY)
  file(MAKE_DIRECTORY "${destination_directory}")
  file(DOWNLOAD
    "https://raw.githubusercontent.com/mrdoob/three.js/r180/${source_path}"
    "${destination}"
    EXPECTED_HASH "SHA256=${sha256}"
    TLS_VERIFY ON)
endfunction()

vegafem_download_web_asset("three.module.js" "build/three.module.js" "c8211c69345d2e9949dc7a8ac969380497aa0600a5a8ac6a459c8cd02dd9cb8a")
vegafem_download_web_asset("three.webgpu.js" "build/three.webgpu.js" "c6b225365368fc052bd96ebfae1363324ea526e59f15a60e201e1257c3adc12f")
vegafem_download_web_asset("three.tsl.js" "build/three.tsl.js" "ac2c7cd43ce90d006c12e2ace3e0af98a1bd538162c661e4199b50edcf508d92")
vegafem_download_web_asset("three.core.js" "build/three.core.js" "eb077d2417f61d3e6d9264c317cabc4ea35769ed6b0ab533067292a550784c20")
vegafem_download_web_asset("addons/controls/OrbitControls.js" "examples/jsm/controls/OrbitControls.js" "b97879c748170baadeb3fb84cea1ffdf4674e283dc06042f34e2acb95a76042c")

configure_file(index.html "${VEGAFEM_WEB_OUTPUT_DIR}/index.html" COPYONLY)
configure_file(app.js "${VEGAFEM_WEB_OUTPUT_DIR}/app.js" COPYONLY)
configure_file(style.css "${VEGAFEM_WEB_OUTPUT_DIR}/style.css" COPYONLY)
file(MAKE_DIRECTORY "${VEGAFEM_WEB_OUTPUT_DIR}/assets")
file(COPY
  "${CMAKE_CURRENT_SOURCE_DIR}/../reducedDynamicSolver-rt/realtime/simpleBridge/simpleBridge.obj"
  "${CMAKE_CURRENT_SOURCE_DIR}/../reducedDynamicSolver-rt/realtime/simpleBridge/simpleBridge.URendering.float"
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
    "-sEXPORTED_FUNCTIONS=['_vegafem_web_create','_vegafem_web_reset','_vegafem_web_step','_vegafem_web_set_force','_vegafem_web_modal_state','_vegafem_web_mode_count','_vegafem_web_set_modal_basis','_vegafem_web_deformed_positions','_malloc','_free']")
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
