#import <Foundation/Foundation.h>
#import <IOSurface/IOSurfaceRef.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, SBTouchPhase) {
    SBTouchPhaseDown = 0,
    SBTouchPhaseMove = 1,
    SBTouchPhaseUp = 2,
};

typedef NS_ENUM(NSInteger, SBButton) {
    SBButtonHome = 0,
    SBButtonLock = 1,
    SBButtonSiri = 2,
};

/// A booted simulator, attached headlessly: frames come straight from the display's
/// framebuffer IOSurface and input goes straight into the guest's HID system.
/// No Simulator.app window, Screen Recording or Accessibility permission required.
@interface SBSimulator : NSObject

+ (nullable instancetype)attachWithDeveloperDir:(NSString *)developerDir
                                           udid:(nullable NSString *)udid
                                          error:(NSError **)error NS_SWIFT_NAME(attach(developerDir:udid:));

@property (nonatomic, readonly) NSString *name;
@property (nonatomic, readonly) NSString *udid;
@property (nonatomic, readonly) NSString *runtimeName;

/// The main display's framebuffer (BGRA). Cached; refreshed when the guest swaps surfaces.
- (nullable IOSurfaceRef)framebuffer CF_RETURNS_NOT_RETAINED;

/// Called whenever the guest reports damaged regions on the main display.
- (void)setFrameHandler:(void (^)(void))handler queue:(dispatch_queue_t)queue;

/// x/y are normalized [0, 1] over the display. Returns NO if SimulatorKit throttled the event
/// (it rate-limits drags to ~60 Hz) or it could not be sent.
- (BOOL)sendTouch:(SBTouchPhase)phase x:(double)x y:(double)y;
- (BOOL)sendButton:(SBButton)button down:(BOOL)down;
/// `usage` is a USB HID keyboard usage (page 0x07).
- (BOOL)sendKey:(uint32_t)usage down:(BOOL)down;

@end

NS_ASSUME_NONNULL_END
