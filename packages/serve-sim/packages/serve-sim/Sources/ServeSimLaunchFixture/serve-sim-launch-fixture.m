// Fixture app for the launch tests. Records every launch and opened URL in its
// own data container so a test can read back what the launch carried.
// UIKit puts the app on the scene lifecycle, so URLs arrive at the scene
// delegate; the app delegate never sees them.

#import <AVFoundation/AVFoundation.h>
#import <CoreMotion/CoreMotion.h>
#import <UIKit/UIKit.h>

static void Record(NSString *kind, NSString *detail) {
  NSArray<NSString *> *dirs =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *path = [dirs.firstObject stringByAppendingPathComponent:@"launches.tsv"];
  NSString *line = [NSString stringWithFormat:@"%@\t%d\t%@\n", kind, getpid(), detail];

  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (handle == nil) {
    [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    return;
  }
  [handle seekToEndOfFile];
  [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
  [handle closeFile];
}

// The launch argument after `flag`, for options that carry a value.
static NSString *FixtureArgument(NSString *flag) {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger i = [arguments indexOfObject:flag];
  return i != NSNotFound && i + 1 < arguments.count ? arguments[i + 1] : nil;
}

static NSString *ColorName(unsigned r, unsigned g, unsigned b) {
  if (r > 200 && g > 200 && b > 200) return @"W";
  if (r > 200 && g < 60 && b < 60) return @"R";
  if (g > 200 && r < 60 && b < 60) return @"G";
  if (b > 200 && r < 60 && g < 60) return @"B";
  if (r < 60 && g < 60 && b < 60) return @"K";
  return @"?";
}

// Colors at the quadrant centers of the centered square of side `side`, top-left, top-right,
// bottom-left, bottom-right. A quadrant test source shows which way the frame is turned.
static NSString *QuadrantNames(const unsigned char *base, size_t stride, size_t width, size_t height,
                               double side, BOOL bgra) {
  NSMutableArray<NSString *> *names = [NSMutableArray new];
  for (int row = -1; row <= 1; row += 2) {
    for (int column = -1; column <= 1; column += 2) {
      size_t x = (size_t)((double)width / 2 + column * side / 4), y = (size_t)((double)height / 2 + row * side / 4);
      const unsigned char *p = base + y * stride + x * 4;
      [names addObject:bgra ? ColorName(p[2], p[1], p[0]) : ColorName(p[0], p[1], p[2])];
    }
  }
  return [names componentsJoinedByString:@","];
}

static NSString *ImageQuadrants(CGImageRef image) {
  size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
  unsigned char *bytes = calloc(width * height, 4);
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(bytes, width, height, 8, width * 4, space,
      (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGContextDrawImage(context, CGRectMake(0, 0, (CGFloat)width, (CGFloat)height), image);
  NSString *names = QuadrantNames(bytes, width * 4, width, height, (double)MIN(width, height), NO);
  CGContextRelease(context);
  CGColorSpaceRelease(space);
  free(bytes);
  return names;
}

static void RecordURLContexts(NSSet<UIOpenURLContext *> *contexts) {
  for (UIOpenURLContext *context in contexts) {
    Record(@"openurl", context.URL.absoluteString);
  }
}

// Recorded from +load so a launch that is terminated before
// didFinishLaunchingWithOptions still leaves a trace.
@interface FixtureStartRecorder : NSObject
@end

@implementation FixtureStartRecorder

+ (void)load {
  Record(@"start", @"");
}

@end

// The typing E2E reads the same app-owned log as the launch tests. Recording
// editing changes proves delivery to UIKit, rather than just HID dispatch.
@interface FixtureKeyboardController : UIViewController
@property(nonatomic, strong) UITextField *field;
@end

@implementation FixtureKeyboardController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemGreenColor;
  self.field = [[UITextField alloc] initWithFrame:CGRectMake(24, 100, 300, 44)];
  self.field.borderStyle = UITextBorderStyleRoundedRect;
  self.field.accessibilityIdentifier = @"typing-field";
  self.field.autocapitalizationType = UITextAutocapitalizationTypeNone;
  self.field.autocorrectionType = UITextAutocorrectionTypeNo;
  self.field.spellCheckingType = UITextSpellCheckingTypeNo;
  [self.field addTarget:self action:@selector(textChanged:)
      forControlEvents:UIControlEventEditingChanged];
  [self.view addSubview:self.field];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  if ([self.field becomeFirstResponder]) Record(@"keyboard-ready", @"");
}

- (void)textChanged:(UITextField *)field {
  Record(@"text", field.text ?: @"");
}

@end

@interface FixtureInputView : UIView
@end

@implementation FixtureInputView

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  Record(@"touch-began", @"");
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  Record(@"touch-moved", @"");
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  Record(@"touch-ended", @"");
}

@end

@interface FixtureInputController : UIViewController
@end

@implementation FixtureInputController

- (void)loadView {
  self.view = [[FixtureInputView alloc] init];
  self.view.backgroundColor = UIColor.systemGreenColor;
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  Record(@"input-ready", @"");
}

@end

@interface QueuedFrameRecorder : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@property(atomic) NSInteger count;
@end

@implementation QueuedFrameRecorder
- (void)captureOutput:(AVCaptureOutput *)output
 didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        fromConnection:(AVCaptureConnection *)connection {
  self.count++;
  dispatch_async(dispatch_get_main_queue(), ^{ Record(@"queued-sample", @""); });
}
@end

@interface PhotoRecorder : NSObject <AVCapturePhotoCaptureDelegate>
@end

@implementation PhotoRecorder
- (void)captureOutput:(AVCapturePhotoOutput *)output
    didCapturePhotoForResolvedSettings:(AVCaptureResolvedPhotoSettings *)resolvedSettings {
  Record(@"photo", @"captured");
}

- (void)captureOutput:(AVCapturePhotoOutput *)output
    didFinishProcessingPhoto:(AVCapturePhoto *)photo
                       error:(NSError *)error {
  UIImage *image = [UIImage imageWithData:photo.fileDataRepresentation];
  Record(@"photo", error ? [NSString stringWithFormat:@"processed error=%ld", (long)error.code]
                         : [NSString stringWithFormat:@"processed %.0fx%.0f", image.size.width, image.size.height]);
  if (!error) Record(@"photo-quad", ImageQuadrants(image.CGImage));
}

- (void)captureOutput:(AVCapturePhotoOutput *)output
    didFinishCaptureForResolvedSettings:(AVCaptureResolvedPhotoSettings *)resolvedSettings
                                  error:(NSError *)error {
  Record(@"photo", [NSString stringWithFormat:@"finished error=%ld", (long)error.code]);
}
@end

@interface RunningChangeCounter : NSObject
@property(nonatomic) int changes;
@end

@implementation RunningChangeCounter
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context {
  self.changes++;
}
@end

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate, AVCaptureVideoDataOutputSampleBufferDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) AVCaptureSession *session;
@property(nonatomic, strong) AVCaptureVideoPreviewLayer *preview;
@property(nonatomic, copy) NSString *lastPixel;
@property(nonatomic, strong) AVCaptureVideoDataOutput *queuedOutput;
@property(nonatomic, strong) QueuedFrameRecorder *queuedRecorder;
@property(nonatomic, strong) dispatch_queue_t queuedFrames;
@property(nonatomic) BOOL changedGravity;
@property(nonatomic) BOOL sampledPreview;
@property(nonatomic, copy) NSString *lastQuad;
@property(nonatomic, copy) NSString *lastBox;
@property(nonatomic, strong) RunningChangeCounter *runningChanges;
@property(nonatomic, strong) AVCaptureVideoDataOutput *stopQueueOutput;
@property(nonatomic, strong) AVCapturePhotoOutput *photoOutput;
@property(nonatomic, strong) PhotoRecorder *photoRecorder;
@property(nonatomic) BOOL photoTaken;
@end

@implementation FixtureSceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--keyboard-test"]) {
    self.window.rootViewController = [[FixtureKeyboardController alloc] init];
  } else if ([NSProcessInfo.processInfo.arguments containsObject:@"--input-test"]) {
    self.window.rootViewController = [[FixtureInputController alloc] init];
  } else {
    self.window.rootViewController = [[UIViewController alloc] init];
  }
  self.window.rootViewController.view.backgroundColor = UIColor.systemGreenColor;
  [self.window makeKeyAndVisible];
  UIView *root = self.window.rootViewController.view;
  Record(@"permission", [NSString stringWithFormat:@"%ld", (long)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]]);

  if ([NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureNativeFirst"]) {
    [self runNativeFirstSession];
    return;
  }
  if ([NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureOutputOnly"]) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      self.session = [AVCaptureSession new];
      [self.session addOutput:[AVCaptureVideoDataOutput new]];
      Record(@"motion-available", [NSString stringWithFormat:@"injected=%d available=%d",
          NSClassFromString(@"SimCamFakeDevice") != nil, [CMMotionManager new].accelerometerAvailable]);
    });
    return;
  }
  [self showCameraIn:root];
  [NSNotificationCenter.defaultCenter addObserverForName:AVCaptureDeviceWasConnectedNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(NSNotification *note) {
    Record(@"connected", ((AVCaptureDevice *)note.object).uniqueID);
    if (self.session == nil) [self showCameraIn:root];
  }];
  [NSNotificationCenter.defaultCenter addObserverForName:AVCaptureDeviceWasDisconnectedNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(NSNotification *note) {
    // An app can keep its session after the camera goes away and still ask for a photo.
    if (self.photoOutput) {
      [self.photoOutput capturePhotoWithSettings:[AVCapturePhotoSettings photoSettings] delegate:self.photoRecorder];
      self.photoOutput = nil;
    }
    AVCaptureDevice *device = note.object;
    AVCaptureDevice *legacy = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    Record(@"disconnected", [NSString stringWithFormat:@"connected=%d legacy=%d devices=%lu permission=%ld",
        device.isConnected, legacy != nil,
        (unsigned long)[AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[AVCaptureDeviceTypeBuiltInWideAngleCamera] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified].devices.count,
        (long)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]]);
    [self.session stopRunning];
    self.session = nil;
    [self.preview removeFromSuperlayer];
    self.preview = nil;
    self.lastPixel = nil;
    if (self.queuedFrames) {
      dispatch_queue_t queue = self.queuedFrames;
      self.queuedFrames = nil;
      dispatch_resume(queue);
      dispatch_async(queue, ^{
        dispatch_async(dispatch_get_main_queue(), ^{ Record(@"queue-drained", @""); });
      });
    }
  }];
  // Opening the camera later than the capability loader's load delay, to tell a
  // capability that arrived late from one that never arrived.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureCameraLate"]) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ [self showCameraIn:root]; });
  }
  RecordURLContexts(connectionOptions.URLContexts);
}

// Starts the session before the fake camera connects, then counts what observers hear once it joins.
- (void)runNativeFirstSession {
  AVCaptureSession *session = [[AVCaptureSession alloc] init];
  __block int starts = 0;
  __block int stops = 0;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:AVCaptureSessionDidStartRunningNotification
                      object:session
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(__unused NSNotification *note) { starts++; }];
  [center addObserverForName:AVCaptureSessionDidStopRunningNotification
                      object:session
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(__unused NSNotification *note) { stops++; }];
  self.runningChanges = [RunningChangeCounter new];
  [session addObserver:self.runningChanges forKeyPath:@"running" options:0 context:NULL];
  self.session = session;
  BOOL earlyOutput = [NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureEarlyOutput"];
  if (earlyOutput) {
    AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
    [output setSampleBufferDelegate:self queue:dispatch_get_main_queue()];
    [session addOutput:output];
  }
  [session startRunning];
  Record(@"native-first-started", @"");

  BOOL (^join)(NSString *) = ^BOOL(NSString *via) {
    AVCaptureDevice *device =
        [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                           mediaType:AVMediaTypeVideo
                                            position:AVCaptureDevicePositionBack];
    AVCaptureDeviceInput *input = device ? [AVCaptureDeviceInput deviceInputWithDevice:device error:NULL] : nil;
    if (input == nil) return NO;
    int startsBefore = starts;
    int stopsBefore = stops;
    int changesBefore = self.runningChanges.changes;
    [session addInput:input];
    if (!earlyOutput) {
      [session startRunning];
      [session stopRunning];
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      Record(@"native-first", [NSString stringWithFormat:@"via=%@ starts=%d stops=%d kvo=%d running=%d",
          via, starts - startsBefore, stops - stopsBefore, self.runningChanges.changes - changesBefore, session.running]);
    });
    return YES;
  };
  __block BOOL joined = join(@"launch");
  if (joined) return;
  [center addObserverForName:AVCaptureDeviceWasConnectedNotification
                      object:nil
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(__unused NSNotification *note) {
    if (!joined) joined = join(@"connect");
  }];
}

// Records what it saw either way, so a test can assert the feed without
// looking at a screenshot.
- (void)showCameraIn:(UIView *)view {
  AVCaptureDevice *device =
      [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                         mediaType:AVMediaTypeVideo
                                          position:AVCaptureDevicePositionBack];
  if (device == nil) {
    Record(@"camera", @"no device");
    return;
  }

  NSError *error = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
  AVCaptureSession *session = [[AVCaptureSession alloc] init];
  if (input == nil || ![session canAddInput:input]) {
    Record(@"camera", error.localizedDescription ?: @"input refused");
    return;
  }
  [session addInput:input];
  AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
  [output setSampleBufferDelegate:self queue:dispatch_get_main_queue()];
  [session addOutput:output];
  if ([NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixturePhoto"]) {
    self.photoOutput = [AVCapturePhotoOutput new];
    self.photoRecorder = [PhotoRecorder new];
    [session addOutput:self.photoOutput];
  }
  NSString *angle = FixtureArgument(@"-ServeSimFixtureAngle");
  if (angle) {
    if (@available(iOS 17.0, *)) {
      [output connectionWithMediaType:AVMediaTypeVideo].videoRotationAngle = angle.doubleValue;
      [self.photoOutput connectionWithMediaType:AVMediaTypeVideo].videoRotationAngle = angle.doubleValue;
    }
  }

  // Assigning the session goes through setSession:, which is where serve-sim
  // hooks the preview. layerWithSession: sets it without that.
  AVCaptureVideoPreviewLayer *preview = [[AVCaptureVideoPreviewLayer alloc] init];
  preview.session = session;
  NSString *previewAngle = FixtureArgument(@"-ServeSimFixturePreviewAngle");
  if (previewAngle) {
    if (@available(iOS 17.0, *)) preview.connection.videoRotationAngle = previewAngle.doubleValue;
    Record(@"preview-connection", preview.connection.videoPreviewLayer == preview ? @"layer" : @"other");
  }
  preview.videoGravity = [NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureGravityAspect"]
      ? AVLayerVideoGravityResizeAspect : AVLayerVideoGravityResizeAspectFill;
  preview.frame = view.bounds;
  [view.layer addSublayer:preview];
  self.session = session;
  self.preview = preview;
  self.lastPixel = nil;

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [session startRunning];
  });
  Record(@"camera", device.localizedName);
}

- (void)captureOutput:(AVCaptureOutput *)output
 didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        fromConnection:(AVCaptureConnection *)connection {
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
  const unsigned char *pixel = (const unsigned char *)CVPixelBufferGetBaseAddress(pixelBuffer)
      + (CVPixelBufferGetHeight(pixelBuffer) / 2) * CVPixelBufferGetBytesPerRow(pixelBuffer)
      + (CVPixelBufferGetWidth(pixelBuffer) / 2) * 4;
  Record(@"sample", @"");
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  if (self.photoOutput && !self.photoTaken) {
    self.photoTaken = YES;
    [self.photoOutput capturePhotoWithSettings:[AVCapturePhotoSettings photoSettings] delegate:self.photoRecorder];
  }
  if (!self.queuedOutput && [arguments containsObject:@"-ServeSimFixtureQueuedFrames"]) {
    self.queuedOutput = [AVCaptureVideoDataOutput new];
    self.queuedRecorder = [QueuedFrameRecorder new];
    self.queuedFrames = dispatch_queue_create("fixture.queued-frames", DISPATCH_QUEUE_SERIAL);
    dispatch_suspend(self.queuedFrames);
    [self.queuedOutput setSampleBufferDelegate:self.queuedRecorder queue:self.queuedFrames];
    Record(@"queue-suspended", @"");
  }
  if (self.preview.session && [arguments containsObject:@"-ServeSimFixtureMovePreview"]) {
    AVCaptureVideoPreviewLayer *preview = self.preview;
    preview.session = nil;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      Record(@"preview-contents", preview.contents ? @"set" : @"nil");
    });
  }
  if (!self.stopQueueOutput && [arguments containsObject:@"-ServeSimFixtureStopWithQueuedSamples"]) {
    self.stopQueueOutput = [AVCaptureVideoDataOutput new];
    QueuedFrameRecorder *recorder = [QueuedFrameRecorder new];
    dispatch_queue_t queue = dispatch_queue_create("fixture.stop-queue", DISPATCH_QUEUE_SERIAL);
    dispatch_suspend(queue);
    [self.stopQueueOutput setSampleBufferDelegate:recorder queue:queue];
    [self.session addOutput:self.stopQueueOutput];
    AVCaptureSession *session = self.session;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC / 2)), dispatch_get_main_queue(), ^{
      [session stopRunning];
      dispatch_resume(queue);
      dispatch_async(queue, ^{
        NSInteger delivered = recorder.count;
        dispatch_async(dispatch_get_main_queue(), ^{
          Record(@"stop-drained", [NSString stringWithFormat:@"%ld", (long)delivered]);
        });
      });
    });
  }
  if ([arguments containsObject:@"-ServeSimFixtureQuad"]) [self recordShapeOf:pixelBuffer];
  NSString *value = [NSString stringWithFormat:@"%u,%u,%u", pixel[2], pixel[1], pixel[0]];
  if (![value isEqualToString:self.lastPixel]) {
    Record(@"frame", value);
    Record(@"gravity", self.preview.contentsGravity ?: @"");
    Record(@"size", [NSString stringWithFormat:@"%zux%zu",
        CVPixelBufferGetWidth(pixelBuffer), CVPixelBufferGetHeight(pixelBuffer)]);
    const unsigned char *edge = (const unsigned char *)CVPixelBufferGetBaseAddress(pixelBuffer)
        + 4 * CVPixelBufferGetBytesPerRow(pixelBuffer) + (CVPixelBufferGetWidth(pixelBuffer) / 2) * 4;
    Record(@"edge", [NSString stringWithFormat:@"%u,%u,%u,%u", edge[2], edge[1], edge[0], edge[3]]);
    if ([arguments containsObject:@"-ServeSimFixtureLandscapeFit"]) {
      size_t height = CVPixelBufferGetHeight(pixelBuffer);
      size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
      size_t x = CVPixelBufferGetWidth(pixelBuffer) / 2;
      const unsigned char *base = CVPixelBufferGetBaseAddress(pixelBuffer);
      const unsigned char *bar = base + (height / 3) * stride + x * 4;
      const unsigned char *inside = base + (height * 3 / 8) * stride + x * 4;
      Record(@"fit", [NSString stringWithFormat:@"%u,%u,%u,%u|%u,%u,%u,%u",
          bar[2], bar[1], bar[0], bar[3], inside[2], inside[1], inside[0], inside[3]]);
    }
    if (!self.changedGravity && [NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureGravityChange"]) {
      self.changedGravity = YES;
      self.preview.videoGravity = AVLayerVideoGravityResize;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC / 2)), dispatch_get_main_queue(), ^{
        Record(@"gravity", self.preview.contentsGravity ?: @"");
      });
    } else if (!self.sampledPreview && [NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureGravityAspect"]) {
      self.sampledPreview = YES;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC / 2)), dispatch_get_main_queue(), ^{
        [self recordPreviewPixels];
        [self recordPreviewQuad];
      });
    }
    self.lastPixel = value;
  }
  CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
}

// Renders the preview layer as drawn, so a test can check the fit and not only the gravity property.
- (void)renderPreview:(void (^)(const unsigned char *rgba, size_t width, size_t height))use {
  CGSize size = self.preview.bounds.size;
  size_t width = (size_t)size.width, height = (size_t)size.height;
  if (width == 0 || height == 0) return;
  unsigned char *bytes = calloc(width * height, 4);
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(bytes, width, height, 8, width * 4, space,
      (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGContextTranslateCTM(context, 0, size.height);
  CGContextScaleCTM(context, 1, -1);
  [self.preview renderInContext:context];
  use(bytes, width, height);
  CGContextRelease(context);
  CGColorSpaceRelease(space);
  free(bytes);
}

- (void)recordPreviewPixels {
  [self renderPreview:^(const unsigned char *bytes, size_t width, size_t height) {
    NSString *(^pixel)(size_t) = ^NSString *(size_t row) {
      const unsigned char *p = bytes + (row * width + width / 2) * 4;
      return [NSString stringWithFormat:@"%u,%u,%u,%u", p[0], p[1], p[2], p[3]];
    };
    Record(@"preview-pixels", [NSString stringWithFormat:@"center=%@ top=%@", pixel(height / 2), pixel(height / 20)]);
  }];
}

// With an aspect-fit preview, where the square source's quadrants land in the drawn layer.
- (void)recordPreviewQuad {
  CGImageRef contents = (__bridge CGImageRef)self.preview.contents;
  if (!contents || ![NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureGravityAspect"]) return;
  double imageWidth = (double)CGImageGetWidth(contents), imageHeight = (double)CGImageGetHeight(contents);
  [self renderPreview:^(const unsigned char *bytes, size_t width, size_t height) {
    double scale = MIN((double)width / imageWidth, (double)height / imageHeight);
    Record(@"preview-quad", [NSString stringWithFormat:@"%.0fx%.0f %@", imageWidth, imageHeight,
        QuadrantNames(bytes, width * 4, width, height, MIN(imageWidth, imageHeight) * scale, NO)]);
  }];
}

// The frame size and quadrant colors, and the non-black span through the center.
- (void)recordShapeOf:(CVPixelBufferRef)pixelBuffer {
  size_t width = CVPixelBufferGetWidth(pixelBuffer), height = CVPixelBufferGetHeight(pixelBuffer);
  size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
  const unsigned char *base = CVPixelBufferGetBaseAddress(pixelBuffer);
  NSString *quad = [NSString stringWithFormat:@"%zux%zu %@", width, height,
      QuadrantNames(base, stride, width, height, (double)MIN(width, height), YES)];
  if (![quad isEqualToString:self.lastQuad]) {
    Record(@"quad", quad);
    self.lastQuad = quad;
  }
  BOOL (^lit)(size_t, size_t) = ^BOOL(size_t x, size_t y) {
    const unsigned char *p = base + y * stride + x * 4;
    return p[0] > 40 || p[1] > 40 || p[2] > 40;
  };
  long top = -1, bottom = -1, left = -1, right = -1;
  for (size_t y = 0; y < height; y++) if (lit(width / 2, y)) { if (top < 0) top = (long)y; bottom = (long)y; }
  for (size_t x = 0; x < width; x++) if (lit(x, height / 2)) { if (left < 0) left = (long)x; right = (long)x; }
  NSString *box = [NSString stringWithFormat:@"%zux%zu %ld,%ld,%ld,%ld", width, height, top, bottom, left, right];
  if (![box isEqualToString:self.lastBox]) {
    Record(@"box", box);
    self.lastBox = box;
  }
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts {
  RecordURLContexts(URLContexts);
}

@end

@interface FixtureAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation FixtureAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSArray<NSString *> *passed = arguments.count > 1
      ? [arguments subarrayWithRange:NSMakeRange(1, arguments.count - 1)]
      : @[];
  Record(@"launch", [passed componentsJoinedByString:@"\x1f"]);
  if ([arguments containsObject:@"--logs-test"]) {
    [NSTimer scheduledTimerWithTimeInterval:1.0 repeats:YES block:^(__unused NSTimer *timer) {
      NSLog(@"SERVE_SIM_USER_APP_LOG_MARKER pid=%d", getpid());
    }];
  }
  return YES;
}

- (UISceneConfiguration *)application:(UIApplication *)application
    configurationForConnectingSceneSession:(UISceneSession *)session
                                   options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *configuration =
      [UISceneConfiguration configurationWithName:nil sessionRole:session.role];
  configuration.delegateClass = FixtureSceneDelegate.class;
  return configuration;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(FixtureAppDelegate.class));
  }
}
