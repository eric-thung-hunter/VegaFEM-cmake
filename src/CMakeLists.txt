foreach(mod ${VegaFEM_Modules})
  add_subdirectory(lib${mod})
endforeach()

if(VegaFEM_BUILD_UTILITIES)
  add_subdirectory(util)
endif(VegaFEM_BUILD_UTILITIES)
