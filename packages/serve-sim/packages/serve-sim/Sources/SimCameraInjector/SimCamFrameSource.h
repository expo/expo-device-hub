#pragma once

#import <AVFoundation/AVFoundation.h>

@interface SimCamRegistry : NSObject
+ (instancetype)shared;

- (void)addOutput:(AVCaptureVideoDataOutput *)out
         delegate:(id<AVCaptureVideoDataOutputSampleBufferDelegate>)delegate
            queue:(dispatch_queue_t)queue;
- (void)removeOutput:(AVCaptureVideoDataOutput *)out;
- (void)addPreviewLayer:(AVCaptureVideoPreviewLayer *)layer;
- (void)removePreviewLayer:(AVCaptureVideoPreviewLayer *)layer;
- (BOOL)tracksPreviewLayer:(AVCaptureVideoPreviewLayer *)layer;
- (void)reapplyGravityToLayer:(AVCaptureVideoPreviewLayer *)layer;
- (void)reapplyMirrorToLayers;

// The current frame as a connection at `angle` receives it, or NULL without a frame.
- (CVPixelBufferRef)newPixelBufferAtAngle:(NSInteger)angle CF_RETURNS_RETAINED;

- (NSData *)currentSnapshotJPEGAtQuality:(CGFloat)q;

- (void)startPumpingIfNeeded;
- (void)stopPumping;
@end

void SimCamFrameSourceOpenShmIfRequested(void);

BOOL SimCamFrameSourceIsShmAttached(void);

BOOL SimCamDeviceIsConnected(void);
NSInteger SimCamPoseAngle(void);
void SimCamStartPoseTracking(void);
NSInteger SimCamConnectionAngle(AVCaptureConnection *connection);
void SimCamStartDeviceMonitor(void);
