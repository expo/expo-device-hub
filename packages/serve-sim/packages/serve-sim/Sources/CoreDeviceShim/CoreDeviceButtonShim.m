#import "CoreDeviceShim.h"
#import <Foundation/Foundation.h>
#import <dlfcn.h>

struct MetadataResponse { void *metadata; uintptr_t state; };
typedef struct MetadataResponse (*Metadata)(uintptr_t) __attribute__((swiftcall));
typedef struct MetadataResponse (*OptionalMetadata)(uintptr_t, void *) __attribute__((swiftcall));
typedef void (*InitState)(void * __attribute__((swift_indirect_result)), uint8_t) __attribute__((swiftcall));
typedef void (*SendButton)(intptr_t, intptr_t, void *, void *, void *, void * __attribute__((swift_context)), void ** __attribute__((swift_error_result))) __attribute__((swiftcall));
typedef void (*ReleaseError)(void *);

typedef void (*Barrier)(void *, void *, void * __attribute__((swift_context))) __attribute__((swiftcall));
static Barrier barrier;
static void *stateMetadata, *optionalStateMetadata;
static InitState initState;
static SendButton sendButton;
static ReleaseError releaseError;

bool SSCoreDeviceButtonAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceInitialize()) return;
        bool found = true;
        Metadata stateType;
#define RESOLVE(variable, symbol) do { variable = (typeof(variable))SSCoreDeviceSymbol(symbol); found &= variable != NULL; } while (0)
        RESOLVE(stateType, "$s10CoreDevice14HIDButtonStateOMa");
        RESOLVE(initState, "$s10CoreDevice14HIDButtonStateO8rawValueACSgs5UInt8V_tcfC");
        RESOLVE(sendButton, "$s10CoreDevice9HIDButtonP16sendCustomButton9usagePage0G4Code5stateySi_SiAA0C5StateOtKFTj");
        RESOLVE(barrier, "$s10CoreDevice9HIDButtonP11sendBarrieryyFTj");
#undef RESOLVE
        OptionalMetadata optionalType = (OptionalMetadata)dlsym(RTLD_DEFAULT, "$sSqMa");
        releaseError = (ReleaseError)dlsym(RTLD_DEFAULT, "swift_errorRelease");
        if (!found || !optionalType || !releaseError) return;
        stateMetadata = stateType(0).metadata;
        if (!stateMetadata) return;
        optionalStateMetadata = optionalType(0, stateMetadata).metadata;
        // rawValue initializers construct Apple's resilient values. The state
        // initializer returns Optional, which may need an additional tag byte.
        available = optionalStateMetadata &&
            SSCoreDeviceValueSize(stateMetadata) == sizeof(uint8_t) &&
            SSCoreDeviceValueSize(optionalStateMetadata) >= sizeof(uint8_t) &&
            SSCoreDeviceValueSize(optionalStateMetadata) <= 2;
    });
    return available;
}

bool SSCoreDeviceSendButton(void *capability, uint32_t page, uint32_t usage, bool down) {
    if (!capability || page > UINT16_MAX || usage > UINT16_MAX || !SSCoreDeviceButtonAvailable()) return false;
    void *metadata = ((void **)capability)[3], *witness = ((void **)capability)[4];
    if (!metadata || !witness) return false;

    uint8_t state[2] = {0};
    initState(state, down ? 1 : 2);
    if (!SSCoreDeviceOptionalHasValue(state, stateMetadata)) {
        SSCoreDeviceDestroyValue(state, optionalStateMetadata);
        return false;
    }
    void *error = NULL;
    sendButton(page, usage, state, metadata, witness, capability, &error);
    SSCoreDeviceDestroyValue(state, optionalStateMetadata);
    // HIDButton uses untyped Swift throws, unlike UniversalHID's typed
    // CoreDeviceError result. The error register owns a Swift error object.
    if (error) {
        releaseError(error);
        return false;
    }
    barrier(metadata, witness, capability);
    return true;
}
