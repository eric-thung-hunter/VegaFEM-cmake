include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libcamera
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libconfigFile
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libcorotationalLinearFEM
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libelasticForceModel
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libforceModel
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libvega-getopts
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libgraph
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libinsertRows
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libintegrator
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libintegratorSparse
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libintegratorDense
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libisotropicHyperelasticFEM
    ${CMAKE_CURRENT_SOURCE_DIR}/../../liblighting
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libloadList
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libmassSpringSystem
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libminivector
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libobjMesh
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libperformanceCounter
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libpolarDecomposition
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libsceneObject
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libsparseMatrix
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libsparseSolver
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libstvk
    ${CMAKE_CURRENT_SOURCE_DIR}/../../libvolumetricMesh
    $<BUILD_INTERFACE:${CMAKE_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)

include(FetchContent)
FetchContent_Declare(vegafem_imgui
  URL https://github.com/ocornut/imgui/archive/refs/tags/v1.92.8.tar.gz
  URL_HASH SHA256=fecb33d33930e12ff53a34064e9d3a06c8f7c3e04408f14cd36c80e3faac863b
)
FetchContent_MakeAvailable(vegafem_imgui)

if (NOT TARGET vegafem_imgui)
  add_library(vegafem_imgui STATIC
    ${vegafem_imgui_SOURCE_DIR}/imgui.cpp
    ${vegafem_imgui_SOURCE_DIR}/imgui_draw.cpp
    ${vegafem_imgui_SOURCE_DIR}/imgui_tables.cpp
    ${vegafem_imgui_SOURCE_DIR}/imgui_widgets.cpp
    ${vegafem_imgui_SOURCE_DIR}/backends/imgui_impl_glut.cpp
    ${vegafem_imgui_SOURCE_DIR}/backends/imgui_impl_opengl2.cpp
  )
  target_include_directories(vegafem_imgui PUBLIC
    ${vegafem_imgui_SOURCE_DIR}
    ${vegafem_imgui_SOURCE_DIR}/backends
  )
  target_link_libraries(vegafem_imgui PUBLIC
    ${OPENGL_gl_LIBRARY}
    ${GLUT_glut_LIBRARY}
  )
  target_compile_features(vegafem_imgui PUBLIC cxx_std_11)
endif()

add_executable(reducedDynamicSolver-rt reducedDynamicSolver-rt.cpp initGraphics.cpp)
target_link_libraries(reducedDynamicSolver-rt 
  objMesh 
  imageIO 
  modalMatrix 
  sceneObjectReduced 
  sceneObject 
  integratorSparse 
  integratorDense 
  integrator 
  reducedStvk 
  stvk 
  reducedElasticForceModel 
  reducedForceModel 
  forceModel 
  matrix 
  matrixIO 
  lighting 
  configFile 
  volumetricMesh 
  loadList 
  vega-getopts 
  camera 
  minivector 
  openGLHelper
  ${CMAKE_THREAD_LIBS_INIT}
  ${OPENGL_gl_LIBRARY} 
  ${GLUT_glut_LIBRARY} 
  ${OPENGL_glu_LIBRARY} 
  vegafem_imgui)

if (VegaFEM_ENABLE_Cg_SUPPORT)
  target_compile_definitions(reducedDynamicSolver-rt
    PRIVATE VEGAFEM_ENABLE_CG_GPU_DEFORMER
  )
  target_link_libraries(reducedDynamicSolver-rt objMeshGPUDeformer)
endif()
