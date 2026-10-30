#pragma once

extern void serve_sim_startup(void (*initialize)(void)) __attribute__((weak_import));

#define SERVE_SIM_STARTUP_CAPABILITY(initialize) \
  __attribute__((constructor)) static void serve_sim_register_startup(void) { \
    if (serve_sim_startup) serve_sim_startup(initialize); \
  }

// Only libSystem-only, startup-resident images may use this entry point.
extern void serve_sim_startup_all_processes(void (*initialize)(void)) __attribute__((weak_import));

#define SERVE_SIM_STARTUP_ALL_PROCESSES(initialize) \
  __attribute__((constructor)) static void serve_sim_register_startup(void) { \
    if (serve_sim_startup_all_processes) serve_sim_startup_all_processes(initialize); \
  }
