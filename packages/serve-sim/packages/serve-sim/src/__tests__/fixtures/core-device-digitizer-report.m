#import <dlfcn.h>

// Capture the production shim's report without requiring a booted simulator
// or Apple's private frameworks. Each contact occupies a byte in first:
// direction bits 0..3, swipe-locked bit 4, touch bit 5, and range bit 6.
static void *testSymbol(void *handle, const char *name);
#define dlsym testSymbol
#import "../../../Sources/CoreDeviceShim/CoreDeviceDigitizerShim.m"
#undef dlsym

static uintptr_t valueSize = sizeof(struct DataWords);

static void __attribute__((swiftcall)) reportInit(
    void * __attribute__((swift_indirect_result)) result, void *metadata, void *descriptor, void *witness
) {
    *(struct DataWords *)result = (struct DataWords){0};
}
static struct DataWords __attribute__((swiftcall)) contactInit(void) { return (struct DataWords){0}; }
static void __attribute__((swiftcall)) ignoreInt(intptr_t value, void * __attribute__((swift_context)) context) {}
static void __attribute__((swiftcall)) ignoreDouble(double value, void * __attribute__((swift_context)) context) {}
static void __attribute__((swiftcall)) ignoreIdentity(uint8_t value, intptr_t index, void * __attribute__((swift_context)) context) {}
static void __attribute__((swiftcall)) ignoreTime(uint64_t value, bool missing, void * __attribute__((swift_context)) context) {}
static void __attribute__((swiftcall)) countSetter(uint8_t value, void * __attribute__((swift_context)) context) {
    ((struct DataWords *)context)->second = value;
}
static void __attribute__((swiftcall)) touchSetter(bool value, void * __attribute__((swift_context)) context) {
    ((struct DataWords *)context)->first |= (uint64_t)value << 5;
}
static void __attribute__((swiftcall)) rangeSetter(bool value, void * __attribute__((swift_context)) context) {
    ((struct DataWords *)context)->first |= (uint64_t)value << 6;
}
static void __attribute__((swiftcall)) contactSetter(uint64_t first, uint64_t second, intptr_t index, void * __attribute__((swift_context)) context) {
    ((struct DataWords *)context)->first |= first << (index * 8);
}
#define SWIPE_SETTER(name, bit) \
static void __attribute__((swiftcall)) name(bool value, intptr_t index, void * __attribute__((swift_context)) context) { \
    ((struct DataWords *)context)->first |= (uint64_t)value << (index * 8 + bit); \
}
SWIPE_SETTER(rightSetter, 0)
SWIPE_SETTER(downSetter, 1)
SWIPE_SETTER(upSetter, 2)
SWIPE_SETTER(leftSetter, 3)
SWIPE_SETTER(lockedSetter, 4)

static void __attribute__((swiftcall)) captureReport(
    uint64_t first, uint64_t count, void *service, void *error, void *metadata, void *witness,
    void * __attribute__((swift_context)) context, void ** __attribute__((swift_error_result)) errorFlag
) {
    printf("%llu %llu %llu\n", *(uint64_t *)service, first, count);
    *errorFlag = NULL;
}
static struct MetadataResponse __attribute__((swiftcall)) errorMetadata(uintptr_t request) {
    return (struct MetadataResponse){ .metadata = &valueSize };
}
static void *testSymbol(void *handle, const char *name) {
#define SYMBOL(symbol, function) if (strcmp(name, symbol) == 0) return (void *)function
    SYMBOL("$s12UniversalHID15DigitizerReportVN", &valueSize);
    SYMBOL("$s12UniversalHID16DigitizerContactVN", &valueSize);
    SYMBOL("$s12UniversalHID15DigitizerReportVAA05EventD18DescriptorProtocolAAWP", &valueSize);
    SYMBOL("$s12UniversalHID15DigitizerReportVAA05EventD8ProtocolAAWP", &valueSize);
    SYMBOL("$s12UniversalHID19EventReportProtocolPA2A0cd10DescriptorE0RzrlExycfC", reportInit);
    SYMBOL("$s12UniversalHID16DigitizerContactVACycfC", contactInit);
    SYMBOL("$s12UniversalHID16DigitizerContactV5indexSivs", ignoreInt);
    SYMBOL("$s12UniversalHID16DigitizerContactV1xSdvs", ignoreDouble);
    SYMBOL("$s12UniversalHID16DigitizerContactV1ySdvs", ignoreDouble);
    SYMBOL("$s12UniversalHID16DigitizerContactV5touchSbvs", touchSetter);
    SYMBOL("$s12UniversalHID16DigitizerContactV5rangeSbvs", rangeSetter);
    SYMBOL("$s12UniversalHID15DigitizerReportV12contactCounts5UInt8Vvs", countSetter);
    SYMBOL("$s12UniversalHID15DigitizerReportV10setContact_7atIndexyAA0cF0V_SitF", contactSetter);
    SYMBOL("$s12UniversalHID15DigitizerReportV18setContactIdentity_7atIndexys5UInt8V_SitF", ignoreIdentity);
    SYMBOL("$s12UniversalHID15DigitizerReportV15remoteTimestamps6UInt64VSgvs", ignoreTime);
    SYMBOL("$s12UniversalHID15DigitizerReportV20setContactSwipeRight_7atIndexySb_SitF", rightSetter);
    SYMBOL("$s12UniversalHID15DigitizerReportV19setContactSwipeDown_7atIndexySb_SitF", downSetter);
    SYMBOL("$s12UniversalHID15DigitizerReportV17setContactSwipeUp_7atIndexySb_SitF", upSetter);
    SYMBOL("$s12UniversalHID15DigitizerReportV19setContactSwipeLeft_7atIndexySb_SitF", leftSetter);
    SYMBOL("$s12UniversalHID15DigitizerReportV21setContactSwipeLocked_7atIndexySb_SitF", lockedSetter);
    SYMBOL("$s10CoreDevice19UniversalHIDServiceP4send6report2toy0C3HID9HIDReportV_AA0D2IDVtAA0aB5ErrorVYKFTj", captureReport);
#undef SYMBOL
    fprintf(stderr, "Unexpected symbol: %s\n", name);
    abort();
}

bool SSCoreDeviceInitialize(void) { return true; }
void *SSCoreDeviceSymbol(const char *name) { return (void *)errorMetadata; }
uintptr_t SSCoreDeviceValueSize(void *metadata) { return *(uintptr_t *)metadata; }
void SSCoreDeviceDestroyValue(void *value, void *metadata) {}

int main(int argc, const char *argv[]) {
    if (argc != 4) return 2;
    uint32_t edge = (uint32_t)strtoul(argv[1], NULL, 10);
    bool touching = atoi(argv[2]);
    uint8_t count = (uint8_t)atoi(argv[3]);
    void *capability[5] = { NULL, NULL, NULL, &valueSize, &valueSize };
    struct SSCoreDeviceTouch contacts[] = { { .x = 0.5, .y = 0.99 }, { .x = 0.25, .y = 0.5 } };
    return SSCoreDeviceSendTouches(capability, 0x103, contacts, count, touching, edge) ? 0 : 1;
}
