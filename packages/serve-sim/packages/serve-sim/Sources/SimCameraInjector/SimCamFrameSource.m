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

static size_t kFrameWidth = SIMCAM_DEFAULT_WIDTH;
static size_t kFrameHeight = SIMCAM_DEFAULT_HEIGHT;
static const double kFrameRate = 30.0;

static SimCamShmHeader *gShmHeader = NULL;
static SimCamSurfaceTable *gSurfaceTable = NULL;
static IOSurfaceRef gSurfaces[SIMCAM_SURFACE_RING];  // resolved from global IDs
static uint64_t gLastSeenSeq = 0;
static _Atomic bool gConnected = false;
static _Atomic uint64_t gConnectionGeneration = 0;

BOOL SimCamDeviceIsConnected(void) {
    return atomic_load_explicit(&gConnected, memory_order_acquire);
}

#pragma mark - Last-frame cache

static CVPixelBufferRef gLastFramePB = NULL;
static CGImageRef gLastFrameCGImage = NULL;
static NSLock *gFrameCacheLock = nil;
static dispatch_once_t gFrameCacheOnce;

static inline NSLock *SimCamFrameCacheLock(void) {
    dispatch_once(&gFrameCacheOnce, ^{ gFrameCacheLock = [NSLock new]; });
    return gFrameCacheLock;
}

static void SimCamCacheFrame(CVPixelBufferRef pb) {
    if (!pb) return;
    CIImage *ci = [CIImage imageWithCVPixelBuffer:pb];
    static CIContext *ctx = nil; static dispatch_once_t ctxOnce;
    dispatch_once(&ctxOnce, ^{ ctx = [CIContext contextWithOptions:nil]; });
    CGImageRef cg = [ctx createCGImage:ci fromRect:ci.extent];
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    CVPixelBufferRef oldPB = gLastFramePB;
    CGImageRef oldCG = gLastFrameCGImage;
    gLastFramePB = (CVPixelBufferRef)CFRetain(pb);
    gLastFrameCGImage = cg;
    [lock unlock];
    if (oldPB) CVPixelBufferRelease(oldPB);
    if (oldCG) CGImageRelease(oldCG);
}

static CVPixelBufferRef SimCamAcquireCachedPB(void) CF_RETURNS_RETAINED {
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    CVPixelBufferRef pb = gLastFramePB;
    if (pb) CFRetain(pb);
    [lock unlock];
    return pb;
}
static CGImageRef SimCamAcquireCachedCGImage(void) CF_RETURNS_RETAINED {
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    CGImageRef cg = gLastFrameCGImage;
    if (cg) CGImageRetain(cg);
    [lock unlock];
    return cg;
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
    CVPixelBufferRef cached = SimCamOutputSessionIsRunning(out) ? SimCamAcquireCachedPB() : NULL;
    if (cached) {
        CMVideoFormatDescriptionRef fd = NULL;
        CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, cached, &fd);
        CMSampleBufferRef sb = NULL;
        CMSampleTimingInfo timing = {
            .duration = CMTimeMake(1, (int32_t)kFrameRate),
            .presentationTimeStamp = CMTimeMake(0, (int32_t)kFrameRate),
            .decodeTimeStamp = kCMTimeInvalid,
        };
        if (fd) {
            CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, cached, true,
                NULL, NULL, fd, &timing, &sb);
            CFRelease(fd);
        }
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
    CGImageRef primed = SimCamAcquireCachedCGImage();
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

- (void)reapplyGravityToLayer:(AVCaptureVideoPreviewLayer *)layer {
    [_lock lock];
    BOOL tracked = [_layers containsObject:layer];
    [_lock unlock];
    if (!tracked) return;
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

- (void)pushFrameToLayers:(CVPixelBufferRef)pb generation:(uint64_t)generation {
    if (!pb) return;
    [_lock lock]; NSUInteger layerCount = _layers.count; [_lock unlock];
    if (layerCount == 0) return;

    CGImageRef cg = NULL;
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    if (pb == gLastFramePB && gLastFrameCGImage) {
        cg = CGImageRetain(gLastFrameCGImage);
    }
    [lock unlock];
    if (!cg) {
        CIImage *ci = [CIImage imageWithCVPixelBuffer:pb];
        static CIContext *ciCtx = nil; static dispatch_once_t once;
        dispatch_once(&once, ^{ ciCtx = [CIContext contextWithOptions:nil]; });
        cg = [ciCtx createCGImage:ci fromRect:ci.extent];
        if (!cg) return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        // Read the layers here, so one removed while the image was built stays cleared.
        NSArray *layerSnapshot;
        [self->_lock lock]; layerSnapshot = self->_layers.allObjects; [self->_lock unlock];
        for (AVCaptureVideoPreviewLayer *l in layerSnapshot) {
            if (!SimCamDeviceIsConnected() || generation != atomic_load(&gConnectionGeneration)) continue;
            l.contents = (__bridge id)cg;
        }
        CGImageRelease(cg);
    });
}

- (CVPixelBufferRef)newPixelBufferFromSurface CF_RETURNS_RETAINED {
    return [self newPixelBufferFromSurfaceForceFresh:NO];
}

// Wrap the latest shared IOSurface as a CVPixelBuffer — zero copy. Holding the
// pixel buffer keeps the surface in use, so the host writer renders into a
// different ring slot until we release it.
- (CVPixelBufferRef)newPixelBufferFromSurfaceForceFresh:(BOOL)force CF_RETURNS_RETAINED {
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

        uint64_t seqB = atomic_load_explicit(&gShmHeader->frameSeq, memory_order_acquire);
        if (!force && seqA != seqB) {
            CVPixelBufferRelease(pb);
            return NULL;
        }
        gLastSeenSeq = seqA;
        return pb;
    }
}

- (CVPixelBufferRef)currentPixelBuffer CF_RETURNS_RETAINED {
    if (!SimCamDeviceIsConnected()) return NULL;
    CVPixelBufferRef pb = [self newPixelBufferFromSurfaceForceFresh:YES];
    return pb;
}

- (NSData *)currentSnapshotJPEGAtQuality:(CGFloat)q {
    CVPixelBufferRef pb = [self currentPixelBuffer];
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

- (CVPixelBufferRef)newPixelBufferNoSignal CF_RETURNS_RETAINED {
    CVPixelBufferRef pb = NULL;
    NSDictionary *attrs = @{ (id)kCVPixelBufferIOSurfacePropertiesKey: @{} };
    CVReturn r = CVPixelBufferCreate(kCFAllocatorDefault, kFrameWidth, kFrameHeight,
        kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attrs, &pb);
    if (r != kCVReturnSuccess || !pb) return NULL;
    CVPixelBufferLockBaseAddress(pb, 0);
    uint8_t *base = (uint8_t *)CVPixelBufferGetBaseAddress(pb);
    size_t bpr = CVPixelBufferGetBytesPerRow(pb);
    for (size_t y = 0; y < kFrameHeight; y++) {
        uint8_t *row = base + y * bpr;
        for (size_t x = 0; x < kFrameWidth; x++) {
            row[x * 4 + 0] = 0x18;
            row[x * 4 + 1] = 0x18;
            row[x * 4 + 2] = 0x18;
            row[x * 4 + 3] = 0xFF;
        }
    }
    CVPixelBufferUnlockBaseAddress(pb, 0);
    return pb;
}

- (CMSampleBufferRef)newSampleBufferAtTime:(CMTime)pts CF_RETURNS_RETAINED {
    @synchronized([SimCamRegistry class]) {
        if (!SimCamDeviceIsConnected()) return NULL;
        CVPixelBufferRef pb = [self newPixelBufferFromSurface];
        if (pb) {
            SimCamCacheFrame(pb);
        } else {
            pb = SimCamAcquireCachedPB();
        }
        if (!pb) {
            static dispatch_once_t logOnce;
            dispatch_once(&logOnce, ^{
                simcam_log(@"no-signal fallback: shm=%@ frameSeq=%llu cache=empty",
                    gShmHeader ? @"attached" : @"unattached",
                    (unsigned long long)(gShmHeader ? atomic_load_explicit(&gShmHeader->frameSeq, memory_order_acquire) : 0));
            });
            pb = [self newPixelBufferNoSignal];
        }
        if (!pb) return NULL;

        CMVideoFormatDescriptionRef fd = NULL;
        CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pb, &fd);
        CMSampleTimingInfo timing = {
            .duration = CMTimeMake(1, (int32_t)kFrameRate),
            .presentationTimeStamp = pts,
            .decodeTimeStamp = kCMTimeInvalid,
        };
        CMSampleBufferRef sb = NULL;
        CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, pb, true, NULL, NULL, fd, &timing, &sb);
        if (fd) CFRelease(fd);
        CVPixelBufferRelease(pb);
        return sb;
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
        CMTime pts = CMTimeMake(frameIdx++, (int32_t)kFrameRate);
        CMSampleBufferRef sb = [self newSampleBufferAtTime:pts];
        if (!sb) return;
        CVImageBufferRef pb = CMSampleBufferGetImageBuffer(sb);
        [self pushFrameToLayers:pb generation:generation];
        NSArray *snapshot;
        [self->_lock lock]; snapshot = [self->_entries copy]; [self->_lock unlock];
        BOOL anyDead = NO;
        for (NSDictionary *e in snapshot) {
            AVCaptureVideoDataOutput *out = e[@"out"];
            SimCamWeakRef *ref = e[@"del"];
            id<AVCaptureVideoDataOutputSampleBufferDelegate> del = ref.target;
            dispatch_queue_t q = e[@"queue"];
            if (!del) { anyDead = YES; continue; }
            if (!out || !SimCamOutputSessionIsRunning(out)) continue;
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
        CFRelease(sb);
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
    kFrameWidth = hdr->width;
    kFrameHeight = hdr->height;
    simcam_log(@"shm \"%s\" attached (%ux%u, %u/%u IOSurfaces resolved)",
               shmName, hdr->width, hdr->height, resolved, count);
}

static void SimCamCloseSource(void) {
    if (gShmHeader) munmap(gShmHeader, (size_t)SimCamControlSize());
    gShmHeader = NULL;
    gSurfaceTable = NULL;
    gLastSeenSeq = 0;
    for (uint32_t i = 0; i < SIMCAM_SURFACE_RING; i++) {
        if (gSurfaces[i]) CFRelease(gSurfaces[i]);
        gSurfaces[i] = NULL;
    }
    NSLock *lock = SimCamFrameCacheLock();
    [lock lock];
    if (gLastFramePB) CVPixelBufferRelease(gLastFramePB);
    if (gLastFrameCGImage) CGImageRelease(gLastFrameCGImage);
    gLastFramePB = NULL;
    gLastFrameCGImage = NULL;
    [lock unlock];
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
