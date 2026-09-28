#import "SimCamFrameSource.h"
#import "SimCamFakes.h"
#import "SimCamLog.h"
#import "SimCamSwizzles.h"
#include "include/SimCamShared.h"

#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurfaceRef.h>
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <stdatomic.h>
#include <errno.h>
#include <signal.h>
#include <string.h>

#pragma mark - Source globals

static const double kFrameRate = 30.0;

static SimCamShmHeader *gShmHeader = NULL;
static SimCamSurfaceTable *gSurfaceTable = NULL;
static SimCamContentRect *gContentRects = NULL;       // NULL with a helper from before the table
static size_t gShmMapSize = 0;
static IOSurfaceRef gSurfaces[SIMCAM_SURFACE_RING];  // resolved from global IDs
static uint64_t gLastSeenSeq = 0;
static _Atomic bool gConnected = false;
static _Atomic uint64_t gConnectionGeneration = 0;

BOOL SimCamDeviceIsConnected(void) {
    return atomic_load_explicit(&gConnected, memory_order_acquire);
}

#pragma mark - Last-frame cache

// The newest canvas and where the upright source sits in it (top-left origin).
static CVPixelBufferRef gLastFramePB = NULL;
static CGRect gLastFrameContent;
static NSLock *gFrameCacheLock = nil;
static dispatch_once_t gFrameCacheOnce;

static inline NSLock *SimCamFrameCacheLock(void) {
    dispatch_once(&gFrameCacheOnce, ^{ gFrameCacheLock = [NSLock new]; });
    return gFrameCacheLock;
}

static void SimCamCacheFrame(CVPixelBufferRef pb, CGRect content) {
    if (!pb) return;
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    CVPixelBufferRef oldPB = gLastFramePB;
    gLastFramePB = (CVPixelBufferRef)CFRetain(pb);
    gLastFrameContent = content;
    [lock unlock];
    if (oldPB) CVPixelBufferRelease(oldPB);
}

static CVPixelBufferRef SimCamAcquireCachedPB(CGRect *content) CF_RETURNS_RETAINED {
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    CVPixelBufferRef pb = gLastFramePB;
    if (pb) CFRetain(pb);
    *content = gLastFrameContent;
    [lock unlock];
    return pb;
}

#pragma mark - Device pose

// The connection angle at which the scene is upright for the device's current pose. A sensor is
// fixed to the device, so rotating the simulator turns the scene in every connection's frames.
static const NSInteger kPortraitAngle = 90;
static _Atomic NSInteger gPoseAngle = kPortraitAngle;

static NSInteger SimCamPoseAngleForOrientation(UIDeviceOrientation orientation) {
    switch (orientation) {
        case UIDeviceOrientationPortrait:           return kPortraitAngle;
        case UIDeviceOrientationPortraitUpsideDown: return 270;
        case UIDeviceOrientationLandscapeLeft:      return 0;
        case UIDeviceOrientationLandscapeRight:     return 180;
        default:                                    return -1;
    }
}

NSInteger SimCamPoseAngle(void) {
    return atomic_load(&gPoseAngle);
}

// Face up, face down and unknown keep the last pose.
void SimCamStartPoseTracking(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        void (^start)(void) = ^{
            UIDevice *device = UIDevice.currentDevice;
            [device beginGeneratingDeviceOrientationNotifications];
            void (^update)(void) = ^{
                NSInteger angle = SimCamPoseAngleForOrientation(device.orientation);
                if (angle >= 0) atomic_store(&gPoseAngle, angle);
            };
            update();
            [NSNotificationCenter.defaultCenter addObserverForName:UIDeviceOrientationDidChangeNotification
                                                            object:nil
                                                             queue:NSOperationQueue.mainQueue
                                                        usingBlock:^(__unused NSNotification *note) { update(); }];
        };
        if (NSThread.isMainThread) start();
        else dispatch_async(dispatch_get_main_queue(), start);
    });
}

#pragma mark - Oriented frames

static NSInteger SimCamRightAngle(CGFloat degrees) {
    NSInteger quarter = (NSInteger)lround(degrees / 90.0);
    return ((quarter % 4) + 4) % 4 * 90;
}

NSInteger SimCamConnectionAngle(AVCaptureConnection *connection) {
    if (!connection) return kPortraitAngle;
    if (@available(iOS 17.0, *)) return SimCamRightAngle(connection.videoRotationAngle);
    switch (connection.videoOrientation) {
        case AVCaptureVideoOrientationPortraitUpsideDown: return 270;
        case AVCaptureVideoOrientationLandscapeRight:     return 0;
        case AVCaptureVideoOrientationLandscapeLeft:      return 180;
        default:                                          return kPortraitAngle;
    }
}

// What a connection at `angle` receives: the source fitted into the pose's upright frame with black
// bars, then turned clockwise by angle minus the pose, like a sensor fixed to the device. Without a
// canvas it is a gray no-signal frame of the same shape.
static CIImage *SimCamOrientedImage(CVPixelBufferRef canvas, CGRect content, NSInteger angle) {
    NSInteger pose = SimCamPoseAngle();
    BOOL portrait = pose == kPortraitAngle || pose == kPortraitAngle + 180;
    CGRect upright = CGRectMake(0, 0, portrait ? SIMCAM_FRAME_SHORT : SIMCAM_FRAME_LONG,
                                portrait ? SIMCAM_FRAME_LONG : SIMCAM_FRAME_SHORT);
    CIImage *image;
    if (canvas) {
        CIImage *whole = [CIImage imageWithCVPixelBuffer:canvas];
        CGFloat height = whole.extent.size.height;
        // Core Image is y-up, the helper's rect is top-left.
        CGRect source = content.size.width > 0
            ? CGRectMake(content.origin.x, height - CGRectGetMaxY(content), content.size.width, content.size.height)
            : whole.extent;
        CGFloat scale = MIN(upright.size.width / source.size.width, upright.size.height / source.size.height);
        CGAffineTransform place = CGAffineTransformMakeTranslation(-source.origin.x, -source.origin.y);
        place = CGAffineTransformConcat(place, CGAffineTransformMakeScale(scale, scale));
        place = CGAffineTransformConcat(place, CGAffineTransformMakeTranslation(
            (upright.size.width - source.size.width * scale) / 2, (upright.size.height - source.size.height * scale) / 2));
        CIImage *fitted = [[whole imageByCroppingToRect:source] imageByApplyingTransform:place];
        image = [fitted imageByCompositingOverImage:[CIImage imageWithColor:CIColor.blackColor]];
    } else {
        image = [CIImage imageWithColor:[CIColor colorWithRed:0x18 / 255.0 green:0x18 / 255.0 blue:0x18 / 255.0]];
    }
    image = [image imageByCroppingToRect:upright];
    NSInteger turn = ((angle - pose) % 360 + 360) % 360;
    if (turn == 0) return image;
    // Clockwise in the frame is a negative rotation in Core Image's y-up space.
    image = [image imageByApplyingTransform:CGAffineTransformMakeRotation(-turn * M_PI / 180.0)];
    CGPoint origin = image.extent.origin;
    return [image imageByApplyingTransform:CGAffineTransformMakeTranslation(-round(origin.x), -round(origin.y))];
}

static CIContext *SimCamOrientContext(void) {
    static CIContext *ctx;
    static dispatch_once_t once;
    // No color management, so frames keep the helper's exact pixel values.
    dispatch_once(&once, ^{
        ctx = [CIContext contextWithOptions:@{
            kCIContextWorkingColorSpace: NSNull.null,
            kCIContextOutputColorSpace: NSNull.null,
        }];
    });
    return ctx;
}

static CVPixelBufferRef SimCamRenderOriented(CVPixelBufferRef canvas, CGRect content, NSInteger angle) CF_RETURNS_RETAINED {
    CIImage *image = SimCamOrientedImage(canvas, content, angle);
    size_t width = (size_t)lround(image.extent.size.width), height = (size_t)lround(image.extent.size.height);
    static CVPixelBufferPoolRef pools[2];
    static NSLock *poolLock;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ poolLock = [NSLock new]; });
    // Frames come in two shapes, one pool each.
    NSUInteger slot = width > height ? 1 : 0;
    [poolLock lock];
    if (!pools[slot]) {
        NSDictionary *attrs = @{
            (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
            (id)kCVPixelBufferWidthKey: @(width),
            (id)kCVPixelBufferHeightKey: @(height),
            (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
        };
        CVPixelBufferPoolCreate(kCFAllocatorDefault, NULL, (__bridge CFDictionaryRef)attrs, &pools[slot]);
    }
    CVPixelBufferPoolRef pool = pools[slot];
    [poolLock unlock];
    CVPixelBufferRef out = NULL;
    // Readers that hold frames too long lose the next ones instead of growing the pool.
    NSDictionary *limit = @{ (id)kCVPixelBufferPoolAllocationThresholdKey: @8 };
    if (!pool || CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool,
            (__bridge CFDictionaryRef)limit, &out) != kCVReturnSuccess) return NULL;
    [SimCamOrientContext() render:image toCVPixelBuffer:out bounds:CGRectMake(0, 0, width, height) colorSpace:nil];
    return out;
}

static CGImageRef SimCamCreateOrientedCGImage(CVPixelBufferRef canvas, CGRect content, NSInteger angle) CF_RETURNS_RETAINED {
    CIImage *image = SimCamOrientedImage(canvas, content, angle);
    CGRect bounds = CGRectMake(0, 0, lround(image.extent.size.width), lround(image.extent.size.height));
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGImageRef cg = [SimCamOrientContext() createCGImage:image fromRect:bounds format:kCIFormatBGRA8 colorSpace:space];
    CGColorSpaceRelease(space);
    return cg;
}

// Frames rendered from the current canvas and pose, one per angle, so ticks without a new frame
// reuse them. A cached buffer stays out of the pool, so no reader sees it rewritten.
static NSLock *gOrientedLock;
static id gOrientedCanvas;
static CGRect gOrientedContent;
static NSInteger gOrientedPose;
static NSMutableDictionary<NSNumber *, id> *gOrientedBuffers;
static NSMutableDictionary<NSNumber *, id> *gOrientedImages;

static id SimCamCachedOriented(CVPixelBufferRef canvas, CGRect content, NSInteger angle, BOOL image) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        gOrientedLock = [NSLock new];
        gOrientedBuffers = [NSMutableDictionary new];
        gOrientedImages = [NSMutableDictionary new];
    });
    NSInteger pose = SimCamPoseAngle();
    NSMutableDictionary<NSNumber *, id> *cache = image ? gOrientedImages : gOrientedBuffers;
    [gOrientedLock lock];
    // A tick that outlived a disconnect must not keep a released ring surface alive.
    BOOL connected = SimCamDeviceIsConnected();
    if (connected && ((__bridge CVPixelBufferRef)gOrientedCanvas != canvas || gOrientedPose != pose ||
                      !CGRectEqualToRect(gOrientedContent, content))) {
        gOrientedCanvas = (__bridge id)canvas;
        gOrientedContent = content;
        gOrientedPose = pose;
        [gOrientedBuffers removeAllObjects];
        [gOrientedImages removeAllObjects];
    }
    id cached = connected ? cache[@(angle)] : nil;
    [gOrientedLock unlock];
    if (cached) return cached;
    id made = image ? CFBridgingRelease(SimCamCreateOrientedCGImage(canvas, content, angle))
                    : CFBridgingRelease(SimCamRenderOriented(canvas, content, angle));
    if (!made) return nil;
    [gOrientedLock lock];
    if (SimCamDeviceIsConnected() && (__bridge CVPixelBufferRef)gOrientedCanvas == canvas && gOrientedPose == pose) {
        cache[@(angle)] = made;
    }
    [gOrientedLock unlock];
    return made;
}

static CMSampleBufferRef SimCamCreateSampleBuffer(CVPixelBufferRef pb, CMTime pts) CF_RETURNS_RETAINED {
    CMVideoFormatDescriptionRef fd = NULL;
    CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pb, &fd);
    if (!fd) return NULL;
    CMSampleTimingInfo timing = {
        .duration = CMTimeMake(1, (int32_t)kFrameRate),
        .presentationTimeStamp = pts,
        .decodeTimeStamp = kCMTimeInvalid,
    };
    CMSampleBufferRef sb = NULL;
    CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, pb, true, NULL, NULL, fd, &timing, &sb);
    CFRelease(fd);
    return sb;
}

#pragma mark - Output delegate registry

@implementation SimCamRegistry {
    NSMutableArray *_entries;
    NSHashTable<AVCaptureVideoPreviewLayer *> *_layers;
    dispatch_source_t _timer;
    dispatch_queue_t _timerQueue;
    NSLock *_lock;
}

+ (instancetype)shared {
    static SimCamRegistry *s; static dispatch_once_t o;
    dispatch_once(&o, ^{ s = [SimCamRegistry new]; });
    return s;
}

- (instancetype)init {
    if ((self = [super init])) {
        _entries = [NSMutableArray new];
        _layers = [NSHashTable weakObjectsHashTable];
        _timerQueue = dispatch_queue_create("dev.servesim.simcam.pump", DISPATCH_QUEUE_SERIAL);
        _lock = [NSLock new];
    }
    return self;
}

- (void)addOutput:(AVCaptureVideoDataOutput *)out
         delegate:(id<AVCaptureVideoDataOutputSampleBufferDelegate>)delegate
            queue:(dispatch_queue_t)queue {
    if (!out || !delegate) return;
    SimCamWeakRef *ref = [SimCamWeakRef new];
    ref.target = delegate;
    [_lock lock];
    NSMutableIndexSet *toRemove = [NSMutableIndexSet new];
    [_entries enumerateObjectsUsingBlock:^(NSDictionary *e, NSUInteger i, BOOL *stop) {
        if (e[@"out"] == out) [toRemove addIndex:i];
    }];
    [_entries removeObjectsAtIndexes:toRemove];
    [_entries addObject:@{
        @"out": out,
        @"del": ref,
        @"queue": queue ?: dispatch_get_main_queue(),
    }];
    NSUInteger entryCount = _entries.count;
    [_lock unlock];
    simcam_log(@"addOutput delegate=%p out=%p queue=%p pos=%d (entries=%lu, replaced=%lu)",
        delegate, out, queue, (int)SimCamPositionOf(out),
        (unsigned long)entryCount, (unsigned long)toRemove.count);

    uint64_t generation = atomic_load(&gConnectionGeneration);
    CGRect content;
    CVPixelBufferRef cached = SimCamOutputSessionIsRunning(out) ? SimCamAcquireCachedPB(&content) : NULL;
    if (cached) {
        id oriented = SimCamCachedOriented(cached, content, SimCamConnectionAngle(SimCamFakeConnectionForOutput(out)), NO);
        CMSampleBufferRef sb = oriented
            ? SimCamCreateSampleBuffer((__bridge CVPixelBufferRef)oriented, CMTimeMake(0, (int32_t)kFrameRate)) : NULL;
        if (sb) {
            AVCaptureVideoDataOutput *outRef = out;
            dispatch_queue_t q = queue ?: dispatch_get_main_queue();
            __weak SimCamWeakRef *weakRef = ref;
            dispatch_async(q, ^{
                id<AVCaptureVideoDataOutputSampleBufferDelegate> del = weakRef.target;
                if (SimCamDeviceIsConnected() && generation == atomic_load(&gConnectionGeneration) &&
                    SimCamOutputSessionIsRunning(outRef) && del &&
                    [del respondsToSelector:@selector(captureOutput:didOutputSampleBuffer:fromConnection:)]) {
                    AVCaptureConnection *conn = SimCamFakeConnectionForOutput(outRef);
                    [del captureOutput:outRef didOutputSampleBuffer:sb fromConnection:conn];
                }
                CFRelease(sb);
            });
        }
        CVPixelBufferRelease(cached);
    }

    [self startPumpingIfNeeded];
}

- (void)removeOutput:(AVCaptureVideoDataOutput *)out {
    [_lock lock];
    NSMutableIndexSet *toRemove = [NSMutableIndexSet new];
    [_entries enumerateObjectsUsingBlock:^(NSDictionary *e, NSUInteger i, BOOL *stop) {
        if (e[@"out"] == out) [toRemove addIndex:i];
    }];
    [_entries removeObjectsAtIndexes:toRemove];
    [_lock unlock];
}

// UIImagePickerController's content layer is a plain CALayer with no videoGravity.
static CALayerContentsGravity SimCamContentsGravity(CALayer *layer) {
    if (![layer isKindOfClass:[AVCaptureVideoPreviewLayer class]]) return kCAGravityResizeAspectFill;
    AVLayerVideoGravity gravity = ((AVCaptureVideoPreviewLayer *)layer).videoGravity;
    if ([gravity isEqualToString:AVLayerVideoGravityResizeAspectFill]) return kCAGravityResizeAspectFill;
    if ([gravity isEqualToString:AVLayerVideoGravityResize]) return kCAGravityResize;
    return kCAGravityResizeAspect;
}

- (void)addPreviewLayer:(AVCaptureVideoPreviewLayer *)layer {
    if (!layer) return;
    [_lock lock];
    [_layers addObject:layer];
    [_lock unlock];
    BOOL mirror = SimCamShouldMirror(SimCamPositionOf(layer));
    uint64_t generation = atomic_load(&gConnectionGeneration);
    CGRect content;
    CVPixelBufferRef cached = SimCamAcquireCachedPB(&content);
    id primedImage = cached ? SimCamCachedOriented(cached, content,
        SimCamConnectionAngle(SimCamFakeConnectionForPreviewLayer(layer)), YES) : nil;
    CGImageRef primed = primedImage ? CGImageRetain((__bridge CGImageRef)primedImage) : NULL;
    if (cached) CVPixelBufferRelease(cached);
    dispatch_async(dispatch_get_main_queue(), ^{
        layer.contentsGravity = SimCamContentsGravity(layer);
        if (mirror) layer.transform = CATransform3DMakeScale(-1.f, 1.f, 1.f);
        if (primed) {
            if (SimCamDeviceIsConnected() && generation == atomic_load(&gConnectionGeneration))
                layer.contents = (__bridge id)primed;
            CGImageRelease(primed);
        }
    });
    simcam_log(@"addPreviewLayer %p (mirror=%d, primed=%s, shm=%s)",
        layer, (int)mirror, primed ? "yes" : "no", SimCamDeviceIsConnected() ? "yes" : "no");
    [self startPumpingIfNeeded];
}

- (void)removePreviewLayer:(AVCaptureVideoPreviewLayer *)layer {
    [_lock lock];
    BOOL tracked = [_layers containsObject:layer];
    [_layers removeObject:layer];
    [_lock unlock];
    if (!tracked) return;
    dispatch_async(dispatch_get_main_queue(), ^{ layer.contents = nil; });
}

- (BOOL)tracksPreviewLayer:(AVCaptureVideoPreviewLayer *)layer {
    [_lock lock];
    BOOL tracked = [_layers containsObject:layer];
    [_lock unlock];
    return tracked;
}

- (void)reapplyGravityToLayer:(AVCaptureVideoPreviewLayer *)layer {
    if (![self tracksPreviewLayer:layer]) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        layer.contentsGravity = SimCamContentsGravity(layer);
    });
}

- (void)reapplyMirrorToLayers {
    NSArray *layerSnapshot;
    [_lock lock]; layerSnapshot = _layers.allObjects; [_lock unlock];
    if (layerSnapshot.count == 0) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        for (AVCaptureVideoPreviewLayer *l in layerSnapshot) {
            BOOL m = SimCamShouldMirror(SimCamPositionOf(l));
            l.transform = m ? CATransform3DMakeScale(-1.f, 1.f, 1.f)
                            : CATransform3DIdentity;
        }
        [CATransaction commit];
    });
}

- (void)disconnectPreviewLayers {
    [_lock lock];
    NSArray *layers = _layers.allObjects;
    [_lock unlock];
    for (AVCaptureVideoPreviewLayer *layer in layers) layer.contents = nil;
}

- (void)pushFrameToLayers:(CVPixelBufferRef)canvas content:(CGRect)content generation:(uint64_t)generation {
    NSArray *layerSnapshot;
    [_lock lock]; layerSnapshot = _layers.allObjects; [_lock unlock];
    if (layerSnapshot.count == 0) return;
    NSMapTable<AVCaptureVideoPreviewLayer *, id> *images = [NSMapTable weakToStrongObjectsMapTable];
    for (AVCaptureVideoPreviewLayer *l in layerSnapshot) {
        id image = SimCamCachedOriented(canvas, content, SimCamConnectionAngle(SimCamFakeConnectionForPreviewLayer(l)), YES);
        if (image) [images setObject:image forKey:l];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        // Only layers still tracked get the image, so one removed meanwhile stays cleared.
        for (AVCaptureVideoPreviewLayer *l in images) {
            if (!SimCamDeviceIsConnected() || generation != atomic_load(&gConnectionGeneration)) continue;
            if ([self tracksPreviewLayer:l]) l.contents = [images objectForKey:l];
        }
    });
}

- (CVPixelBufferRef)newPixelBufferFromSurfaceWithContent:(CGRect *)content CF_RETURNS_RETAINED {
    return [self newPixelBufferFromSurfaceForceFresh:NO content:content];
}

// Wrap the latest shared IOSurface as a CVPixelBuffer — zero copy. Holding the
// pixel buffer keeps the surface in use, so the host writer renders into a
// different ring slot until we release it.
- (CVPixelBufferRef)newPixelBufferFromSurfaceForceFresh:(BOOL)force content:(CGRect *)content CF_RETURNS_RETAINED {
    @synchronized([SimCamRegistry class]) {
        if (!SimCamDeviceIsConnected()) return NULL;
        if (!gShmHeader || !gSurfaceTable) return NULL;
        if (gShmHeader->magic != SIMCAM_SHM_MAGIC) return NULL;
        uint64_t seqA = atomic_load_explicit(&gShmHeader->frameSeq, memory_order_acquire);
        if (seqA == 0) return NULL;
        if (!force && seqA == gLastSeenSeq) return NULL;

        uint32_t count = gSurfaceTable->surfaceCount;
        if (count == 0 || count > SIMCAM_SURFACE_RING) return NULL;
        uint32_t idx = gSurfaceTable->latestIndex;
        if (idx >= count) return NULL;
        IOSurfaceRef surface = gSurfaces[idx];
        if (!surface) {
            simcam_log(@"missing IOSurface at latest index %u/%u", idx, count);
            return NULL;
        }

        CVPixelBufferRef pb = NULL;
        NSDictionary *attrs = @{ (id)kCVPixelBufferIOSurfacePropertiesKey: @{} };
        CVReturn r = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface,
            (__bridge CFDictionaryRef)attrs, &pb);
        if (r != kCVReturnSuccess || !pb) return NULL;
        SimCamContentRect rect = gContentRects ? gContentRects[idx] : (SimCamContentRect){ 0, 0, 0, 0 };
        *content = CGRectMake(rect.x, rect.y, rect.width, rect.height);

        uint64_t seqB = atomic_load_explicit(&gShmHeader->frameSeq, memory_order_acquire);
        if (!force && seqA != seqB) {
            CVPixelBufferRelease(pb);
            return NULL;
        }
        gLastSeenSeq = seqA;
        return pb;
    }
}

- (CVPixelBufferRef)newPixelBufferAtAngle:(NSInteger)angle CF_RETURNS_RETAINED {
    if (!SimCamDeviceIsConnected()) return NULL;
    CGRect content;
    CVPixelBufferRef canvas = [self newPixelBufferFromSurfaceForceFresh:YES content:&content];
    if (!canvas) return NULL;
    CVPixelBufferRef oriented = SimCamRenderOriented(canvas, content, angle);
    CVPixelBufferRelease(canvas);
    return oriented;
}

- (NSData *)currentSnapshotJPEGAtQuality:(CGFloat)q {
    CVPixelBufferRef pb = [self newPixelBufferAtAngle:SimCamPoseAngle()];
    if (!pb) return nil;
    CIImage *ci = [CIImage imageWithCVPixelBuffer:pb];
    if (SimCamShouldMirror(AVCaptureDevicePositionFront)) {
        ci = [ci imageByApplyingOrientation:kCGImagePropertyOrientationUpMirrored];
    }
    static CIContext *ctx = nil; static dispatch_once_t once;
    dispatch_once(&once, ^{ ctx = [CIContext contextWithOptions:nil]; });
    CGImageRef cg = [ctx createCGImage:ci fromRect:ci.extent];
    CVPixelBufferRelease(pb);
    if (!cg) return nil;
    UIImage *ui = [UIImage imageWithCGImage:cg];
    NSData *data = UIImageJPEGRepresentation(ui, q);
    CGImageRelease(cg);
    return data;
}

// The newest canvas, or the last one when the helper has nothing new. NULL means no signal yet.
- (CVPixelBufferRef)newCanvasWithContent:(CGRect *)content CF_RETURNS_RETAINED {
    @synchronized([SimCamRegistry class]) {
        if (!SimCamDeviceIsConnected()) return NULL;
        CVPixelBufferRef pb = [self newPixelBufferFromSurfaceWithContent:content];
        if (pb) {
            SimCamCacheFrame(pb, *content);
            return pb;
        }
        pb = SimCamAcquireCachedPB(content);
        if (!pb) {
            static dispatch_once_t logOnce;
            dispatch_once(&logOnce, ^{
                simcam_log(@"no-signal fallback: shm=%@ frameSeq=%llu cache=empty",
                    gShmHeader ? @"attached" : @"unattached",
                    (unsigned long long)(gShmHeader ? atomic_load_explicit(&gShmHeader->frameSeq, memory_order_acquire) : 0));
            });
        }
        return pb;
    }
}

- (void)startPumpingIfNeeded {
    [_lock lock];
    if (_timer) { [_lock unlock]; return; }
    _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _timerQueue);
    uint64_t intervalNs = (uint64_t)(NSEC_PER_SEC / kFrameRate);
    dispatch_source_set_timer(_timer, dispatch_time(DISPATCH_TIME_NOW, 0), intervalNs, intervalNs / 10);
    __weak __typeof(self) weakSelf = self;
    __block int64_t frameIdx = 0;
    __block uint8_t lastMirrorByte = SIMCAM_MIRROR_UNSET;
    dispatch_source_set_event_handler(_timer, ^{
        __strong __typeof(weakSelf) self = weakSelf; if (!self) return;
        @synchronized([SimCamRegistry class]) {
        if (!SimCamDeviceIsConnected()) return;
        if (gShmHeader) {
            uint8_t m = gShmHeader->mirrorMode;
            if (m != lastMirrorByte) {
                lastMirrorByte = m;
                if (m != SIMCAM_MIRROR_UNSET) {
                    SimCamMirrorMode prev = SimCamGetMirrorMode();
                    SimCamMirrorMode next = prev;
                    if (m == SIMCAM_MIRROR_ON)       next = SimCamMirrorForceOn;
                    else if (m == SIMCAM_MIRROR_OFF) next = SimCamMirrorForceOff;
                    else                              next = SimCamMirrorAuto;
                    if (prev != next) {
                        SimCamSetMirrorMode(next);
                        simcam_log(@"mirror mode → %d (from shm)", (int)next);
                        [self reapplyMirrorToLayers];
                    }
                }
            }
        }
        }
        uint64_t generation = atomic_load(&gConnectionGeneration);
        if (!SimCamDeviceIsConnected()) return;
        CMTime pts = CMTimeMake(frameIdx++, (int32_t)kFrameRate);
        CGRect content = CGRectZero;
        CVPixelBufferRef canvas = [self newCanvasWithContent:&content];
        [self pushFrameToLayers:canvas content:content generation:generation];
        NSArray *snapshot;
        [self->_lock lock]; snapshot = [self->_entries copy]; [self->_lock unlock];
        BOOL anyDead = NO;
        // Render once per angle.
        NSMutableDictionary<NSNumber *, id> *samples = [NSMutableDictionary new];
        for (NSDictionary *e in snapshot) {
            AVCaptureVideoDataOutput *out = e[@"out"];
            SimCamWeakRef *ref = e[@"del"];
            id<AVCaptureVideoDataOutputSampleBufferDelegate> del = ref.target;
            dispatch_queue_t q = e[@"queue"];
            if (!del) { anyDead = YES; continue; }
            if (!out || !SimCamOutputSessionIsRunning(out)) continue;
            NSNumber *angle = @(SimCamConnectionAngle(SimCamFakeConnectionForOutput(out)));
            if (!samples[angle]) {
                id oriented = SimCamCachedOriented(canvas, content, angle.integerValue, NO);
                CMSampleBufferRef made = oriented ? SimCamCreateSampleBuffer((__bridge CVPixelBufferRef)oriented, pts) : NULL;
                if (!made) continue;
                samples[angle] = CFBridgingRelease(made);
            }
            CMSampleBufferRef sb = (__bridge CMSampleBufferRef)samples[angle];
            CFRetain(sb);
            __weak SimCamWeakRef *weakRef = ref;
            dispatch_async(q, ^{
                id<AVCaptureVideoDataOutputSampleBufferDelegate> d = weakRef.target;
                if (SimCamDeviceIsConnected() && generation == atomic_load(&gConnectionGeneration) &&
                    SimCamOutputSessionIsRunning(out) && d &&
                    [d respondsToSelector:@selector(captureOutput:didOutputSampleBuffer:fromConnection:)]) {
                    AVCaptureConnection *conn = SimCamFakeConnectionForOutput(out);
                    [d captureOutput:out didOutputSampleBuffer:sb fromConnection:conn];
                }
                CFRelease(sb);
            });
        }
        if (anyDead) {
            [self->_lock lock];
            NSMutableIndexSet *idx = [NSMutableIndexSet new];
            [self->_entries enumerateObjectsUsingBlock:^(NSDictionary *entry, NSUInteger i, BOOL *stop) {
                SimCamWeakRef *r = entry[@"del"];
                if (!r.target) [idx addIndex:i];
            }];
            if (idx.count) {
                NSUInteger before = self->_entries.count;
                [self->_entries removeObjectsAtIndexes:idx];
                simcam_log(@"pump: pruned %lu dead delegate entr%@ (%lu→%lu)",
                    (unsigned long)idx.count, idx.count == 1 ? @"y" : @"ies",
                    (unsigned long)before, (unsigned long)self->_entries.count);
            }
            [self->_lock unlock];
        }
        if (canvas) CVPixelBufferRelease(canvas);
    });
    dispatch_resume(_timer);
    [_lock unlock];
    simcam_log(@"started frame pump @ %.0f fps", kFrameRate);
}

- (void)stopPumping {
    [_lock lock];
    if (_timer) { dispatch_source_cancel(_timer); _timer = NULL; }
    [_lock unlock];
}
@end

#pragma mark - Source loaders

BOOL SimCamFrameSourceIsShmAttached(void) {
    return SimCamDeviceIsConnected();
}

// A helper that died before serve-sim reaped it still passes kill(pid, 0).
static BOOL SimCamOwnerIsAlive(pid_t pid) {
    if (pid == 0 || kill(pid, 0) != 0) return NO;
    int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
    struct kinfo_proc info;
    size_t size = sizeof(info);
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size == 0) return YES;
    return info.kp_proc.p_stat != SZOMB;
}

void SimCamFrameSourceOpenShmIfRequested(void) {
    const char *shmName = getenv("SIMCAM_SHM_NAME");
    if (!shmName || !*shmName) return;
    int fd = shm_open(shmName, O_RDONLY, 0);
    if (fd < 0) return;
    size_t size = (size_t)SimCamControlSize();
    struct stat st;
    if (fstat(fd, &st) < 0 || (size_t)st.st_size < size) {
        simcam_log(@"shm fstat failed or too small");
        close(fd);
        return;
    }
    BOOL hasContentRects = (size_t)st.st_size >= (size_t)SimCamControlSizeWithContent();
    if (hasContentRects) size = (size_t)SimCamControlSizeWithContent();
    void *map = mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);
    if (map == MAP_FAILED) {
        simcam_log(@"shm mmap failed: %s", strerror(errno));
        return;
    }
    SimCamShmHeader *hdr = (SimCamShmHeader *)map;
    if (hdr->magic != SIMCAM_SHM_MAGIC || hdr->version != 3 ||
        !atomic_load_explicit(&hdr->active, memory_order_acquire) ||
        !SimCamOwnerIsAlive((pid_t)hdr->ownerPid)) {
        munmap(map, size);
        return;
    }
    SimCamSurfaceTable *table =
        (SimCamSurfaceTable *)((uint8_t *)map + sizeof(SimCamShmHeader));
    uint32_t count = table->surfaceCount;
    if (count == 0 || count > SIMCAM_SURFACE_RING) {
        simcam_log(@"shm surface table invalid (count=%u)", count);
        munmap(map, size);
        return;
    }

    // Resolve each global IOSurface ID to a local reference.
    uint32_t resolved = 0;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    for (uint32_t i = 0; i < count; i++) {
        IOSurfaceRef s = IOSurfaceLookup(table->ids[i]);
        gSurfaces[i] = s;
        if (s) resolved++;
    }
#pragma clang diagnostic pop
    if (resolved != count) {
        for (uint32_t i = 0; i < count; i++) {
            if (gSurfaces[i]) {
                CFRelease(gSurfaces[i]);
                gSurfaces[i] = NULL;
            }
        }
        simcam_log(@"only %u/%u IOSurfaces resolved from shm \"%s\"", resolved, count, shmName);
        munmap(map, size);
        return;
    }

    gShmHeader = hdr;
    gSurfaceTable = table;
    gContentRects = hasContentRects ? (SimCamContentRect *)((uint8_t *)map + SimCamControlSize()) : NULL;
    gShmMapSize = size;
    simcam_log(@"shm \"%s\" attached (%ux%u, %u/%u IOSurfaces resolved)",
               shmName, hdr->width, hdr->height, resolved, count);
}

static void SimCamCloseSource(void) {
    if (gShmHeader) munmap(gShmHeader, gShmMapSize);
    gShmHeader = NULL;
    gSurfaceTable = NULL;
    gContentRects = NULL;
    gLastSeenSeq = 0;
    for (uint32_t i = 0; i < SIMCAM_SURFACE_RING; i++) {
        if (gSurfaces[i]) CFRelease(gSurfaces[i]);
        gSurfaces[i] = NULL;
    }
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    if (gLastFramePB) CVPixelBufferRelease(gLastFramePB);
    gLastFramePB = NULL;
    [lock unlock];
    [gOrientedLock lock];
    gOrientedCanvas = nil;
    [gOrientedBuffers removeAllObjects];
    [gOrientedImages removeAllObjects];
    [gOrientedLock unlock];
}

static void SimCamRefreshDevice(void) {
    BOOL connected;
    BOOL changed;
    @synchronized([SimCamRegistry class]) {
            BOOL wasConnected = SimCamDeviceIsConnected();
            if (gShmHeader && (!atomic_load_explicit(&gShmHeader->active, memory_order_acquire) ||
                              !SimCamOwnerIsAlive((pid_t)gShmHeader->ownerPid))) {
                atomic_store_explicit(&gConnected, false, memory_order_release);
                SimCamCloseSource();
            }
            if (!gShmHeader && !wasConnected) SimCamFrameSourceOpenShmIfRequested();
            connected = gShmHeader != NULL;
            changed = wasConnected != connected;
            atomic_store_explicit(&gConnected, connected, memory_order_release);
            if (changed) atomic_fetch_add(&gConnectionGeneration, 1);
    }
    if (!changed) return;
    if (!connected) [[SimCamRegistry shared] disconnectPreviewLayers];
    NSNotificationName name = connected ? AVCaptureDeviceWasConnectedNotification
                                        : AVCaptureDeviceWasDisconnectedNotification;
    for (NSNumber *position in @[@(AVCaptureDevicePositionBack), @(AVCaptureDevicePositionFront)]) {
        AVCaptureDevice *device = SimCamFakeDeviceForPosition((AVCaptureDevicePosition)position.intValue);
        [NSNotificationCenter.defaultCenter postNotificationName:name object:device];
    }
}

void SimCamStartDeviceMonitor(void) {
    static dispatch_source_t monitor;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        monitor = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(monitor, DISPATCH_TIME_NOW, NSEC_PER_SEC / 5, NSEC_PER_MSEC * 20);
        dispatch_source_set_event_handler(monitor, ^{ SimCamRefreshDevice(); });
        dispatch_resume(monitor);
    });
}
