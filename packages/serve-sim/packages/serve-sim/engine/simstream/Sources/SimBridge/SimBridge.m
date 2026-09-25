#import "SimBridge.h"
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurfaceObjC.h>
#import <objc/runtime.h>
#include <dlfcn.h>

// Signatures recovered from SimulatorKit (Xcode 27) disassembly; they match idb's FBSimulatorIndigoHID.
typedef struct IndigoMessage IndigoMessage;
typedef IndigoMessage *(*IndigoMouseFn)(CGPoint *point, CGPoint *point2, uint32_t target, NSInteger eventType, CGSize size, uint32_t edge);
typedef IndigoMessage *(*IndigoButtonFn)(uint32_t source, uint32_t direction, uint32_t target);
typedef IndigoMessage *(*IndigoKeyFn)(uint32_t usage, uint32_t direction);

static const uint32_t kIndigoTargetTouchscreen = 0x32;
static const uint32_t kIndigoTargetHardware = 0x33;
static const uint32_t kIndigoDown = 1, kIndigoUp = 2;
// NSEventType values, without pulling in AppKit.
static const NSInteger kLeftMouseDown = 1, kLeftMouseUp = 2, kLeftMouseDragged = 6;

// Private selectors, declared so ARC knows the ownership conventions.
@interface NSObject (SBPrivate)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)devices;
- (NSString *)stateString;
- (NSUUID *)UDID;
- (id)io;
- (NSArray *)ioPorts;
- (id)descriptor;
- (IOSurface *)framebufferSurface;
- (void)registerCallbackWithUUID:(NSUUID *)uuid damageRectanglesCallback:(void (^)(NSArray *rects))callback;
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfacesChangeCallback:(void (^)(void))callback;
- (instancetype)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(IndigoMessage *)message
           freeWhenDone:(BOOL)freeWhenDone
        completionQueue:(dispatch_queue_t)queue
             completion:(void (^)(NSError *error))completion;
@end

static NSError *SBError(NSString *message) {
    return [NSError errorWithDomain:@"SimBridge" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

@implementation SBSimulator {
    id _device;
    id _display;   // descriptor conforming to SimDisplayIOSurfaceRenderable
    id _hid;       // SimulatorKit.SimDeviceLegacyHIDClient
    IOSurface *_surface;
    NSUUID *_surfacesCallbackUUID;
    NSUUID *_damageCallbackUUID;
    dispatch_queue_t _hidQueue;
    IndigoMouseFn _mouse;
    IndigoButtonFn _button;
    IndigoKeyFn _key;
}

+ (instancetype)attachWithDeveloperDir:(NSString *)developerDir udid:(NSString *)udid error:(NSError **)error {
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
        if (error) *error = SBError(@"Could not load CoreSimulator.framework");
        return nil;
    }
    // Xcode 27 moved SimulatorKit from Developer/Library/PrivateFrameworks to SharedFrameworks.
    NSArray<NSString *> *kitPaths = @[
        [[developerDir stringByDeletingLastPathComponent]
            stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
        [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
    ];
    void *kit = NULL;
    for (NSString *path in kitPaths) {
        if ((kit = dlopen(path.fileSystemRepresentation, RTLD_NOW))) break;
    }
    if (!kit) {
        if (error) *error = SBError([NSString stringWithFormat:@"Could not load SimulatorKit from %@",
                                     [kitPaths componentsJoinedByString:@" or "]]);
        return nil;
    }

    id context = [(id)objc_getClass("SimServiceContext") sharedServiceContextForDeveloperDir:developerDir error:error];
    id deviceSet = [context defaultDeviceSetWithError:error];
    if (!deviceSet) return nil;

    id device = nil;
    for (id candidate in [deviceSet devices]) {
        BOOL booted = [[candidate stateString] isEqualToString:@"Booted"];
        BOOL matches = udid ? [[[candidate UDID] UUIDString] caseInsensitiveCompare:udid] == NSOrderedSame : booted;
        if (matches) {
            if (!booted) {
                if (error) *error = SBError([NSString stringWithFormat:@"Device %@ is not booted", udid]);
                return nil;
            }
            device = candidate;
            break;
        }
    }
    if (!device) {
        if (error) *error = SBError(udid ? [NSString stringWithFormat:@"No device %@", udid] : @"No booted simulator");
        return nil;
    }

    SBSimulator *sim = [[SBSimulator alloc] init];
    sim->_device = device;
    sim->_mouse = (IndigoMouseFn)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
    sim->_button = (IndigoButtonFn)dlsym(kit, "IndigoHIDMessageForButton");
    sim->_key = (IndigoKeyFn)dlsym(kit, "IndigoHIDMessageForKeyboardArbitrary");
    sim->_hidQueue = dispatch_queue_create("simstream.hid", DISPATCH_QUEUE_SERIAL);
    // One UUID per registration: registering a second callback under the same UUID replaces the first.
    sim->_surfacesCallbackUUID = [NSUUID UUID];
    sim->_damageCallbackUUID = [NSUUID UUID];

    if (![sim findDisplay:error]) return nil;

    sim->_hid = [[(id)NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient") alloc] initWithDevice:device error:error];
    if (!sim->_hid) return nil;
    return sim;
}

- (BOOL)findDisplay:(NSError **)error {
    Protocol *renderable = objc_getProtocol("SimDisplayIOSurfaceRenderable");
    size_t bestArea = 0;
    for (id port in [[_device io] ioPorts]) {
        id descriptor = [port descriptor];
        // Descriptors are ROCK remote proxies; their class names list the protocols they carry.
        BOOL isDisplay = (renderable && [descriptor conformsToProtocol:renderable]) ||
                         [NSStringFromClass([descriptor class]) containsString:@"SimDisplayIOSurfaceRenderable"];
        if (!isDisplay) continue;
        IOSurface *surface = [descriptor framebufferSurface];
        size_t area = (size_t)surface.width * (size_t)surface.height;
        if (surface && area > bestArea) {  // main display is the largest one
            bestArea = area;
            _display = descriptor;
            _surface = surface;
        }
    }
    if (!_display) {
        if (error) *error = SBError(@"No framebuffer display port found on the device");
        return NO;
    }
    return YES;
}

- (NSString *)name { return [_device valueForKey:@"name"]; }
- (NSString *)udid { return [[_device UDID] UUIDString]; }
- (NSString *)runtimeName {
    @try { return [[_device valueForKey:@"runtime"] valueForKey:@"name"] ?: @"?"; }
    @catch (__unused NSException *e) { return @"?"; }
}

- (IOSurfaceRef)framebuffer {
    @synchronized (self) {
        if (!_surface) _surface = [_display framebufferSurface];
        return (__bridge IOSurfaceRef)_surface;
    }
}

- (void)setFrameHandler:(void (^)(void))handler queue:(dispatch_queue_t)queue {
    __weak SBSimulator *weakSelf = self;
    [_display registerCallbackWithUUID:_surfacesCallbackUUID ioSurfacesChangeCallback:^{
        SBSimulator *strongSelf = weakSelf;
        if (!strongSelf) return;
        @synchronized (strongSelf) { strongSelf->_surface = nil; }
        dispatch_async(queue, handler);
    }];
    [_display registerCallbackWithUUID:_damageCallbackUUID damageRectanglesCallback:^(NSArray *rects) {
        dispatch_async(queue, handler);
    }];
}

- (BOOL)send:(IndigoMessage *)message {
    if (!message) return NO;
    [_hid sendWithMessage:message freeWhenDone:YES completionQueue:_hidQueue completion:^(NSError *error) {
        if (error) NSLog(@"[simstream] HID send failed: %@", error);
    }];
    return YES;
}

- (BOOL)sendTouch:(SBTouchPhase)phase x:(double)x y:(double)y edge:(uint32_t)edge {
    if (!_mouse) return NO;
    NSInteger type = phase == SBTouchPhaseDown ? kLeftMouseDown : phase == SBTouchPhaseUp ? kLeftMouseUp : kLeftMouseDragged;
    CGPoint point = CGPointMake(x, y);
    // Coordinates are divided by `size`, so a unit size lets us pass ratios directly.
    return [self send:_mouse(&point, NULL, kIndigoTargetTouchscreen, type, CGSizeMake(1, 1), edge)];
}

- (BOOL)sendButton:(SBButton)button down:(BOOL)down {
    if (!_button) return NO;
    uint32_t source = button == SBButtonHome ? 0x0 : button == SBButtonLock ? 0x1 : 0x400002;
    return [self send:_button(source, down ? kIndigoDown : kIndigoUp, kIndigoTargetHardware)];
}

- (BOOL)sendKey:(uint32_t)usage down:(BOOL)down {
    if (!_key) return NO;
    return [self send:_key(usage, down ? kIndigoDown : kIndigoUp)];
}

@end
