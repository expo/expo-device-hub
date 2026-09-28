// Host camera source manager. The control socket accepts newline-delimited JSON.
// {"action":"frames"} claims the selected stream source; subsequent messages
// are a big-endian uint32 length followed by encoded image bytes.

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <MetalPerformanceShaders/MetalPerformanceShaders.h>

#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdatomic.h>
#include <mach/mach_time.h>
#include "../SimCameraInjector/include/SimCamShared.h"

#pragma mark - Globals (shm + writer)

static SimCamShmHeader *gHeader = NULL;
static SimCamSurfaceTable *gSurfaceTable = NULL;
static SimCamContentRect *gContentRects = NULL;
static IOSurfaceRef gSurfaces[SIMCAM_SURFACE_RING];
static uint32_t gWriteIndex = 0;            // last ring slot rendered into
static uint32_t gWidth = SIMCAM_CANVAS_SIZE;
static uint32_t gHeight = SIMCAM_CANVAS_SIZE;
static const char *gShmName = NULL;
static volatile sig_atomic_t gShouldExit = 0;
static atomic_uint_fast64_t gFrameSeq = 0;

static uint64_t MachAbsToNs(uint64_t t) {
    static mach_timebase_info_data_t tb = {0,0};
    if (tb.denom == 0) mach_timebase_info(&tb);
    return t * tb.numer / tb.denom;
}

static void HandleSig(int sig) { (void)sig; gShouldExit = 1; }

// Forward decls — definitions live near OpenShm so the control-socket
// handler (which sits earlier in this file post-refactor) can call them.
static uint8_t ParseMirrorCode(NSString *mode);
static NSString *MirrorName(uint8_t code);

// Pick a ring surface the reader isn't holding and isn't the one it last published, so an
// in-flight frame is never overwritten mid-read. Writers MUST finish with CommitSurface so
// latestIndex/frameSeq stay coherent for the dylib's tear-detection check.
static BOOL AcquireSurface(uint32_t *outIdx) {
    if (!gHeader || !gSurfaceTable) return NO;
    uint32_t count = gSurfaceTable->surfaceCount;
    if (count == 0) return NO;
    uint32_t latest = gSurfaceTable->latestIndex;
    uint32_t idx = gWriteIndex;
    for (uint32_t tries = 0; tries < count; tries++) {
        idx = (idx + 1) % count;
        if (idx == latest) continue;
        if (!IOSurfaceIsInUse(gSurfaces[idx])) {
            gWriteIndex = idx;
            *outIdx = idx;
            return YES;
        }
    }
    return NO;
}

// `content` is where the upright source sits in the canvas; the injector crops to it.
static void CommitSurface(uint32_t idx, CGRect content) {
    gContentRects[idx] = (SimCamContentRect){
        (uint16_t)content.origin.x, (uint16_t)content.origin.y,
        (uint16_t)content.size.width, (uint16_t)content.size.height,
    };
    gSurfaceTable->latestIndex = idx;
    gHeader->timestampNs = MachAbsToNs(mach_absolute_time());
    atomic_thread_fence(memory_order_release);
    uint64_t next = atomic_fetch_add(&gFrameSeq, 1) + 1;
    atomic_store_explicit(&gHeader->frameSeq, next, memory_order_release);
}

// Publish a fully-prepared BGRA canvas (gWidth x gHeight, packed at gWidth*4 bytes per row).
static BOOL PublishFrame(const uint8_t *bgra, CGRect content) {
    uint32_t idx;
    if (!bgra || !AcquireSurface(&idx)) return NO;
    IOSurfaceRef surface = gSurfaces[idx];
    IOSurfaceLock(surface, 0, NULL);
    uint8_t *dst = (uint8_t *)IOSurfaceGetBaseAddress(surface);
    size_t dstStride = IOSurfaceGetBytesPerRow(surface);
    size_t srcStride = (size_t)gWidth * 4;
    if (dstStride == srcStride) {
        memcpy(dst, bgra, srcStride * gHeight);
    } else {
        for (uint32_t y = 0; y < gHeight; y++) {
            memcpy(dst + (size_t)y * dstStride, bgra + (size_t)y * srcStride, srcStride);
        }
    }
    IOSurfaceUnlock(surface, 0, NULL);
    CommitSurface(idx, content);
    return YES;
}

#pragma mark - Source pipeline (start / stop / switch)

typedef NS_ENUM(NSInteger, SimCamSourceKind) {
    SimCamSourceNone = 0,
    SimCamSourcePlaceholder,
    SimCamSourceWebcam,
    SimCamSourceImage,
    SimCamSourceVideo,
    SimCamSourceStream,
    SimCamSourceSynthetic,
};
static NSString *SourceName(SimCamSourceKind k);

static SimCamSourceKind gActiveSource = SimCamSourceNone;
static dispatch_queue_t gSourceQueue;        // serial — owns source lifecycle
static dispatch_source_t gPlaceholderTimer;
static dispatch_semaphore_t gPlaceholderStopped;
static AVCaptureSession *gWebcamSession;
static SimCamSourceKind gPendingSource;     // for status reporting
static uint64_t gStreamGeneration = 0;
static uint64_t gStreamOwner = 0;
static uint64_t gLastStreamFrameNs = 0;
static dispatch_source_t gStreamIdleTimer;
static NSString *gActiveArg = nil;          // selected camera name, image path

// Opaque black, so an injector that shows the whole canvas (older builds) does not show the app
// behind the preview through the bars.
static void FillBlack(uint8_t *bgra, size_t size) {
    static const uint32_t black = 0xFF000000u;
    memset_pattern4(bgra, &black, size);
}

// Whole pixels only, so the injector's crop never picks up a half-covered edge.
static CGRect AspectFitRect(size_t srcW, size_t srcH) {
    double scale = MIN((double)gWidth / srcW, (double)gHeight / srcH);
    double w = MAX(1.0, floor(srcW * scale)), h = MAX(1.0, floor(srcH * scale));
    return CGRectMake(floor((gWidth - w) / 2.0), floor((gHeight - h) / 2.0), w, h);
}

static CGRect WholeCanvas(void) { return CGRectMake(0, 0, gWidth, gHeight); }

// Core Graphics is y-up.
static CGRect FlipY(CGRect rect) {
    return CGRectMake(rect.origin.x, gHeight - CGRectGetMaxY(rect), rect.size.width, rect.size.height);
}

#pragma mark GPU scaler (webcam)

static id<MTLDevice> gMetalDevice;
static id<MTLCommandQueue> gMetalQueue;
static CVMetalTextureCacheRef gMetalTextureCache;
static MPSImageLanczosScale *gScaler;
static id<MTLTexture> gSurfaceTextures[SIMCAM_SURFACE_RING];

static BOOL MetalScalerReady(void) {
    static BOOL ready;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        gMetalDevice = MTLCreateSystemDefaultDevice();
        if (!gMetalDevice || !MPSSupportsMTLDevice(gMetalDevice)) return;
        gMetalQueue = [gMetalDevice newCommandQueue];
        if (CVMetalTextureCacheCreate(kCFAllocatorDefault, NULL, gMetalDevice, NULL, &gMetalTextureCache) != kCVReturnSuccess) return;
        gScaler = [[MPSImageLanczosScale alloc] initWithDevice:gMetalDevice];
        ready = gMetalQueue && gScaler;
    });
    return ready;
}

static id<MTLTexture> SurfaceTexture(uint32_t idx) {
    if (!gSurfaceTextures[idx]) {
        MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                        width:gWidth
                                                                                       height:gHeight
                                                                                    mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite | MTLTextureUsageRenderTarget;
        gSurfaceTextures[idx] = [gMetalDevice newTextureWithDescriptor:desc iosurface:gSurfaces[idx] plane:0];
    }
    return gSurfaceTextures[idx];
}

// Letterbox a BGRA pixel buffer into the next ring surface on the GPU.
static BOOL ScalePixelBufferIntoSurface(CVPixelBufferRef pb) {
    if (!gHeader || !pb || CVPixelBufferGetPixelFormatType(pb) != kCVPixelFormatType_32BGRA) return NO;
    size_t srcW = CVPixelBufferGetWidth(pb), srcH = CVPixelBufferGetHeight(pb);
    if (srcW == 0 || srcH == 0 || !MetalScalerReady()) return NO;
    uint32_t idx;
    if (!AcquireSurface(&idx)) return NO;
    id<MTLTexture> dst = SurfaceTexture(idx);
    CVMetalTextureRef srcRef = NULL;
    if (!dst || CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, gMetalTextureCache, pb, NULL,
            MTLPixelFormatBGRA8Unorm, srcW, srcH, 0, &srcRef) != kCVReturnSuccess) return NO;
    CGRect fit = AspectFitRect(srcW, srcH);
    id<MTLCommandBuffer> commands = [gMetalQueue commandBuffer];
    MTLRenderPassDescriptor *clear = [MTLRenderPassDescriptor renderPassDescriptor];
    clear.colorAttachments[0].texture = dst;
    clear.colorAttachments[0].loadAction = MTLLoadActionClear;
    clear.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1);
    clear.colorAttachments[0].storeAction = MTLStoreActionStore;
    [[commands renderCommandEncoderWithDescriptor:clear] endEncoding];
    MPSScaleTransform scale = { fit.size.width / srcW, fit.size.height / srcH, 0, 0 };
    gScaler.scaleTransform = &scale;
    gScaler.clipRect = MTLRegionMake2D((NSUInteger)fit.origin.x, (NSUInteger)fit.origin.y,
                                       (NSUInteger)fit.size.width, (NSUInteger)fit.size.height);
    [gScaler encodeToCommandBuffer:commands sourceTexture:CVMetalTextureGetTexture(srcRef) destinationTexture:dst];
    [commands commit];
    [commands waitUntilCompleted];
    CFRelease(srcRef);
    if (commands.status != MTLCommandBufferStatusCompleted) return NO;
    CommitSurface(idx, fit);
    return YES;
}

static BOOL PublishPixelBufferScaled(CVPixelBufferRef pb) {
    if (ScalePixelBufferIntoSurface(pb)) return YES;
    static dispatch_once_t logged;
    dispatch_once(&logged, ^{ fprintf(stderr, "[serve-sim-camera] a webcam frame could not be published\n"); });
    return NO;
}

@interface SimCamWebcamWriter : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@end

@implementation SimCamWebcamWriter
- (void)captureOutput:(AVCaptureOutput *)out
didOutputSampleBuffer:(CMSampleBufferRef)sb
       fromConnection:(AVCaptureConnection *)conn {
    PublishPixelBufferScaled(CMSampleBufferGetImageBuffer(sb));
}
@end

static SimCamWebcamWriter *gWebcamWriter = nil;

#pragma mark Placeholder source — Remotion-style "blueprint" grid

// Visual parity with apps/editor/src/backgrounds/BlueprintBackground.tsx in
// the device-frames repo: a fixed #019EFF→#0168D4 vertical gradient, a major
// grid every 120px with minor subdivisions every 24px, and tiny animated
// cross markers at major intersections that rotate + scale-pulse. All of the
// static layers (gradient + grid) are rasterized once into a CGImage and
// blitted each frame; only the crosses are redrawn live.

#define BP_GRID_MAJOR        120.0
#define BP_GRID_MINOR_DIV    5
#define BP_CROSS_SIZE        7.0
#define BP_CROSS_STROKE      4.0

static CGImageRef gBPBackground = NULL;   // cached gradient + grid
static uint32_t   gBPCachedW = 0;
static uint32_t   gBPCachedH = 0;

// Match the JS seededRandom in BlueprintBackground.tsx so cross timings line
// up with the Remotion reference. (The original is `sin(seed*438.8) * K`
// since 127.1+311.7 = 438.8 and both factors multiply the same `seed`.)
static inline double BPSeededRandom(double seed) {
    double x = sin(seed * 438.8) * 43758.5453;
    return x - floor(x);
}

static CGImageRef BuildBlueprintBackground(uint32_t w, uint32_t h) {
    size_t bpr = (size_t)w * 4;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    if (!ctx) { CGColorSpaceRelease(cs); return NULL; }

    // Vertical gradient #019EFF → #0168D4.
    CGFloat colors[8] = {
        0x01/255.0, 0x9E/255.0, 0xFF/255.0, 1.0,
        0x01/255.0, 0x68/255.0, 0xD4/255.0, 1.0,
    };
    CGGradientRef grad = CGGradientCreateWithColorComponents(cs, colors,
        (CGFloat[]){0, 1}, 2);
    CGContextDrawLinearGradient(ctx, grad,
        CGPointMake(w/2.0, h), CGPointMake(w/2.0, 0), 0);
    CGGradientRelease(grad);

    double minor = BP_GRID_MAJOR / (double)BP_GRID_MINOR_DIV;

    // Minor grid: stroke 0.5, white α=0.08.
    CGContextSetRGBStrokeColor(ctx, 1, 1, 1, 0.08);
    CGContextSetLineWidth(ctx, 0.5);
    CGContextBeginPath(ctx);
    for (double y = 0; y <= h + minor; y += minor) {
        if (fmod(y, BP_GRID_MAJOR) == 0) continue;
        CGContextMoveToPoint(ctx, 0, y);
        CGContextAddLineToPoint(ctx, w, y);
    }
    for (double x = 0; x <= w + minor; x += minor) {
        if (fmod(x, BP_GRID_MAJOR) == 0) continue;
        CGContextMoveToPoint(ctx, x, 0);
        CGContextAddLineToPoint(ctx, x, h);
    }
    CGContextStrokePath(ctx);

    // Major grid: stroke 1.5, white α=0.15.
    CGContextSetRGBStrokeColor(ctx, 1, 1, 1, 0.15);
    CGContextSetLineWidth(ctx, 1.5);
    CGContextBeginPath(ctx);
    for (double y = 0; y <= h + BP_GRID_MAJOR; y += BP_GRID_MAJOR) {
        CGContextMoveToPoint(ctx, 0, y);
        CGContextAddLineToPoint(ctx, w, y);
    }
    for (double x = 0; x <= w + BP_GRID_MAJOR; x += BP_GRID_MAJOR) {
        CGContextMoveToPoint(ctx, x, 0);
        CGContextAddLineToPoint(ctx, x, h);
    }
    CGContextStrokePath(ctx);

    CGImageRef img = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    CGColorSpaceRelease(cs);
    return img;
}

static void RenderPlaceholderFrame(uint8_t *out, uint64_t frameIdx) {
    size_t bpr = (size_t)gWidth * 4;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(out, gWidth, gHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);
    if (!ctx) return;

    // Cached static background (gradient + grid). Rebuild on dimension change.
    if (!gBPBackground || gBPCachedW != gWidth || gBPCachedH != gHeight) {
        if (gBPBackground) CGImageRelease(gBPBackground);
        gBPBackground = BuildBlueprintBackground(gWidth, gHeight);
        gBPCachedW = gWidth;
        gBPCachedH = gHeight;
    }
    if (gBPBackground) {
        CGContextDrawImage(ctx, CGRectMake(0, 0, gWidth, gHeight), gBPBackground);
    }

    // Cross markers at every interior major intersection. Loops every 30s.
    double t = fmod((double)frameIdx / 30.0, 30.0);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetLineWidth(ctx, BP_CROSS_STROKE);

    int seed = 0;
    for (double cy = BP_GRID_MAJOR; cy < gHeight; cy += BP_GRID_MAJOR) {
        for (double cx = BP_GRID_MAJOR; cx < gWidth; cx += BP_GRID_MAJOR) {
            double offset      = BPSeededRandom(seed)     * M_PI * 2.0;
            double speed       = 0.15 + BPSeededRandom(seed + 1) * 0.20;
            double scaleSpeed  = 0.07 + BPSeededRandom(seed + 2) * 0.12;
            double scalePhase  = t * scaleSpeed + BPSeededRandom(seed + 3) * M_PI * 2.0;
            seed++;

            double raw = sin(scalePhase * M_PI * 2.0);
            double scale = raw > 0 ? raw : 0;        // half the cycle hidden
            if (scale <= 0.001) continue;             // skip invisible draws

            double rotation = (t * speed + offset) * M_PI * 2.0;
            double s = BP_CROSS_SIZE * scale;
            double opacity = 0.3 + 0.5 * scale;

            CGContextSaveGState(ctx);
            CGContextTranslateCTM(ctx, cx, cy);
            CGContextRotateCTM(ctx, rotation);
            CGContextSetRGBStrokeColor(ctx, 1, 1, 1, 0.7 * opacity);
            CGContextBeginPath(ctx);
            CGContextMoveToPoint(ctx, -s, 0);
            CGContextAddLineToPoint(ctx, s, 0);
            CGContextMoveToPoint(ctx, 0, -s);
            CGContextAddLineToPoint(ctx, 0, s);
            CGContextStrokePath(ctx);
            CGContextRestoreGState(ctx);
        }
    }

    CGContextRelease(ctx);
}

static void StartPlaceholderSource(void) {
    static uint8_t *buf = NULL;
    size_t need = (size_t)gWidth * gHeight * 4;
    if (!buf) buf = calloc(1, need);
    if (!buf) {
        fprintf(stderr, "[serve-sim-camera] placeholder buf alloc failed (%zu bytes)\n", need);
        return;
    }

    __block uint64_t frameIdx = 0;
    RenderPlaceholderFrame(buf, frameIdx++);
    PublishFrame(buf, WholeCanvas());

    gPlaceholderTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    gPlaceholderStopped = dispatch_semaphore_create(0);
    dispatch_semaphore_t stopped = gPlaceholderStopped;
    dispatch_source_set_cancel_handler(gPlaceholderTimer, ^{
        dispatch_semaphore_signal(stopped);
    });
    uint64_t intervalNs = NSEC_PER_SEC / 30;
    dispatch_source_set_timer(gPlaceholderTimer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)intervalNs), intervalNs, intervalNs / 10);
    dispatch_source_set_event_handler(gPlaceholderTimer, ^{
        RenderPlaceholderFrame(buf, frameIdx++);
        PublishFrame(buf, WholeCanvas());
    });
    dispatch_resume(gPlaceholderTimer);
    fprintf(stderr, "[serve-sim-camera] placeholder source running @ 30fps (%ux%u, first frame seq=%llu)\n",
        gWidth, gHeight, (unsigned long long)atomic_load(&gFrameSeq));
}

static void StopPlaceholderSource(void) {
    if (gPlaceholderTimer) {
        dispatch_source_t timer = gPlaceholderTimer;
        dispatch_semaphore_t stopped = gPlaceholderStopped;
        gPlaceholderTimer = NULL;
        gPlaceholderStopped = nil;
        dispatch_source_cancel(timer);
        // Cancellation does not interrupt an event handler already publishing
        // a frame. Wait for the cancel handler before releasing the IOSurface
        // ring during shutdown or a source switch.
        if (stopped) dispatch_semaphore_wait(stopped, DISPATCH_TIME_FOREVER);
    }
}

#pragma mark Webcam source

static AVCaptureDevice *PickWebcamDevice(NSString *idOrName) {
    AVCaptureDeviceDiscoverySession *s = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:@[
            AVCaptureDeviceTypeBuiltInWideAngleCamera,
            AVCaptureDeviceTypeExternal,
            AVCaptureDeviceTypeContinuityCamera,
        ]
        mediaType:AVMediaTypeVideo
        position:AVCaptureDevicePositionUnspecified];
    if (!idOrName.length) {
        for (AVCaptureDevice *d in s.devices)
            if (d.position == AVCaptureDevicePositionFront) return d;
        return s.devices.firstObject;
    }
    for (AVCaptureDevice *d in s.devices)
        if ([d.uniqueID isEqualToString:idOrName]) return d;
    for (AVCaptureDevice *d in s.devices)
        if ([d.localizedName.lowercaseString containsString:idOrName.lowercaseString]) return d;
    return nil;
}

static BOOL StartWebcamSource(NSString *deviceArg, NSString **err) {
    if (!MetalScalerReady()) { if (err) *err = @"the GPU scaler is unavailable"; return NO; }
    AVCaptureDevice *device = PickWebcamDevice(deviceArg);
    if (!device) { if (err) *err = @"no matching camera"; return NO; }
    NSError *e = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&e];
    if (!input) { if (err) *err = e.localizedDescription ?: @"deviceInput failed"; return NO; }
    AVCaptureSession *sess = [AVCaptureSession new];
    sess.sessionPreset = AVCaptureSessionPreset1280x720;
    if (![sess canAddInput:input]) { if (err) *err = @"session canAddInput=NO"; return NO; }
    [sess addInput:input];
    if (!gWebcamWriter) gWebcamWriter = [SimCamWebcamWriter new];
    AVCaptureVideoDataOutput *out = [AVCaptureVideoDataOutput new];
    out.alwaysDiscardsLateVideoFrames = YES;
    out.videoSettings = @{
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
    };
    [out setSampleBufferDelegate:gWebcamWriter
                           queue:dispatch_queue_create("simcam.helper.webcam",
                                                       DISPATCH_QUEUE_SERIAL)];
    if (![sess canAddOutput:out]) { if (err) *err = @"session canAddOutput=NO"; return NO; }
    [sess addOutput:out];
    [sess startRunning];
    gWebcamSession = sess;
    fprintf(stderr, "[serve-sim-camera] webcam → %s\n", device.localizedName.UTF8String);
    return YES;
}

static void StopWebcamSource(void) {
    if (gWebcamSession) {
        [gWebcamSession stopRunning];
        gWebcamSession = nil;
    }
}

#pragma mark Synthetic webcam source (tests)

// Generated frames through the webcam's GPU path, so tests cover it without a host camera.
// The arg lists frame sizes, for example "1280x720,480x640"; each shows for half a second.
static dispatch_source_t gSyntheticTimer;
static dispatch_semaphore_t gSyntheticStopped;

// Quadrants red, green / blue, white, so a test can tell the letterbox and the rotation apart.
static CVPixelBufferRef CreateSyntheticFrame(size_t w, size_t h) CF_RETURNS_RETAINED {
    NSDictionary *attrs = @{
        (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
        (id)kCVPixelBufferMetalCompatibilityKey: @YES,
    };
    CVPixelBufferRef pb = NULL;
    if (CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA,
            (__bridge CFDictionaryRef)attrs, &pb) != kCVReturnSuccess) return NULL;
    static const uint32_t colors[4] = { 0xFFFF0000u, 0xFF00FF00u, 0xFF0000FFu, 0xFFFFFFFFu };
    CVPixelBufferLockBaseAddress(pb, 0);
    uint8_t *base = CVPixelBufferGetBaseAddress(pb);
    size_t bpr = CVPixelBufferGetBytesPerRow(pb);
    for (size_t y = 0; y < h; y++) {
        uint32_t *row = (uint32_t *)(base + y * bpr);
        for (size_t x = 0; x < w; x++) row[x] = colors[(y >= h / 2) * 2 + (x >= w / 2)];
    }
    CVPixelBufferUnlockBaseAddress(pb, 0);
    return pb;
}

static BOOL StartSyntheticSource(NSString *arg, NSString **err) {
    NSMutableArray *frames = [NSMutableArray new];
    for (NSString *size in [arg componentsSeparatedByString:@","]) {
        NSArray<NSString *> *wh = [size componentsSeparatedByString:@"x"];
        NSInteger w = wh.count == 2 ? wh[0].integerValue : 0, h = wh.count == 2 ? wh[1].integerValue : 0;
        CVPixelBufferRef pb = w > 0 && h > 0 && w <= 4096 && h <= 4096 ? CreateSyntheticFrame(w, h) : NULL;
        if (!pb) { if (err) *err = @"synthetic source needs sizes like 1280x720,480x640"; return NO; }
        [frames addObject:(__bridge_transfer id)pb];
    }
    if (!PublishPixelBufferScaled((__bridge CVPixelBufferRef)frames[0])) {
        if (err) *err = @"the GPU scaler is unavailable";
        return NO;
    }
    gSyntheticTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    gSyntheticStopped = dispatch_semaphore_create(0);
    dispatch_semaphore_t stopped = gSyntheticStopped;
    dispatch_source_set_cancel_handler(gSyntheticTimer, ^{ dispatch_semaphore_signal(stopped); });
    uint64_t intervalNs = NSEC_PER_SEC / 30;
    dispatch_source_set_timer(gSyntheticTimer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)intervalNs),
        intervalNs, intervalNs / 10);
    __block uint64_t frameIdx = 0;
    dispatch_source_set_event_handler(gSyntheticTimer, ^{
        CVPixelBufferRef pb = (__bridge CVPixelBufferRef)frames[(frameIdx++ / 15) % frames.count];
        PublishPixelBufferScaled(pb);
    });
    dispatch_resume(gSyntheticTimer);
    return YES;
}

static void StopSyntheticSource(void) {
    if (!gSyntheticTimer) return;
    dispatch_source_t timer = gSyntheticTimer;
    dispatch_semaphore_t stopped = gSyntheticStopped;
    gSyntheticTimer = NULL;
    gSyntheticStopped = nil;
    dispatch_source_cancel(timer);
    dispatch_semaphore_wait(stopped, DISPATCH_TIME_FOREVER);
}

#pragma mark Image source

// Aspect-fit a decoded image into a fresh shm-sized BGRA buffer and publish it.
static BOOL PublishCGImage(CGImageRef img, NSString **err) {
    size_t bpr = (size_t)gWidth * 4;
    uint8_t *buf = malloc(bpr * gHeight);
    if (!buf) { if (err) *err = @"the host is out of memory for a camera frame"; return NO; }
    FillBlack(buf, bpr * gHeight);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(buf, gWidth, gHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);
    if (!ctx) {
        free(buf);
        if (err) *err = @"the camera frame could not be prepared";
        return NO;
    }
    CGRect fit = AspectFitRect(CGImageGetWidth(img), CGImageGetHeight(img));
    CGContextDrawImage(ctx, FlipY(fit), img);
    CGContextRelease(ctx);
    BOOL published = PublishFrame(buf, fit);
    free(buf);
    if (!published && err) *err = @"no writable camera frame buffer was available";
    return published;
}

static BOOL StartImageSource(NSString *path, NSString **err) {
    if (!path.length) { if (err) *err = @"image source needs a path"; return NO; }
    CGImageSourceRef src = CGImageSourceCreateWithURL(
        (__bridge CFURLRef)[NSURL fileURLWithPath:path], NULL);
    if (!src) { if (err) *err = @"could not open image"; return NO; }
    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, NULL);
    CFRelease(src);
    if (!img) { if (err) *err = @"could not decode image"; return NO; }

    NSString *reason = nil;
    BOOL published = PublishCGImage(img, &reason);
    CGImageRelease(img);
    if (!published) {
        if (err) *err = [NSString stringWithFormat:@"could not publish image: %@",
                                                   reason ?: @"unknown error"];
        return NO;
    }
    fprintf(stderr, "[serve-sim-camera] image → %s\n", path.UTF8String);
    return YES;
}

static void StopImageSource(void) {
    // Nothing live; the published frame stays in shm until next source overwrites.
}

#pragma mark Stream source (encoded frames pushed in over the control socket)

#define SIMCAM_STREAM_IDLE_NS (2ull * NSEC_PER_SEC)
#define SIMCAM_MAX_PUSHED_IMAGE_DIMENSION 4096u
#define SIMCAM_MAX_PUSHED_IMAGE_PIXELS (4096ull * 2160ull)

static BOOL StartStreamSource(NSString **_err) {
    atomic_store_explicit(&gHeader->active, 0, memory_order_release);
    if (!gStreamIdleTimer) {
        gStreamIdleTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gSourceQueue);
        dispatch_source_set_timer(gStreamIdleTimer, DISPATCH_TIME_NOW, NSEC_PER_SEC / 5, NSEC_PER_MSEC * 20);
        dispatch_source_set_event_handler(gStreamIdleTimer, ^{
            if (gActiveSource == SimCamSourceStream && gStreamOwner &&
                MachAbsToNs(mach_absolute_time()) - gLastStreamFrameNs >= SIMCAM_STREAM_IDLE_NS) {
                atomic_store_explicit(&gHeader->active, 0, memory_order_release);
            }
        });
        dispatch_resume(gStreamIdleTimer);
    }
    return YES;
}

static void StopStreamSource(void) {
    gStreamOwner = 0;
    gStreamGeneration++;
}

static BOOL PublishEncodedFrame(NSData *encoded) {
    NSDictionary *options = @{ (id)kCGImageSourceShouldCache: @NO };
    CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)encoded, (__bridge CFDictionaryRef)options);
    if (!src) return NO;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(src, 0, NULL));
    uint64_t width = [properties[(id)kCGImagePropertyPixelWidth] unsignedLongLongValue];
    uint64_t height = [properties[(id)kCGImagePropertyPixelHeight] unsignedLongLongValue];
    if (!width || !height || width > SIMCAM_MAX_PUSHED_IMAGE_DIMENSION ||
        height > SIMCAM_MAX_PUSHED_IMAGE_DIMENSION || width * height > SIMCAM_MAX_PUSHED_IMAGE_PIXELS) {
        CFRelease(src);
        return NO;
    }
    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, (__bridge CFDictionaryRef)options);
    CFRelease(src);
    if (!img) return NO;
    BOOL published = PublishCGImage(img, NULL);
    CGImageRelease(img);
    return published;
}

#pragma mark Video source (looping playback via AVAssetReader)

// Looping AVAsset playback at native FPS. Frames are decoded as BGRA on a
// background queue, fitted into the shm canvas, then paced with
// `clock_nanosleep` against the track's presentation timestamps so playback
// runs at real time. When the reader hits AVAssetReaderStatusCompleted we
// recreate it and reset the wall-clock anchor so the loop boundary is
// seamless.

static dispatch_queue_t gVideoQueue;
static atomic_bool gVideoCancelled = false;
static dispatch_semaphore_t gVideoStopped;  // signaled when the loop exits

static AVAssetReaderTrackOutput *MakeVideoOutput(AVAssetReader **outReader,
                                                 AVAssetTrack *track,
                                                 NSString **errOut) {
    NSError *e = nil;
    AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:track.asset error:&e];
    if (!reader) {
        if (errOut) *errOut = e.localizedDescription ?: @"AVAssetReader init failed";
        return nil;
    }
    AVAssetReaderTrackOutput *out = [AVAssetReaderTrackOutput
        assetReaderTrackOutputWithTrack:track
                         outputSettings:@{
                             (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
                             (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
                         }];
    out.alwaysCopiesSampleData = NO;
    if (![reader canAddOutput:out]) {
        if (errOut) *errOut = @"reader rejected BGRA output";
        return nil;
    }
    [reader addOutput:out];
    if (![reader startReading]) {
        if (errOut) *errOut = reader.error.localizedDescription ?: @"reader failed to start";
        return nil;
    }
    *outReader = reader;
    return out;
}

// Aspect-fit a source pixel buffer into a transient BGRA buffer sized to
// the shm region. We allocate once per call so the caller is free to free
// the result without worrying about lifetime sharing.
static uint8_t *RenderPixelBufferToShmSize(CVPixelBufferRef pb, CGRect *content) {
    size_t srcW = CVPixelBufferGetWidth(pb);
    size_t srcH = CVPixelBufferGetHeight(pb);
    if (srcW == 0 || srcH == 0) return NULL;
    CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    uint8_t *src = CVPixelBufferGetBaseAddress(pb);
    size_t srcBPR = CVPixelBufferGetBytesPerRow(pb);
    if (!src) {
        CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
        return NULL;
    }

    size_t bpr = (size_t)gWidth * 4;
    uint8_t *out = malloc(bpr * gHeight);
    if (out) FillBlack(out, bpr * gHeight);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(out, gWidth, gHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);

    // Wrap the source pixels as a CGImage we can hand to CoreGraphics.
    CGDataProviderRef dp = CGDataProviderCreateWithData(NULL, src, srcBPR * srcH, NULL);
    CGColorSpaceRef imgCs = CGColorSpaceCreateDeviceRGB();
    CGImageRef img = CGImageCreate(srcW, srcH, 8, 32, srcBPR, imgCs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little,
        dp, NULL, false, kCGRenderingIntentDefault);
    CGColorSpaceRelease(imgCs);
    CGDataProviderRelease(dp);

    CGRect fit = AspectFitRect(srcW, srcH);
    CGContextDrawImage(ctx, FlipY(fit), img);
    *content = fit;
    CGImageRelease(img);
    CGContextRelease(ctx);
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    return out;
}

static void RunVideoLoop(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    AVAsset *asset = [AVAsset assetWithURL:url];
    NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    if (tracks.count == 0) {
        fprintf(stderr, "[serve-sim-camera] video → %s: no video tracks\n", path.UTF8String);
        dispatch_semaphore_signal(gVideoStopped);
        return;
    }
    AVAssetTrack *track = tracks.firstObject;

    while (!atomic_load(&gVideoCancelled)) {
        NSString *err = nil;
        AVAssetReader *reader = nil;
        AVAssetReaderTrackOutput *out = MakeVideoOutput(&reader, track, &err);
        if (!out) {
            fprintf(stderr, "[serve-sim-camera] video reader failed: %s\n", err.UTF8String ?: "?");
            break;
        }

        uint64_t loopStartNs = MachAbsToNs(mach_absolute_time());
        while (!atomic_load(&gVideoCancelled)) {
            CMSampleBufferRef sb = [out copyNextSampleBuffer];
            if (!sb) break;  // end of track or read error → loop or exit
            CMTime pts = CMSampleBufferGetPresentationTimeStamp(sb);
            CVPixelBufferRef pb = CMSampleBufferGetImageBuffer(sb);
            if (pb) {
                CGRect content;
                uint8_t *frame = RenderPixelBufferToShmSize(pb, &content);
                if (frame) {
                    // Pace against wall clock: don't publish until the
                    // frame's PTS has caught up. Skips backwards (e.g.
                    // first frame of each loop) without sleeping.
                    if (CMTIME_IS_VALID(pts) && pts.timescale > 0) {
                        uint64_t targetNs = loopStartNs +
                            (uint64_t)((double)pts.value * 1e9 / pts.timescale);
                        uint64_t nowNs = MachAbsToNs(mach_absolute_time());
                        if (targetNs > nowNs) {
                            uint64_t sleepNs = targetNs - nowNs;
                            // Cap waits to 100ms slices so cancellation
                            // is responsive on long-PTS gaps.
                            while (sleepNs > 0 && !atomic_load(&gVideoCancelled)) {
                                uint64_t slice = sleepNs > 100000000ULL ? 100000000ULL : sleepNs;
                                struct timespec ts = {
                                    .tv_sec = (time_t)(slice / 1000000000ULL),
                                    .tv_nsec = (long)(slice % 1000000000ULL),
                                };
                                nanosleep(&ts, NULL);
                                sleepNs -= slice;
                            }
                        }
                    }
                    PublishFrame(frame, content);
                    free(frame);
                }
            }
            CFRelease(sb);
        }

        AVAssetReaderStatus status = reader.status;
        [reader cancelReading];
        if (status == AVAssetReaderStatusFailed) {
            fprintf(stderr, "[serve-sim-camera] video reader failed mid-loop: %s\n",
                    reader.error.localizedDescription.UTF8String ?: "?");
            break;
        }
        // Otherwise rewind by re-creating the reader on the next iteration.
    }
    dispatch_semaphore_signal(gVideoStopped);
}

static BOOL StartVideoSource(NSString *path, NSString **err) {
    if (!path.length) { if (err) *err = @"video source needs a path"; return NO; }
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
        if (err) *err = [NSString stringWithFormat:@"video file not found: %@", path];
        return NO;
    }
    if (!gVideoQueue) {
        gVideoQueue = dispatch_queue_create("serve-sim.cam.video", DISPATCH_QUEUE_SERIAL);
    }
    atomic_store(&gVideoCancelled, false);
    gVideoStopped = dispatch_semaphore_create(0);
    NSString *captured = [path copy];
    dispatch_async(gVideoQueue, ^{ RunVideoLoop(captured); });
    fprintf(stderr, "[serve-sim-camera] video → %s\n", path.UTF8String);
    return YES;
}

static void StopVideoSource(void) {
    if (!gVideoStopped) return;
    atomic_store(&gVideoCancelled, true);
    // Wait up to 1s for the decode loop to bail.
    dispatch_semaphore_wait(gVideoStopped, dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC));
    gVideoStopped = nil;
}

#pragma mark Source switch entry point

static void StopSource(SimCamSourceKind kind) {
    switch (kind) {
        case SimCamSourcePlaceholder: StopPlaceholderSource(); break;
        case SimCamSourceWebcam:      StopWebcamSource(); break;
        case SimCamSourceImage:       StopImageSource(); break;
        case SimCamSourceVideo:       StopVideoSource(); break;
        case SimCamSourceStream:      StopStreamSource(); break;
        case SimCamSourceSynthetic:   StopSyntheticSource(); break;
        default: break;
    }
}

static BOOL StartSource(SimCamSourceKind kind, NSString *arg, NSString **err) {
    switch (kind) {
        case SimCamSourcePlaceholder: StartPlaceholderSource(); return YES;
        case SimCamSourceWebcam:      return StartWebcamSource(arg, err);
        case SimCamSourceImage:       return StartImageSource(arg, err);
        case SimCamSourceVideo:       return StartVideoSource(arg, err);
        case SimCamSourceStream:      return StartStreamSource(err);
        case SimCamSourceSynthetic:   return StartSyntheticSource(arg, err);
        default: return YES;
    }
}

static void SetActiveSource(SimCamSourceKind kind, NSString *arg, BOOL connected) {
    gActiveSource = kind;
    gActiveArg = [arg copy];
    // A stream stays disconnected until its first pushed frame.
    if (kind == SimCamSourceStream) return;
    const BOOL publishing = kind != SimCamSourceNone && connected;
    atomic_store_explicit(&gHeader->active, publishing ? 1 : 0, memory_order_release);
}

static BOOL SwitchSource(SimCamSourceKind kind, NSString *arg, NSString **errOut) {
    __block BOOL ok = NO;
    __block NSString *err = nil;
    dispatch_sync(gSourceQueue, ^{
        SimCamSourceKind previousKind = gActiveSource;
        NSString *previousArg = gActiveArg;
        BOOL wasConnected = atomic_load_explicit(&gHeader->active, memory_order_acquire) != 0;
        StopSource(previousKind);
        // Leave `active` alone so an ordinary swap does not post a disconnect.
        gActiveSource = SimCamSourceNone;
        gActiveArg = nil;
        ok = StartSource(kind, arg, &err);
        if (ok) {
            SetActiveSource(kind, arg, /* connected */ YES);
            return;
        }
        // Restore the previous source. A stream cannot be: its pushing client was dropped.
        if (previousKind == SimCamSourceNone || previousKind == SimCamSourceStream) {
            atomic_store_explicit(&gHeader->active, 0, memory_order_release);
            return;
        }
        NSString *restoreErr = nil;
        if (StartSource(previousKind, previousArg, &restoreErr)) {
            SetActiveSource(previousKind, previousArg, wasConnected);
            return;
        }
        atomic_store_explicit(&gHeader->active, 0, memory_order_release);
        err = [NSString stringWithFormat:@"%@ (the previous %@ source could not be restored: %@)",
                                         err ?: @"switch failed", SourceName(previousKind),
                                         restoreErr ?: @"unknown error"];
    });
    if (errOut) *errOut = err;
    return ok;
}

static SimCamSourceKind ParseSourceName(NSString *name) {
    if ([name isEqualToString:@"placeholder"]) return SimCamSourcePlaceholder;
    if ([name isEqualToString:@"webcam"])      return SimCamSourceWebcam;
    if ([name isEqualToString:@"image"])       return SimCamSourceImage;
    if ([name isEqualToString:@"video"])       return SimCamSourceVideo;
    if ([name isEqualToString:@"stream"])      return SimCamSourceStream;
    if ([name isEqualToString:@"synthetic"])   return SimCamSourceSynthetic;
    if ([name isEqualToString:@"none"])        return SimCamSourceNone;
    return -1;
}
static NSString *SourceName(SimCamSourceKind k) {
    switch (k) {
        case SimCamSourcePlaceholder: return @"placeholder";
        case SimCamSourceWebcam:      return @"webcam";
        case SimCamSourceImage:       return @"image";
        case SimCamSourceVideo:       return @"video";
        case SimCamSourceStream:      return @"stream";
        case SimCamSourceSynthetic:   return @"synthetic";
        default:                      return @"none";
    }
}

#pragma mark - Control socket

static int gControlListenFd = -1;
static dispatch_source_t gAcceptSource;

static NSData *EncodeReply(NSDictionary *dict) {
    NSMutableDictionary *m = dict.mutableCopy;
    dispatch_sync(gSourceQueue, ^{
        m[@"connected"] = gHeader && atomic_load_explicit(&gHeader->active, memory_order_acquire) ? @YES : @NO;
        if (!m[@"source"]) m[@"source"] = SourceName(gActiveSource);
        if (!m[@"arg"] && gActiveArg) m[@"arg"] = gActiveArg;
        if (!m[@"mirror"] && gHeader) m[@"mirror"] = MirrorName(gHeader->mirrorMode);
    });
    NSError *e = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:m options:0 error:&e];
    if (!json) json = [@"{\"ok\":false}" dataUsingEncoding:NSUTF8StringEncoding];
    NSMutableData *out = json.mutableCopy;
    [out appendBytes:"\n" length:1];
    return out;
}

// A field of another JSON type reads as missing, so it gets an error reply instead of an exception.
static NSString *StringField(NSDictionary *cmd, NSString *key) {
    id value = cmd[key];
    return [value isKindOfClass:[NSString class]] ? value : nil;
}

static BOOL HandleControlLine(int fd, NSData *data, uint64_t *owner) {
    NSError *e = nil;
    NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:data options:0 error:&e];
    if (![cmd isKindOfClass:[NSDictionary class]]) {
        NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"invalid json" });
        write(fd, r.bytes, r.length);
        return NO;
    }
    NSString *action = StringField(cmd, @"action");
    if ([action isEqualToString:@"status"]) {
        NSData *r = EncodeReply(@{ @"ok": @YES });
        write(fd, r.bytes, r.length);
        return NO;
    }
    if ([action isEqualToString:@"shutdown"]) {
        NSData *r = EncodeReply(@{ @"ok": @YES, @"shutdown": @YES });
        write(fd, r.bytes, r.length);
        gShouldExit = 1;
        return NO;
    }
    if ([action isEqualToString:@"switch"]) {
        SimCamSourceKind k = ParseSourceName(StringField(cmd, @"source"));
        if (k == (SimCamSourceKind)-1) {
            NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"unknown source" });
            write(fd, r.bytes, r.length);
            return NO;
        }
        NSString *err = nil;
        BOOL ok = SwitchSource(k, StringField(cmd, @"arg"), &err);
        NSData *r = EncodeReply(ok
            ? @{ @"ok": @YES }
            : @{ @"ok": @NO, @"error": err ?: @"switch failed" });
        write(fd, r.bytes, r.length);
        return NO;
    }
    if ([action isEqualToString:@"frames"]) {
        __block BOOL ok = NO;
        dispatch_sync(gSourceQueue, ^{
            if (gActiveSource != SimCamSourceStream) return;
            gStreamOwner = ++gStreamGeneration;
            *owner = gStreamOwner;
            gLastStreamFrameNs = MachAbsToNs(mach_absolute_time());
            atomic_store_explicit(&gHeader->active, 0, memory_order_release);
            ok = YES;
        });
        NSData *r = EncodeReply(ok
            ? @{ @"ok": @YES, @"frames": @YES }
            : @{ @"ok": @NO, @"error": @"Select the stream source before sending frames." });
        write(fd, r.bytes, r.length);
        return ok;
    }
    if ([action isEqualToString:@"setMirror"]) {
        NSString *mode = cmd[@"mode"] ? StringField(cmd, @"mode") : @"auto";
        uint8_t code = ParseMirrorCode(mode);
        if (code == 0xFE) {
            NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"unknown mirror mode" });
            write(fd, r.bytes, r.length);
            return NO;
        }
        if (gHeader) gHeader->mirrorMode = code;
        NSData *r = EncodeReply(@{ @"ok": @YES, @"mirror": MirrorName(code) });
        write(fd, r.bytes, r.length);
        return NO;
    }
    NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"unknown action" });
    write(fd, r.bytes, r.length);
    return NO;
}

#define SIMCAM_MAX_PUSHED_FRAME_BYTES (8u * 1024u * 1024u)
#define SIMCAM_MAX_CONTROL_LINE_BYTES (64u * 1024u)

static void HandleClient(int fd) {
    int noSigPipe = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, sizeof(noSigPipe));
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSMutableData *buf = [NSMutableData new];
        BOOL frameMode = NO;
        uint64_t owner = 0;
        BOOL broken = NO;
        uint8_t tmp[16384];
        while (!broken) {
            ssize_t n = read(fd, tmp, sizeof(tmp));
            if (n <= 0) break;
            [buf appendBytes:tmp length:(size_t)n];
            while (!broken) {
                if (!frameMode) {
                    const uint8_t *bytes = buf.bytes;
                    const uint8_t *newline = memchr(bytes, '\n', buf.length);
                    if (!newline) {
                        if (buf.length > SIMCAM_MAX_CONTROL_LINE_BYTES) broken = YES;
                        break;
                    }
                    NSUInteger length = (NSUInteger)(newline - bytes);
                    if (length > SIMCAM_MAX_CONTROL_LINE_BYTES) { broken = YES; break; }
                    NSData *line = [buf subdataWithRange:NSMakeRange(0, length)];
                    [buf replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0];
                    if (length > 0 && HandleControlLine(fd, line, &owner)) frameMode = YES;
                    continue;
                }
                if (buf.length < 4) break;
                const uint8_t *bytes = buf.bytes;
                uint32_t size = ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16)
                              | ((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
                if (size == 0 || size > SIMCAM_MAX_PUSHED_FRAME_BYTES) {
                    fprintf(stderr, "[serve-sim-camera] frame stream out of sync (%u bytes) — closing\n", size);
                    broken = YES;
                    break;
                }
                if (buf.length < (NSUInteger)size + 4) break;
                __block BOOL stale = NO;
                @autoreleasepool {
                    NSData *frame = [buf subdataWithRange:NSMakeRange(4, size)];
                    [buf replaceBytesInRange:NSMakeRange(0, size + 4) withBytes:NULL length:0];
                    dispatch_sync(gSourceQueue, ^{
                        if (gActiveSource != SimCamSourceStream || gStreamOwner != owner || gShouldExit) {
                            stale = YES;
                            return;
                        }
                        if (PublishEncodedFrame(frame)) {
                            gLastStreamFrameNs = MachAbsToNs(mach_absolute_time());
                            atomic_store_explicit(&gHeader->active, 1, memory_order_release);
                        }
                    });
                }
                // Close a stale connection so the server reconnects instead of sending dropped frames.
                if (stale) { broken = YES; break; }
            }
        }
        close(fd);
        if (frameMode) dispatch_sync(gSourceQueue, ^{
            if (gActiveSource == SimCamSourceStream && gStreamOwner == owner) {
                gStreamOwner = 0;
                atomic_store_explicit(&gHeader->active, 0, memory_order_release);
            }
        });
    });
}

static int OpenControlSocket(const char *path) {
    unlink(path);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    if (strlen(path) >= sizeof(addr.sun_path)) {
        fprintf(stderr, "control socket path too long: %s\n", path);
        close(fd); return -1;
    }
    strlcpy(addr.sun_path, path, sizeof(addr.sun_path));
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind"); close(fd); return -1;
    }
    if (listen(fd, 4) < 0) { perror("listen"); close(fd); return -1; }
    chmod(path, 0600);
    gControlListenFd = fd;
    gAcceptSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,
        fd, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_event_handler(gAcceptSource, ^{
        int client = accept(fd, NULL, NULL);
        if (client >= 0) HandleClient(client);
    });
    dispatch_resume(gAcceptSource);
    return fd;
}

#pragma mark - Listing / shm setup / main

static void ListDevices(void) {
    AVCaptureDeviceDiscoverySession *s = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:@[
            AVCaptureDeviceTypeBuiltInWideAngleCamera,
            AVCaptureDeviceTypeExternal,
            AVCaptureDeviceTypeContinuityCamera,
        ]
        mediaType:AVMediaTypeVideo
        position:AVCaptureDevicePositionUnspecified];
    for (AVCaptureDevice *d in s.devices) {
        printf("%s\t%s\n", d.uniqueID.UTF8String, d.localizedName.UTF8String);
    }
}

// Allocate the IOSurface ring and record their global IDs in the table.
static BOOL CreateSurfaces(void) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSDictionary *props = @{
        (id)kIOSurfaceWidth: @(gWidth),
        (id)kIOSurfaceHeight: @(gHeight),
        (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfacePixelFormat: @((uint32_t)kCVPixelFormatType_32BGRA),
        // Global so the simulator process can resolve the surface by ID.
        (id)kIOSurfaceIsGlobal: @YES,
    };
#pragma clang diagnostic pop
    for (uint32_t i = 0; i < SIMCAM_SURFACE_RING; i++) {
        IOSurfaceRef s = IOSurfaceCreate((__bridge CFDictionaryRef)props);
        if (!s) {
            fprintf(stderr, "[serve-sim-camera] IOSurfaceCreate failed at %u\n", i);
            return NO;
        }
        gSurfaces[i] = s;
        gSurfaceTable->ids[i] = IOSurfaceGetID(s);
    }
    gSurfaceTable->surfaceCount = SIMCAM_SURFACE_RING;
    gSurfaceTable->latestIndex = 0;
    return YES;
}

static void ReleaseSurfaces(void) {
    for (uint32_t i = 0; i < SIMCAM_SURFACE_RING; i++) {
        gSurfaceTextures[i] = nil;
        if (gSurfaces[i]) { CFRelease(gSurfaces[i]); gSurfaces[i] = NULL; }
    }
}

static int OpenShm(const char *name) {
    size_t size = (size_t)SimCamControlSizeWithContent();
    shm_unlink(name);
    int fd = shm_open(name, O_CREAT | O_RDWR, 0644);
    if (fd < 0) { perror("shm_open"); return -1; }
    if (ftruncate(fd, (off_t)size) < 0) { perror("ftruncate"); close(fd); return -1; }
    void *map = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (map == MAP_FAILED) { perror("mmap"); close(fd); return -1; }
    gHeader = (SimCamShmHeader *)map;
    gSurfaceTable = (SimCamSurfaceTable *)((uint8_t *)map + sizeof(SimCamShmHeader));
    gContentRects = (SimCamContentRect *)((uint8_t *)map + SimCamControlSize());
    memset(map, 0, size);
    if (!CreateSurfaces()) { close(fd); return -1; }
    gHeader->magic = SIMCAM_SHM_MAGIC;
    gHeader->version = 3;
    gHeader->ownerPid = (uint32_t)getpid();
    gHeader->width = gWidth;
    gHeader->height = gHeight;
    gHeader->pixelFormat = SIMCAM_PIXEL_BGRA;
    gHeader->bytesPerRow = (uint32_t)IOSurfaceGetBytesPerRow(gSurfaces[0]);
    gHeader->pixelByteSize = (uint64_t)gWidth * gHeight * 4;
    gHeader->mirrorMode = SIMCAM_MIRROR_UNSET; // dylib falls back to env
    atomic_store_explicit(&gHeader->active, 0, memory_order_release);
    return fd;
}

static uint8_t ParseMirrorCode(NSString *mode) {
    if ([mode isEqualToString:@"on"])    return SIMCAM_MIRROR_ON;
    if ([mode isEqualToString:@"off"])   return SIMCAM_MIRROR_OFF;
    if ([mode isEqualToString:@"auto"])  return SIMCAM_MIRROR_AUTO;
    if ([mode isEqualToString:@"unset"]) return SIMCAM_MIRROR_UNSET;
    return 0xFE; // sentinel for "invalid"
}
static NSString *MirrorName(uint8_t code) {
    switch (code) {
        case SIMCAM_MIRROR_ON:    return @"on";
        case SIMCAM_MIRROR_OFF:   return @"off";
        case SIMCAM_MIRROR_AUTO:  return @"auto";
        case SIMCAM_MIRROR_UNSET: return @"unset";
        default:                  return @"?";
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *initialSource = @"placeholder";
        NSString *initialArg = nil;
        const char *socketPath = NULL;
        BOOL list = NO;
        for (int i = 1; i < argc; i++) {
            const char *a = argv[i];
            if (!strcmp(a, "--shm") && i+1 < argc) gShmName = argv[++i];
            else if (!strcmp(a, "--socket") && i+1 < argc) socketPath = argv[++i];
            else if (!strcmp(a, "--source") && i+1 < argc) initialSource = @(argv[++i]);
            else if (!strcmp(a, "--arg") && i+1 < argc) initialArg = @(argv[++i]);
            else if (!strcmp(a, "--device") && i+1 < argc) initialArg = @(argv[++i]); // back-compat
            else if (!strcmp(a, "--width") && i+1 < argc) gWidth = (uint32_t)atoi(argv[++i]);
            else if (!strcmp(a, "--height") && i+1 < argc) gHeight = (uint32_t)atoi(argv[++i]);
            else if (!strcmp(a, "--list")) list = YES;
            else if (!strcmp(a, "--help") || !strcmp(a, "-h")) {
                printf("Usage: %s --shm <name> [--socket <path>] [--source placeholder|webcam|image] [--arg <value>] [--width N --height N]\n"
                       "       %s --list\n", argv[0], argv[0]);
                return 0;
            }
        }
        if (list) { ListDevices(); return 0; }
        if (!gShmName) { fprintf(stderr, "error: --shm <name> required\n"); return 64; }

        // Webcam back-compat: if user passed --device but no --source we
        // default to webcam mode rather than placeholder.
        if (initialArg && [initialSource isEqualToString:@"placeholder"]
                && [@[@"--device"] containsObject:@"--device"]) {
            // (no-op marker; --device implies webcam below if user intended it)
        }

        if (OpenShm(gShmName) < 0) return 1;
        fprintf(stderr, "[serve-sim-camera] shm \"%s\" + %u IOSurfaces (%ux%u BGRA)\n",
                gShmName, SIMCAM_SURFACE_RING, gWidth, gHeight);

        gSourceQueue = dispatch_queue_create("simcam.helper.source", DISPATCH_QUEUE_SERIAL);

        SimCamSourceKind k = ParseSourceName(initialSource);
        if (k == (SimCamSourceKind)-1) {
            fprintf(stderr, "[serve-sim-camera] unknown --source %s, defaulting to placeholder\n",
                initialSource.UTF8String);
            k = SimCamSourcePlaceholder;
        }
        if (socketPath) {
            if (OpenControlSocket(socketPath) < 0) {
                fprintf(stderr, "[serve-sim-camera] control socket open failed: %s\n", socketPath);
            } else {
                fprintf(stderr, "[serve-sim-camera] control socket %s\n", socketPath);
            }
        }

        NSString *err = nil;
        if (!SwitchSource(k, initialArg, &err)) {
            fprintf(stderr, "[serve-sim-camera] initial source failed: %s — falling back to placeholder\n",
                err.UTF8String ?: "?");
            (void)SwitchSource(SimCamSourcePlaceholder, nil, NULL);
        }

        signal(SIGINT, HandleSig);
        signal(SIGTERM, HandleSig);

        fprintf(stderr, "[serve-sim-camera] running — Ctrl+C to stop\n");
        while (!gShouldExit) {
            [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
        }
        atomic_store_explicit(&gHeader->active, 0, memory_order_release);
        if (gAcceptSource) dispatch_source_cancel(gAcceptSource);
        if (gControlListenFd >= 0) { close(gControlListenFd); if (socketPath) unlink(socketPath); }
        SwitchSource(SimCamSourceNone, nil, NULL);
        dispatch_sync(gSourceQueue, ^{ ReleaseSurfaces(); });
        if (gShmName) shm_unlink(gShmName);
        fprintf(stderr, "[serve-sim-camera] stopped\n");
        return 0;
    }
}
