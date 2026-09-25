#import <dlfcn.h>
#import <assert.h>

static void *testSymbol(void *handle, const char *name);
#define dlsym testSymbol
#import "../../../Sources/CoreDeviceShim/CoreDeviceKeyboardShim.m"
#undef dlsym

// Swift metadata stores the value-witness table immediately before its address.
static struct ValueWitnessTable {
    void *functions[8];
    uintptr_t size;
} keyWitnesses = { .size = 2 }, stateWitnesses = { .size = 1 }, optionalWitnesses = { .size = 2 };
static void *keyTypeStorage[2] = { &keyWitnesses, NULL };
static void *stateTypeStorage[2] = { &stateWitnesses, NULL };
static void *optionalTypeStorage[2] = { &optionalWitnesses, NULL };
static const char *scenario;
static unsigned sends, barriers, destroys, releases, tagReads;
static uint8_t rawState;
static const void *stateValue;
static int errorObject;
static void *capability[5] = { NULL, NULL, NULL, &keyTypeStorage[1], &stateTypeStorage[1] };

static struct MetadataResponse __attribute__((swiftcall)) keyType(uintptr_t request) {
    return (struct MetadataResponse){ .metadata = &keyTypeStorage[1] };
}
static struct MetadataResponse __attribute__((swiftcall)) stateType(uintptr_t request) {
    return (struct MetadataResponse){ .metadata = &stateTypeStorage[1] };
}
static struct MetadataResponse __attribute__((swiftcall)) optionalType(uintptr_t request, void *metadata) {
    assert(metadata == &stateTypeStorage[1]);
    return (struct MetadataResponse){ .metadata = &optionalTypeStorage[1] };
}
static void __attribute__((swiftcall)) keyInit(
    void * __attribute__((swift_indirect_result)) result, uint16_t value
) {
    *(uint16_t *)result = value;
}
static void __attribute__((swiftcall)) stateInit(
    void * __attribute__((swift_indirect_result)) result, uint8_t value
) {
    assert(value == 1 || value == 2);
    rawState = value;
    stateValue = result;
    ((uint8_t *)result)[0] = value - 1;
    if (optionalWitnesses.size == 2) ((uint8_t *)result)[1] = 0;
    if (strcmp(scenario, "nil-one-byte") == 0) ((uint8_t *)result)[0] = 0xfe;
    if (strcmp(scenario, "nil-two-byte") == 0) ((uint8_t *)result)[1] = 1;
}
static void checkCapability(void *metadata, void *witness, void *context) {
    assert(metadata == capability[3] && witness == capability[4] && context == capability);
}
static void __attribute__((swiftcall)) captureKey(
    void *key, void *state, void *metadata, void *witness,
    void * __attribute__((swift_context)) context, void ** __attribute__((swift_error_result)) error
) {
    checkCapability(metadata, witness, context);
    assert(*(uint16_t *)key == 0xe1);
    assert(*(uint8_t *)state == rawState - 1);
    assert(*error == NULL);
    sends++;
    if (strcmp(scenario, "send-error") == 0) *error = &errorObject;
}
static void __attribute__((swiftcall)) captureBarrier(
    void *metadata, void *witness, void * __attribute__((swift_context)) context
) {
    checkCapability(metadata, witness, context);
    assert(sends == 1);
    barriers++;
}
static void captureRelease(void *error) {
    assert(error == &errorObject);
    releases++;
}
static void *testSymbol(void *handle, const char *name) {
#define SYMBOL(symbol, function) if (strcmp(name, symbol) == 0) return (void *)function
    SYMBOL("$s10CoreDevice20HIDKeyboardUsageCodeVMa", keyType);
    SYMBOL("$s10CoreDevice14HIDButtonStateOMa", stateType);
    SYMBOL("$s10CoreDevice20HIDKeyboardUsageCodeV8rawValueACs6UInt16V_tcfC", keyInit);
    SYMBOL("$s10CoreDevice14HIDButtonStateO8rawValueACSgs5UInt8V_tcfC", stateInit);
    SYMBOL("$s10CoreDevice11HIDKeyboardP4send3key5stateyAA0C9UsageCodeV_AA14HIDButtonStateOtKFTj", captureKey);
    SYMBOL("$s10CoreDevice11HIDKeyboardP11sendBarrieryyFTj", captureBarrier);
    SYMBOL("$sSqMa", optionalType);
    if (strcmp(scenario, "missing-symbol") == 0) return NULL;
    SYMBOL("swift_errorRelease", captureRelease);
#undef SYMBOL
    abort();
}

bool SSCoreDeviceInitialize(void) { return true; }
void *SSCoreDeviceSymbol(const char *name) { return testSymbol(NULL, name); }
static unsigned __attribute__((swiftcall)) captureTag(
    const void *value, unsigned emptyCases, void *metadata
) {
    assert(value == stateValue);
    assert(emptyCases == 1);
    assert(metadata == &stateTypeStorage[1]);
    tagReads++;
    const uint8_t *bytes = value;
    // The runtime decides the spare inhabitant; callers must not assume a tag.
    return optionalWitnesses.size == 1 ? bytes[0] == 0xfe : bytes[1];
}
static void __attribute__((swiftcall)) captureDestroy(void *value, void *metadata) {
    assert(metadata == &keyTypeStorage[1] || metadata == &optionalTypeStorage[1]);
    if (metadata == &optionalTypeStorage[1]) assert(value == stateValue);
    else assert(*(uint16_t *)value == 0xe1);
    destroys++;
}

int main(int argc, const char *argv[]) {
    if (argc != 2) return 2;
    scenario = argv[1];
    keyWitnesses.functions[1] = (void *)captureDestroy;
    optionalWitnesses.functions[1] = (void *)captureDestroy;
    stateWitnesses.functions[6] = (void *)captureTag;
    if (strcmp(scenario, "key-size") == 0) keyWitnesses.size = 4;
    if (strcmp(scenario, "state-size") == 0) stateWitnesses.size = 8;
    if (strcmp(scenario, "optional-size") == 0) optionalWitnesses.size = 3;
    if (strstr(scenario, "one-byte")) optionalWitnesses.size = 1;
    if (strcmp(scenario, "invalid-capability") == 0) capability[4] = NULL;
    uint32_t usage = strcmp(scenario, "invalid-usage") == 0 ? 0x100e1 : 0xe1;
    bool down = strcmp(scenario, "up") != 0;
    bool result = SSCoreDeviceSendKey(capability, usage, down);
    bool success = strcmp(scenario, "down") == 0 || strcmp(scenario, "up") == 0 ||
        strcmp(scenario, "some-one-byte") == 0;
    bool failure = strcmp(scenario, "send-error") == 0;
    bool missingState = strncmp(scenario, "nil-", 4) == 0;
    assert(result == success);
    assert(tagReads == (success || failure || missingState ? 1 : 0));
    assert(sends == (success || failure ? 1 : 0));
    assert(destroys == (success || failure ? 2 : missingState ? 1 : 0));
    assert(barriers == 0);
    assert(releases == (failure ? 1 : 0));
    if (success) assert(rawState == (down ? 1 : 2));
    return 0;
}
