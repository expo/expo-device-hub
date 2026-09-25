#import "SimCamFakes.h"
#import "SimCamFrameSource.h"
#import "SimCamLog.h"
#import "SimCamSwizzles.h"

__attribute__((constructor))
static void SimCamInit(void) {
    @autoreleasepool {
        SimCamReadMirrorModeFromEnv();
        SimCamInstallSwizzles();
        SimCamStartDeviceMonitor();
    }
}
