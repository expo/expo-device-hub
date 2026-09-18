# SPDX-License-Identifier: MIT
# Disposable standalone integration experiment, not a release build.
cmake_minimum_required(VERSION 3.18)
project(gfxstream_hook_prototype LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_BUILD_TYPE Release CACHE STRING "Build configuration")
set(CMAKE_CXX_FLAGS_RELEASE "-O1 -g0 -DNDEBUG" CACHE STRING "Prototype flags" FORCE)
set(CMAKE_C_FLAGS_RELEASE "-O1 -g0 -DNDEBUG" CACHE STRING "Prototype flags" FORCE)

foreach(input GFXSTREAM_SOURCE_DIR FRIDA_CORE_DEVKIT_DIR FRIDA_GUM_DEVKIT_DIR)
  if(NOT IS_DIRECTORY "${${input}}")
    message(FATAL_ERROR "Set ${input} to its source/devkit directory")
  endif()
endforeach()

if(NOT EXISTS "${GFXSTREAM_BUILD_DIR}/libgfxstream_backend.so")
  message(FATAL_ERROR "Build standalone gfxstream first; use run-demo.py")
endif()
# Link the independently built upstream library and use its matching headers.
add_library(gfxstream_backend SHARED IMPORTED)
set_target_properties(gfxstream_backend PROPERTIES
  IMPORTED_LOCATION "${GFXSTREAM_BUILD_DIR}/libgfxstream_backend.so")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

add_executable(gfxstream-demo-host host.cpp)
target_link_libraries(gfxstream-demo-host PRIVATE gfxstream_backend)
target_compile_definitions(gfxstream-demo-host PRIVATE GFXSTREAM_ENABLE_HOST_GLES=1)
target_include_directories(gfxstream-demo-host PRIVATE
  "${GFXSTREAM_SOURCE_DIR}/host"
  "${GFXSTREAM_SOURCE_DIR}/host/include"
  "${GFXSTREAM_SOURCE_DIR}/host/common/include"
  "${GFXSTREAM_SOURCE_DIR}/host/features/include"
  "${GFXSTREAM_SOURCE_DIR}/host/gl/OpenGLESDispatch/include"
  "${GFXSTREAM_SOURCE_DIR}/common/base/include"
  "${GFXSTREAM_SOURCE_DIR}/common/logging/include"
  "${GFXSTREAM_SOURCE_DIR}/third_party/vulkan/include")

add_library(gfxstream-demo-hook SHARED hook-agent.cpp)
target_include_directories(gfxstream-demo-hook PRIVATE "${FRIDA_GUM_DEVKIT_DIR}" ../../src)
target_link_libraries(gfxstream-demo-hook PRIVATE
  "${FRIDA_GUM_DEVKIT_DIR}/libfrida-gum.a" dl pthread m rt resolv)
target_compile_options(gfxstream-demo-hook PRIVATE -ffunction-sections -fdata-sections -fvisibility=hidden)
target_link_options(gfxstream-demo-hook PRIVATE -Wl,-Bsymbolic -Wl,--exclude-libs,ALL -Wl,--gc-sections)

# Compile the same controller used by the capture experiment for this host CPU.
add_executable(gfxstream-demo-inject ../../src/inject.cpp)
target_include_directories(gfxstream-demo-inject PRIVATE "${FRIDA_CORE_DEVKIT_DIR}")
target_link_libraries(gfxstream-demo-inject PRIVATE
  "${FRIDA_CORE_DEVKIT_DIR}/libfrida-core.a" dl pthread m rt resolv)
target_compile_options(gfxstream-demo-inject PRIVATE -ffunction-sections -fdata-sections)
target_link_options(gfxstream-demo-inject PRIVATE -Wl,--exclude-libs,ALL -Wl,--gc-sections)
