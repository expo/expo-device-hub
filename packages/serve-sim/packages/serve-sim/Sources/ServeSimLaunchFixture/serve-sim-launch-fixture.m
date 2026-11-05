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

static void RecordURLContexts(NSSet<UIOpenURLContext *> *contexts) {
  for (UIOpenURLContext *context in contexts) {
    Record(@"openurl", context.URL.absoluteString);
  }
}

// -ServeSimFixtureRequest <url> makes one request so a capture test has traffic to find, and records
// what the app itself saw so the test can tell a capture gap from a request that never completed.
static void RequestIfAsked(void) {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger flag = [arguments indexOfObject:@"-ServeSimFixtureRequest"];
  if (flag == NSNotFound || flag + 1 >= arguments.count) {
    return;
  }
  NSURL *url = [NSURL URLWithString:arguments[flag + 1]];
  if (url == nil) {
    Record(@"request", @"unparseable-url");
    return;
  }
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
  [[session dataTaskWithURL:url
          completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            if (error != nil) {
              Record(@"request", [NSString stringWithFormat:@"error %@", error.localizedDescription]);
              return;
            }
            NSInteger status = ((NSHTTPURLResponse *)response).statusCode;
            Record(@"request", [NSString stringWithFormat:@"status=%ld bytes=%lu", (long)status,
                                                          (unsigned long)data.length]);
          }] resume];
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
@property(nonatomic, strong) UITextView *clipboardField;
- (UIResponder *)textInput;
- (void)recordActive;
@end

@implementation FixtureKeyboardController

- (void)viewDidLoad {
  [super viewDidLoad];
  [NSNotificationCenter.defaultCenter addObserver:self
      selector:@selector(softwareKeyboardShown:)
      name:UIKeyboardDidShowNotification object:nil];
  self.view.backgroundColor = UIColor.systemGreenColor;
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(keyboardShown:)
      name:UIKeyboardDidShowNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(keyboardHidden:)
      name:UIKeyboardWillHideNotification object:nil];
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--clipboard-test"]) {
    self.clipboardField = [[UITextView alloc] initWithFrame:CGRectMake(24, 100, 300, 144)];
    self.clipboardField.accessibilityIdentifier = @"typing-field";
    self.clipboardField.autocapitalizationType = UITextAutocapitalizationTypeNone;
    self.clipboardField.autocorrectionType = UITextAutocorrectionTypeNo;
    self.clipboardField.spellCheckingType = UITextSpellCheckingTypeNo;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(clipboardChanged:)
        name:UITextViewTextDidChangeNotification object:self.clipboardField];
    [self.view addSubview:self.clipboardField];
    return;
  }
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
  if ([self.textInput becomeFirstResponder]) Record(@"keyboard-ready", @"");
  [self recordActive];
}

- (UIResponder *)textInput {
  return self.clipboardField ?: (UIResponder *)self.field;
}

- (void)recordActive {
  if (self.view.window.windowScene.activationState == UISceneActivationStateForegroundActive
      && self.view.window.isKeyWindow && self.textInput.isFirstResponder) Record(@"keyboard-active", @"");
}

- (void)keyboardShown:(NSNotification *)notification {
  if (self.textInput.isFirstResponder) Record(@"keyboard-visible", @"");
}

- (void)keyboardHidden:(NSNotification *)notification {
  Record(@"keyboard-hidden", [NSString stringWithFormat:@"local=%@ endFrame=%@", notification.userInfo[UIKeyboardIsLocalUserInfoKey], notification.userInfo[UIKeyboardFrameEndUserInfoKey]]);
}

- (void)textChanged:(UITextField *)field {
  Record(@"text", field.text ?: @"");
}

- (void)clipboardChanged:(NSNotification *)notification {
  Record(@"text", self.clipboardField.text ?: @"");
}

- (void)softwareKeyboardShown:(NSNotification *)notification {
  CGRect frame = [notification.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];
  if (CGRectIntersectsRect(frame, self.view.window.bounds)) {
    Record(@"software-keyboard-ready", @"");
  }
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
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

// The wheel handoff E2E observes UIKit selection and release, not HID acknowledgements.
@interface FixtureScrollWindow : UIWindow
@property(nonatomic, strong) NSMutableSet<UITouch *> *contacts;
@property(nonatomic) NSUInteger began;
@property(nonatomic) NSUInteger ended;
@property(nonatomic) NSUInteger cancelled;
@end

@interface FixtureScrollController : UITableViewController
@property(nonatomic, strong) NSTimer *stateTimer;
@property(nonatomic, strong) NSDictionary *lastState;
- (void)recordState;
@end

static void RecordScroll(NSString *kind, NSDictionary *data) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:data options:0 error:NULL];
  Record(kind, [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
}

@implementation FixtureScrollWindow

- (void)sendEvent:(UIEvent *)event {
  if (event.type == UIEventTypeTouches) {
    if (!self.contacts) self.contacts = [NSMutableSet set];
    FixtureScrollController *controller = (FixtureScrollController *)self.rootViewController;
    for (UITouch *touch in event.allTouches) {
      NSString *phase;
      switch (touch.phase) {
      case UITouchPhaseBegan:
        phase = @"began";
        if (![self.contacts containsObject:touch]) self.began++;
        [self.contacts addObject:touch];
        break;
      case UITouchPhaseMoved: phase = @"moved"; break;
      case UITouchPhaseEnded:
        phase = @"ended";
        if ([self.contacts containsObject:touch]) self.ended++;
        [self.contacts removeObject:touch];
        break;
      case UITouchPhaseCancelled:
        phase = @"cancelled";
        if ([self.contacts containsObject:touch]) self.cancelled++;
        [self.contacts removeObject:touch];
        break;
      default: continue;
      }
      CGPoint point = [touch locationInView:self];
      NSIndexPath *row = [controller.tableView indexPathForRowAtPoint:[touch locationInView:controller.tableView]];
      RecordScroll(@"scroll-touch", @{@"phase": phase, @"mono": @(NSProcessInfo.processInfo.systemUptime),
        @"x": @(point.x / self.bounds.size.width), @"y": @(point.y / self.bounds.size.height),
        @"row": row ? @(row.row) : NSNull.null});
    }
  }
  [super sendEvent:event];
  [(FixtureScrollController *)self.rootViewController recordState];
}

@end

@implementation FixtureScrollController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.tableView.rowHeight = 90;
  [self.tableView registerClass:UITableViewCell.class forCellReuseIdentifier:@"row"];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  Record(@"scroll-ready", @"");
  [self recordState];
  [self.stateTimer invalidate];
  __weak FixtureScrollController *weakSelf = self;
  self.stateTimer = [NSTimer scheduledTimerWithTimeInterval:0.025 repeats:YES block:^(__unused NSTimer *timer) {
    [weakSelf recordState];
  }];
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section { return 200; }

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"row" forIndexPath:indexPath];
  cell.textLabel.text = [NSString stringWithFormat:@"Row %ld", (long)indexPath.row];
  return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  Record(@"scroll-row", [NSString stringWithFormat:@"%ld", (long)indexPath.row]);
  [tableView deselectRowAtIndexPath:indexPath animated:NO];
}

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView {
  Record(@"scroll-pan", @"");
  [self recordState];
}

- (void)recordState {
  FixtureScrollWindow *window = (FixtureScrollWindow *)self.view.window;
  NSDictionary *state = @{@"offset": @(self.tableView.contentOffset.y), @"contacts": @(window.contacts.count),
    @"tracking": @(self.tableView.tracking), @"dragging": @(self.tableView.dragging),
    @"decelerating": @(self.tableView.decelerating), @"pan": @(self.tableView.panGestureRecognizer.state),
    @"began": @(window.began), @"ended": @(window.ended), @"cancelled": @(window.cancelled)};
  if ([state isEqualToDictionary:self.lastState]) return;
  self.lastState = state;
  RecordScroll(@"scroll-state", state);
}

- (void)dealloc { [self.stateTimer invalidate]; }

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

static id CameraDeviceDetails(AVCaptureDevice *device) {
  if (!device) return NSNull.null;
  // Simulator placeholders can have no ID or type; retain their native metadata.
  return @{@"id": device.uniqueID ?: NSNull.null, @"type": device.deviceType ?: NSNull.null,
    @"position": @(device.position), @"video": @([device hasMediaType:AVMediaTypeVideo])};
}

static NSDictionary<NSString *, AVCaptureDeviceDiscoverySession *> *CameraDiscoverySessions(void) {
  if (@available(iOS 17.0, *)) {
    AVCaptureDeviceType wide = AVCaptureDeviceTypeBuiltInWideAngleCamera;
    AVCaptureDeviceType external = AVCaptureDeviceTypeExternal;
    AVCaptureDeviceType triple = AVCaptureDeviceTypeBuiltInTripleCamera;
    NSMutableArray *copiedTypes = [NSMutableArray arrayWithObject:wide];
    NSDictionary *sessions = @{
      @"external": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[external] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified],
      @"triple": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[triple] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified],
      @"mixed": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[external, triple, wide] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified],
      @"front": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[wide] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionFront],
      @"back": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[wide] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionBack],
      @"audio": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[wide] mediaType:AVMediaTypeAudio position:AVCaptureDevicePositionUnspecified],
      @"microphone": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[AVCaptureDeviceTypeMicrophone] mediaType:AVMediaTypeAudio position:AVCaptureDevicePositionUnspecified],
      @"copied": [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:copiedTypes mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified],
    };
    [copiedTypes setArray:@[external]];
    return sessions;
  }
  return @{};
}

// Keep sessions created on either side of a camera connection to exercise both transitions.
static void RecordCameraDiscovery(BOOL beforeConnection) {
  __block NSDictionary<NSString *, AVCaptureDeviceDiscoverySession *> *retained;
  __block NSDictionary *last;
  [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(__unused NSTimer *timer) {
    AVCaptureDevice *wide = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionBack];
    NSDictionary<NSString *, AVCaptureDeviceDiscoverySession *> *sessions = retained ?: CameraDiscoverySessions();
    Class fakeDevice = NSClassFromString(@"SimCamFakeDevice");
    BOOL connected = fakeDevice != Nil && [wide isKindOfClass:fakeDevice];
    BOOL canRetain = beforeConnection
        ? fakeDevice != Nil && !connected
        : connected;
    if (canRetain && !retained) {
      retained = sessions;
      Record(@"discovery-retained", connected ? @"connected" : @"disconnected");
    }
    NSMutableDictionary *snapshot = [NSMutableDictionary new];
    for (NSString *name in sessions) {
      NSMutableArray *devices = [NSMutableArray new];
      for (AVCaptureDevice *device in sessions[name].devices) [devices addObject:CameraDeviceDetails(device)];
      snapshot[name] = devices;
    }
    snapshot[@"connected"] = @(connected);
    snapshot[@"defaultBack"] = CameraDeviceDetails(wide);
    snapshot[@"defaultFront"] = CameraDeviceDetails([AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionFront]);
    snapshot[@"defaultTriple"] = CameraDeviceDetails([AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInTripleCamera mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionBack]);
    snapshot[@"defaultAudio"] = CameraDeviceDetails([AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera mediaType:AVMediaTypeAudio position:AVCaptureDevicePositionUnspecified]);
    if (@available(iOS 17.0, *)) snapshot[@"defaultExternal"] = CameraDeviceDetails([AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeExternal mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified]);
    if (![snapshot isEqualToDictionary:last]) {
      NSData *json = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:NULL];
      Record(@"discovery", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
      last = snapshot;
    }
  }];
}

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate, AVCaptureVideoDataOutputSampleBufferDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) AVCaptureSession *session;
@property(nonatomic, strong) AVCaptureVideoPreviewLayer *preview;
@property(nonatomic, copy) NSString *lastPixel;
@property(nonatomic, strong) AVCaptureVideoDataOutput *queuedOutput;
@property(nonatomic, strong) QueuedFrameRecorder *queuedRecorder;
@property(nonatomic, strong) dispatch_queue_t queuedFrames;
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
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  BOOL scrollTest = [arguments containsObject:@"--scroll-test"]
      && ![arguments containsObject:@"--keyboard-test"]
      && ![arguments containsObject:@"--input-test"];
  self.window = [[(scrollTest ? FixtureScrollWindow.class : UIWindow.class) alloc]
      initWithWindowScene:(UIWindowScene *)scene];
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--keyboard-test"]) {
    self.window.rootViewController = [[FixtureKeyboardController alloc] init];
  } else if ([NSProcessInfo.processInfo.arguments containsObject:@"--input-test"]) {
    self.window.rootViewController = [[FixtureInputController alloc] init];
  } else if (scrollTest) {
    self.window.rootViewController = [[FixtureScrollController alloc] init];
  } else {
    self.window.rootViewController = [[UIViewController alloc] init];
  }
  self.window.rootViewController.view.backgroundColor = UIColor.systemGreenColor;
  [self.window makeKeyAndVisible];
  UIView *root = self.window.rootViewController.view;
  Record(@"permission", [NSString stringWithFormat:@"%ld", (long)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]]);
  if ([arguments containsObject:@"-ServeSimFixtureCameraDiscovery"]) {
    RecordCameraDiscovery([arguments containsObject:@"-ServeSimFixtureDiscoveryBeforeConnection"]);
    return;
  }
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

  // Assigning the session goes through setSession:, which is where serve-sim
  // hooks the preview. layerWithSession: sets it without that.
  AVCaptureVideoPreviewLayer *preview = [[AVCaptureVideoPreviewLayer alloc] init];
  preview.session = session;
  preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
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
  NSString *value = [NSString stringWithFormat:@"%u,%u,%u", pixel[2], pixel[1], pixel[0]];
  if (![value isEqualToString:self.lastPixel]) {
    Record(@"frame", value);
    self.lastPixel = value;
  }
  CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts {
  RecordURLContexts(URLContexts);
}

- (void)sceneDidBecomeActive:(UIScene *)scene {
  if ([self.window.rootViewController isKindOfClass:FixtureKeyboardController.class]) {
    FixtureKeyboardController *controller = (FixtureKeyboardController *)self.window.rootViewController;
    [controller recordActive];
  }
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
  RequestIfAsked();
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
