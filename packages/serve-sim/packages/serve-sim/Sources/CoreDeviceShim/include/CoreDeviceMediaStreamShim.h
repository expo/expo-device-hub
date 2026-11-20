#pragma once
#include <stdbool.h>

enum SSCoreDeviceMediaStreamType {
    SSCoreDeviceMediaStreamStartRequest,
    SSCoreDeviceMediaStreamStopRequest,
    SSCoreDeviceMediaStreamStartResponse,
    SSCoreDeviceMediaStreamStopResponse,
    SSCoreDeviceMediaStreamSupportInfoResponse,
    SSCoreDeviceMediaStreamUsageAssertionRequirements,
    SSCoreDeviceMediaStreamDeviceInfo,
    SSCoreDeviceMediaStreamCodableValue,
};

bool SSCoreDeviceMediaStreamAvailable(void);
void *SSCoreDeviceMediaStreamTypeMetadata(enum SSCoreDeviceMediaStreamType type);
