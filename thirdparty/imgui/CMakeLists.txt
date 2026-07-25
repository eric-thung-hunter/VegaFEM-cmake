add_library(imgui STATIC
  imgui.cpp
  imgui_draw.cpp
  imgui_tables.cpp
  imgui_widgets.cpp
  backends/imgui_impl_opengl2.cpp
)
if (VegaFEM_ENABLE_SDL2_SUPPORT)
  target_sources(imgui PRIVATE backends/imgui_impl_sdl2.cpp)
  target_include_directories(imgui PUBLIC ${SDL2_INCLUDE_DIRS})
  target_link_libraries(imgui PUBLIC ${SDL2_LIBRARIES})
else()
  target_sources(imgui PRIVATE backends/imgui_impl_glut.cpp)
endif()
target_include_directories(imgui PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/backends
)
target_link_libraries(imgui PUBLIC ${OPENGL_gl_LIBRARY} ${GLUT_glut_LIBRARY})
