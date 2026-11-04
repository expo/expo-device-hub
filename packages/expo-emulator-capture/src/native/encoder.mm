// SPDX-License-Identifier: MIT
#include "encoder.h"
#import <Foundation/Foundation.h>

namespace expo_capture {
namespace {

std::string osStatus(const char* operation, OSStatus status) {
  return std::string(operation) + " failed (OSStatus " + std::to_string(int(status)) + ")";
}

void appendStartCode(std::vector<uint8_t>& out) {
  static const uint8_t code[4] = {0, 0, 0, 1};
  out.insert(out.end(), code, code + 4);
}

bool isKeyFrame(CMSampleBufferRef sample) {
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  if (!attachments || CFArrayGetCount(attachments) == 0) return true;
  auto entry = (CFDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
  CFBooleanRef notSync = nullptr;
  return !(CFDictionaryGetValueIfPresent(entry, kCMSampleAttachmentKey_NotSync,
                                         (const void**)&notSync) &&
           notSync && CFBooleanGetValue(notSync));
}

}  // namespace

bool H264Encoder::configure(int width, int height, int fps, int bitRate, std::string& error) {
  invalidate();
  @autoreleasepool {
    NSDictionary* source = @{
      (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
      (id)kCVPixelBufferWidthKey : @(width),
      (id)kCVPixelBufferHeightKey : @(height),
      (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
    };
    // Prefer the hardware encoder with low-latency rate control, which emits
    // each frame without holding one back. A Mac without a usable hardware
    // encoder gets the software encoder.
    NSArray<NSDictionary*>* specifications = @[
      @{
        (id)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder : @YES,
        (id)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder : @YES,
        (id)kVTVideoEncoderSpecification_EnableLowLatencyRateControl : @YES,
      },
      @{(id)kVTVideoEncoderSpecification_EnableLowLatencyRateControl : @YES},
      @{},
    ];
    OSStatus status = noErr;
    bool requiredHardware = false;
    for (NSDictionary* specification in specifications) {
      status = VTCompressionSessionCreate(
          kCFAllocatorDefault, width, height, kCMVideoCodecType_H264,
          (__bridge CFDictionaryRef)specification, (__bridge CFDictionaryRef)source, nullptr,
          &H264Encoder::didEncode, this, &session_);
      if (status == noErr) {
        requiredHardware =
            specification[(id)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder] !=
            nil;
        break;
      }
      session_ = nullptr;
    }
    if (status != noErr) {
      error = osStatus("creating an H.264 encoder", status);
      return false;
    }
    auto set = [&](CFStringRef key, CFTypeRef value) {
      return VTSessionSetProperty(session_, key, value) == noErr;
    };
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    if (!set(kVTCompressionPropertyKey_ProfileLevel,
             kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel))
      set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel);
    set(kVTCompressionPropertyKey_AverageBitRate, (__bridge CFNumberRef) @(bitRate));
    set(kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFNumberRef) @(fps));
    // Late joiners request keyframes, so periodic ones can be rare (as with scrcpy).
    set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFNumberRef) @(fps * 10));
    set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, (__bridge CFNumberRef) @10);
    set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2);
    set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2);
    set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2);
    // The low-latency encoder (h264.rtvc) does not answer this query
    // (kVTPropertyNotSupportedErr). A session created with the hardware
    // requirement is hardware, since creation would have failed otherwise.
    CFBooleanRef usingHardware = nullptr;
    OSStatus queried = VTSessionCopyProperty(
        session_, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
        kCFAllocatorDefault, &usingHardware);
    hardware_ = queried == noErr ? (usingHardware && CFBooleanGetValue(usingHardware))
                                 : requiredHardware;
    if (usingHardware) CFRelease(usingHardware);
    CFStringRef encoderId = nullptr;
    if (VTSessionCopyProperty(session_, kVTCompressionPropertyKey_EncoderID, kCFAllocatorDefault,
                              &encoderId) == noErr &&
        encoderId) {
      encoderId_ = [(__bridge NSString*)encoderId UTF8String];
      CFRelease(encoderId);
    }
    status = VTCompressionSessionPrepareToEncodeFrames(session_);
    if (status != noErr) {
      invalidate();
      error = osStatus("preparing the H.264 encoder", status);
      return false;
    }
    status = VTPixelTransferSessionCreate(kCFAllocatorDefault, &transfer_);
    if (status != noErr) {
      transfer_ = nullptr;
      invalidate();
      error = osStatus("creating the pixel transfer session", status);
      return false;
    }
    VTSessionSetProperty(transfer_, kVTPixelTransferPropertyKey_ScalingMode,
                         kVTScalingMode_Normal);
    VTSessionSetProperty(transfer_, kVTPixelTransferPropertyKey_DestinationColorPrimaries,
                         kCVImageBufferColorPrimaries_ITU_R_709_2);
    VTSessionSetProperty(transfer_, kVTPixelTransferPropertyKey_DestinationTransferFunction,
                         kCVImageBufferTransferFunction_ITU_R_709_2);
    VTSessionSetProperty(transfer_, kVTPixelTransferPropertyKey_DestinationYCbCrMatrix,
                         kCVImageBufferYCbCrMatrix_ITU_R_709_2);
  }
  width_ = width;
  height_ = height;
  fps_ = fps;
  bitRate_ = bitRate;
  return true;
}

bool H264Encoder::encode(CVPixelBufferRef pixels, uint64_t ptsUs, bool forceKey,
                         std::string& error) {
  if (!session_) {
    error = "encoder is not configured";
    return false;
  }
  CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(session_);
  CVPixelBufferRef input = nullptr;
  if (!pool || CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &input) != kCVReturnSuccess) {
    error = "encoder input pool is exhausted";
    return false;
  }
  // The capture is sRGB; tag it so the transfer converts it with BT.709 terms.
  CVBufferSetAttachment(pixels, kCVImageBufferColorPrimariesKey,
                        kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
  CVBufferSetAttachment(pixels, kCVImageBufferTransferFunctionKey,
                        kCVImageBufferTransferFunction_sRGB, kCVAttachmentMode_ShouldPropagate);
  OSStatus status = VTPixelTransferSessionTransferImage(transfer_, pixels, input);
  if (status != noErr) {
    CVPixelBufferRelease(input);
    error = osStatus("scaling the frame", status);
    return false;
  }
  @autoreleasepool {
    NSDictionary* options = forceKey ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame : @YES} : nil;
    status = VTCompressionSessionEncodeFrame(session_, input, CMTimeMake(int64_t(ptsUs), 1000000),
                                             kCMTimeInvalid, (__bridge CFDictionaryRef)options,
                                             nullptr, nullptr);
  }
  CVPixelBufferRelease(input);
  if (status != noErr) {
    error = osStatus("encoding the frame", status);
    return false;
  }
  return true;
}

void H264Encoder::invalidate() {
  if (session_) {
    VTCompressionSessionCompleteFrames(session_, kCMTimeInvalid);
    VTCompressionSessionInvalidate(session_);
    CFRelease(session_);
    session_ = nullptr;
  }
  if (transfer_) {
    VTPixelTransferSessionInvalidate(transfer_);
    CFRelease(transfer_);
    transfer_ = nullptr;
  }
  width_ = height_ = fps_ = bitRate_ = 0;
  hardware_ = false;
  encoderId_.clear();
}

void H264Encoder::didEncode(void* refcon, void*, OSStatus status, VTEncodeInfoFlags flags,
                            CMSampleBufferRef sample) {
  auto* self = static_cast<H264Encoder*>(refcon);
  if (status != noErr) {
    self->onError_(osStatus("H.264 encoding", status));
    return;
  }
  if (!sample || (flags & kVTEncodeInfo_FrameDropped)) return;
  self->emit(sample);
}

void H264Encoder::emit(CMSampleBufferRef sample) {
  EncodedPacket packet;
  packet.key = isKeyFrame(sample);
  CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
  packet.ptsUs = uint64_t(CMTimeConvertScale(pts, 1000000, kCMTimeRoundingMethod_Default).value);
  CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
  int lengthBytes = 4;
  size_t parameterSets = 0;
  if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nullptr, nullptr,
                                                         &parameterSets, &lengthBytes) != noErr) {
    onError_("encoder output has no H.264 parameter sets");
    return;
  }
  if (packet.key) {
    for (size_t index = 0; index < parameterSets; index++) {
      const uint8_t* set = nullptr;
      size_t size = 0;
      if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, index, &set, &size, nullptr,
                                                             nullptr) != noErr)
        continue;
      appendStartCode(packet.data);
      packet.data.insert(packet.data.end(), set, set + size);
    }
  }
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  size_t total = CMBlockBufferGetDataLength(block);
  std::vector<uint8_t> avcc(total);
  if (CMBlockBufferCopyDataBytes(block, 0, total, avcc.data()) != kCMBlockBufferNoErr) {
    onError_("could not read encoder output");
    return;
  }
  // VideoToolbox emits length-prefixed NAL units; the stream protocol is Annex-B.
  size_t offset = 0;
  while (offset + size_t(lengthBytes) <= total) {
    size_t length = 0;
    for (int i = 0; i < lengthBytes; i++) length = (length << 8) | avcc[offset + i];
    offset += size_t(lengthBytes);
    if (length == 0 || offset + length > total) break;
    appendStartCode(packet.data);
    packet.data.insert(packet.data.end(), avcc.begin() + offset, avcc.begin() + offset + length);
    offset += length;
  }
  if (!packet.data.empty()) sink_(std::move(packet));
}

}  // namespace expo_capture
