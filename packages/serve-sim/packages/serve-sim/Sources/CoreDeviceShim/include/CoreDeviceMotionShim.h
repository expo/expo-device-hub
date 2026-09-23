#pragma once
#include <stdbool.h>
bool SSCoreDeviceMotionAvailable(void);
void *SSCoreDeviceMotionManagerPointer(void);
void *SSCoreDeviceMotionManagerMetadata(void);
void *SSCoreDeviceErrorMetadata(void);
bool SSCoreDeviceMotionSupportsHinge(void *manager);
bool SSCoreDeviceHingeReadbackAvailable(void);
void *SSCoreDeviceHingeReadbackPointer(void);
void *SSCoreDeviceHingeReadbackMetadata(void);
void *SSCoreDeviceHingeConfigMetadata(void);
