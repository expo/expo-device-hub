#include "CoreDeviceShim.h"
#include <dispatch/dispatch.h>
#include <stdint.h>

extern int32_t SSCDDisplayStateDescriptor[2];
static void *target;
bool SSCoreDeviceDisplayStateAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        target = SSCoreDeviceSymbol("$s10CoreDevice19DisplayInfoProtocolP07displayD7UpdatesScsyAA0cD0Vs5Error_pGyYaKFTj");
        int32_t *descriptor = SSCoreDeviceSymbol("$s10CoreDevice19DisplayInfoProtocolP07displayD7UpdatesScsyAA0cD0Vs5Error_pGyYaKFTjTu");
        if (!target || !descriptor) return;
        SSCDDisplayStateDescriptor[1] = descriptor[1];
        available = true;
    });
    return available;
}
typedef void (*Start)(void *, void *, void *, void * __attribute__((swift_context)), void * __attribute__((swift_async_context))) __attribute__((swiftasynccall));
void __attribute__((swiftasynccall)) SSCDDisplayState(void *out, void *metadata, void *witness, void *object,
                                                    void * __attribute__((swift_async_context)) context) {
    __attribute__((musttail)) return ((Start)target)(out, metadata, witness, object, context);
}
void *SSCoreDeviceDisplayStatePointer(void) { return SSCDDisplayStateDescriptor; }
