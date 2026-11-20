#import "SimCamMetadata.h"
#import "SimCamFakes.h"
#import "SimCamLog.h"
#import "SimCamSwizzles.h"

#import <IOSurface/IOSurfaceRef.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>
#import <objc/runtime.h>
#include <stdatomic.h>

// An AVCaptureMetadataOutput on the fake session sees no frames, so codes in
// the injected feed never reach the app. The frame pump hands frames here, and
// Vision finds the codes. AVFoundation scans every frame; a scan in the
// Simulator takes a few hundred milliseconds, so scan a few times a second.
static const CFAbsoluteTime kScanInterval = 0.2;

#pragma mark - Code types

// AVFoundation's code types, and the Vision symbologies that find them.
static NSDictionary<AVMetadataObjectType, NSArray<VNBarcodeSymbology> *> *SimCamCodeTypes(void) {
    static NSDictionary *types;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableDictionary *t = [@{
            AVMetadataObjectTypeQRCode: @[ VNBarcodeSymbologyQR ],
            AVMetadataObjectTypeAztecCode: @[ VNBarcodeSymbologyAztec ],
            AVMetadataObjectTypeDataMatrixCode: @[ VNBarcodeSymbologyDataMatrix ],
            AVMetadataObjectTypePDF417Code: @[ VNBarcodeSymbologyPDF417 ],
            AVMetadataObjectTypeEAN13Code: @[ VNBarcodeSymbologyEAN13 ],
            AVMetadataObjectTypeEAN8Code: @[ VNBarcodeSymbologyEAN8 ],
            AVMetadataObjectTypeUPCECode: @[ VNBarcodeSymbologyUPCE ],
            AVMetadataObjectTypeCode128Code: @[ VNBarcodeSymbologyCode128 ],
            AVMetadataObjectTypeCode39Code: @[ VNBarcodeSymbologyCode39, VNBarcodeSymbologyCode39FullASCII ],
            AVMetadataObjectTypeCode39Mod43Code:
                @[ VNBarcodeSymbologyCode39Checksum, VNBarcodeSymbologyCode39FullASCIIChecksum ],
            AVMetadataObjectTypeCode93Code: @[ VNBarcodeSymbologyCode93, VNBarcodeSymbologyCode93i ],
            AVMetadataObjectTypeITF14Code: @[ VNBarcodeSymbologyITF14 ],
            AVMetadataObjectTypeInterleaved2of5Code: @[ VNBarcodeSymbologyI2of5, VNBarcodeSymbologyI2of5Checksum ],
        } mutableCopy];
        if (@available(iOS 15.4, *)) t[AVMetadataObjectTypeCodabarCode] = @[ VNBarcodeSymbologyCodabar ];
        types = t;
    });
    return types;
}

static AVMetadataObjectType SimCamTypeForSymbology(VNBarcodeSymbology symbology) {
    for (AVMetadataObjectType type in SimCamCodeTypes()) {
        if ([SimCamCodeTypes()[type] containsObject:symbology]) return type;
    }
    return nil;
}

#pragma mark - SimCamFakeCodeObject

// AVFoundation has no public initializer for a code object. Points are the
// code's corners, normalized to the injected frame with the origin at the top
// left: AVFoundation reports codes in device coordinates, and the injected
// frame is the device's whole picture.
@interface SimCamFakeCodeObject : AVMetadataMachineReadableCodeObject
@property (nonatomic, readonly) NSArray<NSValue *> *points;
@property (nonatomic, readonly) CGSize frameSize;
@end

@implementation SimCamFakeCodeObject {
    AVMetadataObjectType _type;
    NSString *_stringValue;
    CIBarcodeDescriptor *_descriptor;
}
// Built without AVMetadataObject's initializer, like the fake connection: skip its -dealloc.
static void SimCamFakeCodeObjectDealloc(__unsafe_unretained id self, SEL cmd) {
    ((void (*)(id, SEL))class_getMethodImplementation([NSObject class], cmd))(self, cmd);
}
+ (void)initialize {
    if (self != [SimCamFakeCodeObject class]) return;
    class_addMethod(self, sel_registerName("dealloc"), (IMP)SimCamFakeCodeObjectDealloc, "v@:");
}
+ (instancetype)allocWithZone:(NSZone *)zone {
    return class_createInstance([SimCamFakeCodeObject class], 0);
}
+ (instancetype)codeWithType:(AVMetadataObjectType)type
                       value:(NSString *)value
                      points:(NSArray<NSValue *> *)points
                   frameSize:(CGSize)frameSize
                  descriptor:(CIBarcodeDescriptor *)descriptor {
    SimCamFakeCodeObject *code = [self alloc];
    if (code) {
        code->_type = type;
        code->_stringValue = [value copy];
        code->_points = [points copy];
        code->_frameSize = frameSize;
        code->_descriptor = descriptor;
    }
    return code;
}
- (AVMetadataObjectType)type { return _type; }
- (NSString *)stringValue { return _stringValue; }
- (CIBarcodeDescriptor *)descriptor { return _descriptor; }
- (CMTime)time { return kCMTimeInvalid; }
- (CMTime)duration { return kCMTimeInvalid; }
- (NSArray<NSDictionary *> *)corners {
    NSMutableArray *corners = [NSMutableArray arrayWithCapacity:_points.count];
    for (NSValue *point in _points) {
        [corners addObject:(__bridge_transfer NSDictionary *)CGPointCreateDictionaryRepresentation(point.CGPointValue)];
    }
    return corners;
}
- (CGRect)bounds {
    CGRect bounds = CGRectNull;
    for (NSValue *point in _points) bounds = CGRectUnion(bounds, (CGRect){ point.CGPointValue, CGSizeZero });
    return CGRectIsNull(bounds) ? CGRectZero : bounds;
}
- (NSString *)description {
    return [NSString stringWithFormat:@"<%@ %@ %@ %@>", self.class, _type, _stringValue, NSStringFromCGRect(self.bounds)];
}
@end

#pragma mark - Detection

// Vision puts the origin at the bottom left.
static NSValue *SimCamTopLeftOrigin(CGPoint p) {
    return [NSValue valueWithCGPoint:CGPointMake(p.x, 1.0 - p.y)];
}

static NSArray<SimCamFakeCodeObject *> *SimCamDetectCodes(CVPixelBufferRef frame, NSSet<AVMetadataObjectType> *wanted) {
    NSMutableArray<VNBarcodeSymbology> *symbologies = [NSMutableArray new];
    for (AVMetadataObjectType type in wanted) [symbologies addObjectsFromArray:SimCamCodeTypes()[type] ?: @[]];
    VNDetectBarcodesRequest *request = [VNDetectBarcodesRequest new];
    // In the Simulator, revisions 3 and 4 (the default) find no codes, and
    // Vision has no inference context unless it runs on the CPU.
    request.revision = VNDetectBarcodesRequestRevision2;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    request.usesCPUOnly = YES;
#pragma clang diagnostic pop
    request.symbologies = symbologies;
    NSError *error = nil;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:frame options:@{}];
    if (![handler performRequests:@[ request ] error:&error]) {
        static dispatch_once_t once;
        dispatch_once(&once, ^{ simcam_log(@"Vision cannot scan for codes: %@", error.localizedDescription); });
        return @[];
    }
    // Vision reports a 1D code once for every line that crosses it; AVFoundation reports it once.
    NSMutableArray<SimCamFakeCodeObject *> *codes = [NSMutableArray new];
    NSMutableSet<NSString *> *seen = [NSMutableSet new];
    CGSize size = CGSizeMake(CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame));
    for (VNBarcodeObservation *found in request.results) {
        AVMetadataObjectType type = SimCamTypeForSymbology(found.symbology);
        NSString *value = found.payloadStringValue;
        if (!type || !value || ![wanted containsObject:type]) continue;
        if ([seen containsObject:[type stringByAppendingString:value]]) continue;
        [seen addObject:[type stringByAppendingString:value]];
        NSArray *points = @[
            SimCamTopLeftOrigin(found.topLeft), SimCamTopLeftOrigin(found.topRight),
            SimCamTopLeftOrigin(found.bottomRight), SimCamTopLeftOrigin(found.bottomLeft),
        ];
        [codes addObject:[SimCamFakeCodeObject codeWithType:type value:value points:points frameSize:size
                                                 descriptor:found.barcodeDescriptor]];
    }
    return codes;
}

// A still image stays in one surface, and the helper rewrites a surface for
// every new video frame, so the surface and its seed say whether a frame is new.
static uint64_t SimCamFrameKey(CVPixelBufferRef frame) {
    IOSurfaceRef surface = CVPixelBufferGetIOSurface(frame);
    return surface ? (uint64_t)IOSurfaceGetID(surface) << 32 | IOSurfaceGetSeed(surface) : 0;
}

#pragma mark - Attached outputs

static char kSimCamMetadataSessionKey;

static NSHashTable<AVCaptureMetadataOutput *> *SimCamAttachedOutputs(void) {
    static NSHashTable *outputs;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ outputs = [NSHashTable weakObjectsHashTable]; });
    return outputs;
}

static BOOL SimCamMetadataIsAttached(AVCaptureMetadataOutput *output) {
    @synchronized(SimCamAttachedOutputs()) {
        return [SimCamAttachedOutputs() containsObject:output];
    }
}

void SimCamMetadataAttach(AVCaptureMetadataOutput *output, AVCaptureSession *session) {
    if (![output isKindOfClass:[AVCaptureMetadataOutput class]]) return;
    SimCamWeakRef *ref = [SimCamWeakRef new];
    ref.target = session;
    objc_setAssociatedObject(output, &kSimCamMetadataSessionKey, ref, OBJC_ASSOCIATION_RETAIN);
    @synchronized(SimCamAttachedOutputs()) {
        [SimCamAttachedOutputs() addObject:output];
    }
}

void SimCamMetadataDetach(AVCaptureMetadataOutput *output) {
    if (![output isKindOfClass:[AVCaptureMetadataOutput class]]) return;
    @synchronized(SimCamAttachedOutputs()) {
        [SimCamAttachedOutputs() removeObject:output];
    }
    objc_setAssociatedObject(output, &kSimCamMetadataSessionKey, nil, OBJC_ASSOCIATION_RETAIN);
}

static void SimCamDeliverCodes(AVCaptureMetadataOutput *output, NSArray<SimCamFakeCodeObject *> *codes) {
    NSArray<AVMetadataObjectType> *types = output.metadataObjectTypes;
    NSMutableArray<AVMetadataObject *> *found = [NSMutableArray new];
    for (SimCamFakeCodeObject *code in codes) {
        if ([types containsObject:code.type]) [found addObject:code];
    }
    id<AVCaptureMetadataOutputObjectsDelegate> delegate = output.metadataObjectsDelegate;
    if (found.count == 0 || ![delegate respondsToSelector:@selector(captureOutput:didOutputMetadataObjects:fromConnection:)]) {
        return;
    }
    AVCaptureConnection *connection = SimCamFakeConnectionForOutput(output);
    dispatch_async(output.metadataObjectsCallbackQueue ?: dispatch_get_main_queue(), ^{
        [delegate captureOutput:output didOutputMetadataObjects:found fromConnection:connection];
    });
}

void SimCamMetadataSampleFrame(CVPixelBufferRef frame) {
    static atomic_bool scanning;
    static CFAbsoluteTime lastScan;  // The pump's serial queue is the only caller.
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (!frame || atomic_load(&scanning) || now - lastScan < kScanInterval) return;

    NSArray<AVCaptureMetadataOutput *> *outputs;
    @synchronized(SimCamAttachedOutputs()) {
        outputs = SimCamAttachedOutputs().allObjects;
    }
    NSMutableArray<AVCaptureMetadataOutput *> *targets = [NSMutableArray new];
    NSMutableSet<AVMetadataObjectType> *wanted = [NSMutableSet new];
    for (AVCaptureMetadataOutput *output in outputs) {
        AVCaptureSession *session = ((SimCamWeakRef *)objc_getAssociatedObject(output, &kSimCamMetadataSessionKey)).target;
        NSArray *types = output.metadataObjectTypes;
        // @ref LLP 0007#not-there-yet — expo-camera never starts its session in the Simulator, so follow the connection.
        if (!session || types.count == 0 || !output.metadataObjectsDelegate) continue;
        if (!SimCamFakeConnectionForOutput(output).isEnabled) continue;
        [targets addObject:output];
        [wanted addObjectsFromArray:types];
    }
    if (targets.count == 0) return;

    lastScan = now;
    atomic_store(&scanning, true);
    CVPixelBufferRetain(frame);
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("dev.servesim.simcam.metadata", DISPATCH_QUEUE_SERIAL);
    });
    dispatch_async(queue, ^{
        static uint64_t scannedKey;  // Only this queue touches these three.
        static NSSet<AVMetadataObjectType> *scannedTypes;
        static NSArray<SimCamFakeCodeObject *> *scannedCodes;
        uint64_t key = SimCamFrameKey(frame);
        if (key == 0 || key != scannedKey || ![wanted isSubsetOfSet:scannedTypes]) {
            scannedCodes = SimCamDetectCodes(frame, wanted);
            scannedKey = key;
            scannedTypes = wanted;
        }
        CVPixelBufferRelease(frame);
        for (AVCaptureMetadataOutput *output in targets) SimCamDeliverCodes(output, scannedCodes);
        atomic_store(&scanning, false);
    });
}

#pragma mark - Swizzles

@interface AVCaptureMetadataOutput (SimCamMetadata)
@end
@implementation AVCaptureMetadataOutput (SimCamMetadata)
- (NSArray<AVMetadataObjectType> *)simcam_availableMetadataObjectTypes {
    if (!SimCamMetadataIsAttached(self)) return [self simcam_availableMetadataObjectTypes];
    return SimCamCodeTypes().allKeys;
}
@end

@interface AVCaptureVideoPreviewLayer (SimCamMetadata)
@end
@implementation AVCaptureVideoPreviewLayer (SimCamMetadata)
// The pump fills the layer with the frame aspect-fill, and mirrors the layer
// with a transform (SimCamRegistry), so map the corners the same way.
- (AVMetadataObject *)simcam_transformedMetadataObjectForMetadataObject:(AVMetadataObject *)object {
    if (![object isKindOfClass:[SimCamFakeCodeObject class]]) {
        return [self simcam_transformedMetadataObjectForMetadataObject:object];
    }
    SimCamFakeCodeObject *code = (SimCamFakeCodeObject *)object;
    CGSize layer = self.bounds.size, frame = code.frameSize;
    if (frame.width <= 0 || frame.height <= 0) return nil;
    CGFloat scale = MAX(layer.width / frame.width, layer.height / frame.height);
    CGFloat width = frame.width * scale, height = frame.height * scale;
    BOOL mirrored = SimCamShouldMirror(SimCamPositionOf(self));
    NSMutableArray<NSValue *> *points = [NSMutableArray arrayWithCapacity:code.points.count];
    for (NSValue *value in code.points) {
        CGPoint p = value.CGPointValue;
        CGFloat x = (layer.width - width) / 2 + p.x * width;
        [points addObject:[NSValue valueWithCGPoint:CGPointMake(mirrored ? layer.width - x : x,
                                                                (layer.height - height) / 2 + p.y * height)]];
    }
    return [SimCamFakeCodeObject codeWithType:code.type value:code.stringValue points:points
                                    frameSize:frame descriptor:code.descriptor];
}
@end

void SimCamInstallMetadataSwizzles(void) {
    Class output = [AVCaptureMetadataOutput class];
    SimCamSwizzleInstanceMethod(output, @selector(availableMetadataObjectTypes),
        @selector(simcam_availableMetadataObjectTypes));
    SimCamSwizzleInstanceMethod([AVCaptureVideoPreviewLayer class],
        @selector(transformedMetadataObjectForMetadataObject:),
        @selector(simcam_transformedMetadataObjectForMetadataObject:));
}
