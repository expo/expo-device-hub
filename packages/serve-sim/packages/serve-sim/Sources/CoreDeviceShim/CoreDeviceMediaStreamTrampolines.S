#if defined(__aarch64__)
.macro FORWARD name, target
.text
.p2align 2
.globl _\name
_\name:
    adrp x16, _\target@PAGE
    ldr x16, [x16, _\target@PAGEOFF]
    br x16
.endmacro
#elif defined(__x86_64__)
.macro FORWARD name, target
.text
.globl _\name
_\name:
    jmp *_\target(%rip)
.endmacro
#endif

FORWARD SSCDMSDeviceInfo, SSCDMSDeviceInfoTarget
FORWARD SSCDMSConnect, SSCDMSConnectTarget
FORWARD SSCDMSAcquire, SSCDMSAcquireTarget
FORWARD SSCDMSRelease, SSCDMSReleaseTarget
FORWARD SSCDMSInvalidation, SSCDMSInvalidationTarget
FORWARD SSCDMSNegotiatorOptions, SSCDMSNegotiatorOptionsTarget
FORWARD SSCDMSSharedSocket, SSCDMSSharedSocketTarget
FORWARD SSCDMSClientName, SSCDMSClientNameTarget
FORWARD SSCDMSClientSessionID, SSCDMSClientSessionIDTarget
FORWARD SSCDMSCodableValue, SSCDMSCodableValueTarget
FORWARD SSCDMSSupportAsync, SSCDMSSupportAsyncTarget
FORWARD SSCDMSStartAsync, SSCDMSStartAsyncTarget
FORWARD SSCDMSStopAsync, SSCDMSStopAsyncTarget

.data
.p2align 2
.globl _SSCDMSSupportAsyncTu
_SSCDMSSupportAsyncTu:
.long _SSCDMSSupportAsync - _SSCDMSSupportAsyncTu
.long 0
.globl _SSCDMSStartAsyncTu
_SSCDMSStartAsyncTu:
.long _SSCDMSStartAsync - _SSCDMSStartAsyncTu
.long 0
.globl _SSCDMSStopAsyncTu
_SSCDMSStopAsyncTu:
.long _SSCDMSStopAsync - _SSCDMSStopAsyncTu
.long 0
