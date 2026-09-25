#pragma once

extern void serve_sim_startup(void (*initialize)(void)) __attribute__((weak_import));

#define SERVE_SIM_STARTUP_CAPABILITY(initialize) \
  __attribute__((constructor)) static void serve_sim_register_startup(void) { \
    if (serve_sim_startup) serve_sim_startup(initialize); \
  }
