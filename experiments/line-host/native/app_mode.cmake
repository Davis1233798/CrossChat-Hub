# Included after the pinned cef-project project() call. Target creation happens
# later, so defer the target-only definition until this directory finishes.
if(CMAKE_CURRENT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR AND CROSSCHAT_LINE_PRELOGIN)
  cmake_language(DEFER CALL target_compile_definitions cefsimple PRIVATE CROSSCHAT_LINE_PRELOGIN=1)
endif()
