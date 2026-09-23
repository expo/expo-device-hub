#import <dlfcn.h>

// Exercise the production resolver with synthetic runtime metadata, without
// loading Apple's private frameworks or constructing an incompatible value.
static void *testSymbol(void *handle, const char *name);
#define dlsym testSymbol
#import "../../../Sources/CoreDeviceShim/CoreDeviceDigitizerShim.m"
#undef dlsym

static uintptr_t reportSize, contactSize, errorSize = 16;

static void unexpectedCall(void) {
    fputs("An unavailable digitizer called into the private framework\n", stderr);
    abort();
}

static void *testSymbol(void *handle, const char *name) {
    if (strcmp(name, "$s12UniversalHID15DigitizerReportVN") == 0) return &reportSize;
    if (strcmp(name, "$s12UniversalHID16DigitizerContactVN") == 0) return &contactSize;
    return (void *)unexpectedCall;
}

static struct MetadataResponse __attribute__((swiftcall)) errorMetadata(uintptr_t request) {
    return (struct MetadataResponse){ .metadata = &errorSize };
}

bool SSCoreDeviceInitialize(void) { return true; }
void *SSCoreDeviceSymbol(const char *name) { return (void *)errorMetadata; }
uintptr_t SSCoreDeviceValueSize(void *metadata) { return *(uintptr_t *)metadata; }
void SSCoreDeviceDestroyValue(void *value, void *metadata) { unexpectedCall(); }

int main(int argc, const char *argv[]) {
    if (argc != 3) return 2;
    reportSize = strtoull(argv[1], NULL, 10);
    contactSize = strtoull(argv[2], NULL, 10);
    bool available = SSCoreDeviceDigitizerAvailable();
    puts(available ? "available" : "unavailable");
    if (!available) {
        void *capability[5] = { NULL, NULL, NULL, &reportSize, &contactSize };
        struct SSCoreDeviceTouch touch = { .x = 0.5, .y = 0.5 };
        if (SSCoreDeviceSendTouches(capability, 0x101, &touch, 1, true, 0)) return 1;
    }
    return 0;
}
