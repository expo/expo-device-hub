#pragma once

#include <stdint.h>

// Shifts every wall clock function of this process by `offset_ns`; 0 is the Mac's time.
extern void serve_sim_set_wall_clock_offset(int64_t offset_ns) __attribute__((weak_import));
