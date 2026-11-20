#include "CoreDeviceShim.h"
#include <dispatch/dispatch.h>
#include <stdint.h>

void *SSCDMSDeviceInfoTarget, *SSCDMSConnectTarget, *SSCDMSAcquireTarget, *SSCDMSReleaseTarget;
void *SSCDMSInvalidationTarget;
void *SSCDMSNegotiatorOptionsTarget, *SSCDMSSharedSocketTarget, *SSCDMSClientNameTarget;
void *SSCDMSClientSessionIDTarget, *SSCDMSCodableValueTarget;
void *SSCDMSSupportAsyncTarget, *SSCDMSStartAsyncTarget, *SSCDMSStopAsyncTarget;
extern int32_t SSCDMSSupportAsyncTu[2], SSCDMSStartAsyncTu[2], SSCDMSStopAsyncTu[2];

static void *requestMetadataAccessor, *stopRequestMetadataAccessor, *responseMetadataAccessor;
static void *stopResponseMetadataAccessor, *supportMetadataAccessor, *requirementsMetadataAccessor;
static void *deviceInfoMetadataAccessor, *codableValueMetadataAccessor;

static bool resolve(void **destination, const char *symbol) {
    *destination = SSCoreDeviceSymbol(symbol);
    return *destination != NULL;
}

static bool resolveAsync(void **destination, int32_t *forwarder, const char *symbol, const char *descriptorSymbol) {
    int32_t *descriptor = SSCoreDeviceSymbol(descriptorSymbol);
    if (!resolve(destination, symbol) || !descriptor) return false;
    forwarder[1] = descriptor[1];
    return true;
}

bool SSCoreDeviceMediaStreamAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceInitialize()) return;
        bool found = true;
        found &= resolve(&SSCDMSDeviceInfoTarget, "$s10CoreDevice06RemoteB0C10deviceInfo0aB9Protocols0bE0VvgTj");
        found &= resolve(&SSCDMSConnectTarget, "$s10CoreDevice06RemoteB0C7connect11targetQueue17completionHandlerySo17OS_dispatch_queueCSg_ys6ResultOyyts5Error_pGctFTj");
        found &= resolve(&SSCDMSAcquireTarget, "$s10CoreDevice06RemoteB0C07acquireB14UsageAssertion10withReason12requirements27invokingCompletionHandlerOn010completionL0So10NSProgressCSS_AA0eF12RequirementsVSo17OS_dispatch_queueCSgys6ResultOyAA0beF0Cs5Error_pGYbctF");
        found &= resolve(&SSCDMSReleaseTarget, "$s10CoreDevice0B14UsageAssertionC07releaseD0yyFTj");
        found &= resolve(&SSCDMSInvalidationTarget, "$s10CoreDevice0B14UsageAssertionC27registerInvalidationHandler15invokingOnQueue7handlerySo17OS_dispatch_queueCSg_ys5Error_pSgctFTj");
        found &= resolveAsync(&SSCDMSSupportAsyncTarget, SSCDMSSupportAsyncTu,
                              "$s10CoreDevice06RemoteB0C22mediaStreamSupportInfoAA0b5MediaE0V0fG8ResponseVvg",
                              "$s10CoreDevice06RemoteB0C22mediaStreamSupportInfoAA0b5MediaE0V0fG8ResponseVvgTu");
        found &= resolveAsync(&SSCDMSStartAsyncTarget, SSCDMSStartAsyncTu,
                              "$s10CoreDevice06RemoteB0C16startMediaStream4withAA0beF0V13StartResponseVAG0H7RequestV_tYaKF",
                              "$s10CoreDevice06RemoteB0C16startMediaStream4withAA0beF0V13StartResponseVAG0H7RequestV_tYaKFTu");
        found &= resolveAsync(&SSCDMSStopAsyncTarget, SSCDMSStopAsyncTu,
                              "$s10CoreDevice06RemoteB0C15stopMediaStream4withAA0beF0V12StopResponseVAG0H7RequestV_tYaKF",
                              "$s10CoreDevice06RemoteB0C15stopMediaStream4withAA0beF0V12StopResponseVAG0H7RequestV_tYaKFTu");
        found &= resolve(&SSCDMSNegotiatorOptionsTarget, "$s10CoreDevice17MediaStreamHelperV20getNegotiatorOptions3forSDySSypG0aB9Protocols0B4InfoV_tFZ");
        found &= resolve(&SSCDMSSharedSocketTarget, "$s10CoreDevice12NetworkUtilsV26withSharedSocketDictionary13sourceAddress4port06remoteJ00L4Port4bodyx0C004IPv6J0V_s6UInt16VAlNxSo13OS_xpc_object_pKXEtKlFZ");
        found &= resolve(&SSCDMSClientNameTarget, "$s10CoreDevice0B11MediaStreamV09kAVCMediaD16OptionClientNameSSvgZ");
        found &= resolve(&SSCDMSClientSessionIDTarget, "$s10CoreDevice0B11MediaStreamV09kAVCMediaD21OptionClientSessionIDSSvgZ");
        found &= resolve(&SSCDMSCodableValueTarget, "$s10CoreDevice12CodableValueOyACSgypcfC");
        found &= resolve(&requestMetadataAccessor, "$s10CoreDevice0B11MediaStreamV12StartRequestVMa");
        found &= resolve(&stopRequestMetadataAccessor, "$s10CoreDevice0B11MediaStreamV11StopRequestVMa");
        found &= resolve(&responseMetadataAccessor, "$s10CoreDevice0B11MediaStreamV13StartResponseVMa");
        found &= resolve(&stopResponseMetadataAccessor, "$s10CoreDevice0B11MediaStreamV12StopResponseVMa");
        found &= resolve(&supportMetadataAccessor, "$s10CoreDevice0B11MediaStreamV19SupportInfoResponseVMa");
        found &= resolve(&requirementsMetadataAccessor, "$s10CoreDevice26UsageAssertionRequirementsVMa");
        found &= resolve(&deviceInfoMetadataAccessor, "$s19CoreDeviceProtocols0B4InfoVMa");
        found &= resolve(&codableValueMetadataAccessor, "$s10CoreDevice12CodableValueOMa");
        available = found;
    });
    return available;
}

struct SSCDMSMetadataResponse { void *metadata; uintptr_t state; };
typedef struct SSCDMSMetadataResponse (*SSCDMSMetadataAccessor)(uintptr_t) __attribute__((swiftcall));

static void *metadata(void *accessor) {
    return SSCoreDeviceMediaStreamAvailable() ? ((SSCDMSMetadataAccessor)accessor)(0).metadata : NULL;
}

void *SSCoreDeviceMediaStreamTypeMetadata(enum SSCoreDeviceMediaStreamType type) {
    if (!SSCoreDeviceMediaStreamAvailable()) return NULL;
    switch (type) {
        case SSCoreDeviceMediaStreamStartRequest: return metadata(requestMetadataAccessor);
        case SSCoreDeviceMediaStreamStopRequest: return metadata(stopRequestMetadataAccessor);
        case SSCoreDeviceMediaStreamStartResponse: return metadata(responseMetadataAccessor);
        case SSCoreDeviceMediaStreamStopResponse: return metadata(stopResponseMetadataAccessor);
        case SSCoreDeviceMediaStreamSupportInfoResponse: return metadata(supportMetadataAccessor);
        case SSCoreDeviceMediaStreamUsageAssertionRequirements: return metadata(requirementsMetadataAccessor);
        case SSCoreDeviceMediaStreamDeviceInfo: return metadata(deviceInfoMetadataAccessor);
        case SSCoreDeviceMediaStreamCodableValue: return metadata(codableValueMetadataAccessor);
    }
    return NULL;
}
