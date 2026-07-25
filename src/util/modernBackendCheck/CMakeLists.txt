add_executable(vegaModernBackendCheck modernBackendCheck.cpp)

target_compile_features(vegaModernBackendCheck PRIVATE cxx_std_17)
target_compile_definitions(vegaModernBackendCheck PRIVATE VEGA_USE_SYCL)
target_compile_options(vegaModernBackendCheck PRIVATE -fsycl)
target_link_options(vegaModernBackendCheck PRIVATE -fsycl)
target_link_libraries(vegaModernBackendCheck
  PRIVATE
    PkgConfig::SDL2
    Vulkan::Vulkan
    OpenCL::OpenCL
)

install(TARGETS vegaModernBackendCheck
  RUNTIME DESTINATION ${BIN_DIR}
)
