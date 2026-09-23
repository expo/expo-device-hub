#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../Sources/CoreDeviceShim/CoreDeviceMotionShim.c"

int32_t SSCDMotionManagerDescriptor[2];
static int32_t sourceDescriptor[2] = { 0, 256 };
static int initializeCalls, symbolCalls;
static bool frameworkAvailable, symbolAvailable;

bool SSCoreDeviceInitialize(void) {
    initializeCalls++;
    return frameworkAvailable;
}

void *SSCoreDeviceSymbol(const char *name) {
    symbolCalls++;
    if (strstr(name, "KFTjTu")) return sourceDescriptor;
    return symbolAvailable ? sourceDescriptor : NULL;
}

int main(int argc, const char *argv[]) {
    if (argc != 2) return 2;
    frameworkAvailable = strcmp(argv[1], "missing-framework") != 0;
    symbolAvailable = strcmp(argv[1], "missing-symbol") != 0;
    bool expected = frameworkAvailable && symbolAvailable;
    if (SSCoreDeviceMotionAvailable() != expected) return 1;
    sourceDescriptor[1] = 512;
    for (int i = 0; i < 100; i++) {
        if (SSCoreDeviceMotionAvailable() != expected) return 1;
    }
    printf("%d %d %d\n", initializeCalls, symbolCalls, SSCDMotionManagerDescriptor[1]);
    return 0;
}
