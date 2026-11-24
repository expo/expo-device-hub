// SPDX-License-Identifier: MIT
// H.264 through VideoToolbox, on the hardware encoder when the Mac has one.
#include "encoder.h"
#include "callback.h"
#import <Foundation/Foundation.h>
#include <CoreVideo/CoreVideo.h>
#include <IOSurface/IOSurface.h>
#include <VideoToolbox/VideoToolbox.h>

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

// Waits, sleeping, until the render thread's GPU copy into the frame's IOSurface
// has completed. A read-only lock waits for pending GPU writes to the surface.
void waitForGpuCopy(CVPixelBufferRef pixels) {
  IOSurfaceRef surface = CVPixelBufferGetIOSurface(pixels);
  if (!surface) return;
  IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
}

// Frames of any size are turned upright by a VTPixelRotationSession when the display
// is rotated, then scaled and converted to NV12 by a VTPixelTransferSession.
class VideoToolboxEncoder final : public H264Encoder {
 public:
  VideoToolboxEncoder(Sink sink, ErrorSink onError)
      : sink_(std::move(sink)), onError_(std::move(onError)) {}
  ~VideoToolboxEncoder() override { invalidate(); }
  VideoToolboxEncoder(const VideoToolboxEncoder&) = delete;
  VideoToolboxEncoder& operator=(const VideoToolboxEncoder&) = delete;

  bool configure(int width, int height, int fps, int bitRate, int rotation,
                 std::string& error) override;
  bool encode(const CapturedFrame& frame, uint64_t ptsUs, bool forceKey,
              std::string& error) override;
  void invalidate() override;
  bool hardware() const override { return hardware_; }
  const std::string& encoderId() const override { return encoderId_; }

 private:
  static void didEncode(void* refcon, void* frameRefcon, OSStatus status, VTEncodeInfoFlags flags,
                        CMSampleBufferRef sample);
  void emit(CMSampleBufferRef sample);
  CVPixelBufferRef rotate(CVPixelBufferRef pixels, std::string& error);

  Sink sink_;
  ErrorSink onError_;
  VTCompressionSessionRef session_ = nullptr;
  VTPixelTransferSessionRef transfer_ = nullptr;
  VTPixelRotationSessionRef rotation_ = nullptr;  // Only when the display is rotated.
  CVPixelBufferPoolRef rotatedPool_ = nullptr;
  int rotatedWidth_ = 0, rotatedHeight_ = 0;
  int quarterTurns_ = 0;
  bool hardware_ = false;
  std::string encoderId_;
};

}  // namespace

std::unique_ptr<H264Encoder> createH264Encoder(H264Encoder::Sink sink,
                                               H264Encoder::ErrorSink onError) {
  return std::make_unique<VideoToolboxEncoder>(std::move(sink), std::move(onError));
}

// VideoToolbox is part of macOS, and a Mac without a hardware encoder gets its software one.
std::string h264EncoderProblem() { return {}; }

bool VideoToolboxEncoder::configure(int width, int height, int fps, int bitRate, int rotation,
                                    std::string& error) {
  invalidate();
  if (rotation < 0 || rotation > 3) {
    error = "invalid display rotation";
    return false;
  }
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
          &VideoToolboxEncoder::didEncode, this, &session_);
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
    if (rotation != 0) {
      status = VTPixelRotationSessionCreate(kCFAllocatorDefault, &rotation_);
      if (status != noErr) {
        rotation_ = nullptr;
        invalidate();
        error = osStatus("creating the pixel rotation session", status);
        return false;
      }
      // @ref LLP 0020#rotation — rotation N drew the picture N quarter turns clockwise
      CFStringRef turn = rotation == 1   ? kVTRotation_CCW90
                         : rotation == 2 ? kVTRotation_180
                                         : kVTRotation_CW90;
      status = VTSessionSetProperty(rotation_, kVTPixelRotationPropertyKey_Rotation, turn);
      if (status != noErr) {
        invalidate();
        error = osStatus("setting the pixel rotation", status);
        return false;
      }
      quarterTurns_ = rotation;
    }
  }
  return true;
}

// Turns a captured frame upright into a pool buffer; the caller releases it.
CVPixelBufferRef VideoToolboxEncoder::rotate(CVPixelBufferRef pixels, std::string& error) {
  int width = int(CVPixelBufferGetWidth(pixels)), height = int(CVPixelBufferGetHeight(pixels));
  if (quarterTurns_ % 2) std::swap(width, height);
  if (!rotatedPool_ || width != rotatedWidth_ || height != rotatedHeight_) {
    if (rotatedPool_) CVPixelBufferPoolRelease(rotatedPool_);
    rotatedPool_ = nullptr;
    @autoreleasepool {
      NSDictionary* attributes = @{
        (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferWidthKey : @(width),
        (id)kCVPixelBufferHeightKey : @(height),
        (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
      };
      if (CVPixelBufferPoolCreate(kCFAllocatorDefault, nullptr, (__bridge CFDictionaryRef)attributes,
                                  &rotatedPool_) != kCVReturnSuccess) {
        rotatedPool_ = nullptr;
        error = "cannot create the rotation buffer pool";
        return nullptr;
      }
    }
    rotatedWidth_ = width;
    rotatedHeight_ = height;
  }
  CVPixelBufferRef rotated = nullptr;
  if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, rotatedPool_, &rotated) !=
      kCVReturnSuccess) {
    error = "rotation buffer pool is exhausted";
    return nullptr;
  }
  OSStatus status = VTPixelRotationSessionRotateImage(rotation_, pixels, rotated);
  if (status != noErr) {
    CVPixelBufferRelease(rotated);
    error = osStatus("turning the frame upright", status);
    return nullptr;
  }
  return rotated;
}

bool VideoToolboxEncoder::encode(const CapturedFrame& frame, uint64_t ptsUs, bool forceKey,
                                 std::string& error) {
  if (!session_) {
    error = "encoder is not configured";
    return false;
  }
  CVPixelBufferRef pixels = frame.pixels.get();
  // @ref LLP 0020#synchronization — the render thread flushed the copy; wait for it here
  if (frame.path == FramePath::Gpu) waitForGpuCopy(pixels);
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
  CVPixelBufferRef upright = pixels;
  if (rotation_) {
    upright = rotate(pixels, error);
    if (!upright) {
      CVPixelBufferRelease(input);
      return false;
    }
    CVBufferPropagateAttachments(pixels, upright);
  }
  OSStatus status = VTPixelTransferSessionTransferImage(transfer_, upright, input);
  if (upright != pixels) CVPixelBufferRelease(upright);
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

void VideoToolboxEncoder::invalidate() {
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
  if (rotation_) {
    VTPixelRotationSessionInvalidate(rotation_);
    CFRelease(rotation_);
    rotation_ = nullptr;
  }
  if (rotatedPool_) {
    CVPixelBufferPoolRelease(rotatedPool_);
    rotatedPool_ = nullptr;
  }
  rotatedWidth_ = rotatedHeight_ = 0;
  quarterTurns_ = 0;
  hardware_ = false;
  encoderId_.clear();
}

void VideoToolboxEncoder::didEncode(void* refcon, void*, OSStatus status, VTEncodeInfoFlags flags,
                            CMSampleBufferRef sample) {
  auto* self = static_cast<VideoToolboxEncoder*>(refcon);
  guardCallback("VideoToolbox output failed", [&] {
    if (status != noErr) {
      self->onError_(osStatus("H.264 encoding", status));
      return;
    }
    if (!sample || (flags & kVTEncodeInfo_FrameDropped)) return;
    self->emit(sample);
  });
}

void VideoToolboxEncoder::emit(CMSampleBufferRef sample) {
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
