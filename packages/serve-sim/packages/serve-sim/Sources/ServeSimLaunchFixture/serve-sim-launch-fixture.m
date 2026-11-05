// Fixture app for the launch tests. Records every launch and opened URL in its
// own data container so a test can read back what the launch carried.
// UIKit puts the app on the scene lifecycle, so URLs arrive at the scene
// delegate; the app delegate never sees them.

#import <AVFoundation/AVFoundation.h>
#import <JavaScriptCore/JavaScriptCore.h>
#import <UIKit/UIKit.h>
#include <math.h>
#include <time.h>

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
  // Before the main queue runs, so only a clock image inserted at exec can have moved it.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--clock-test"]) {
    Record(@"clock-load", [NSString stringWithFormat:@"%ld", (long)time(NULL)]);
  }
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

// The time-zone E2E reads what the process itself sees, from both places an app
// asks: Foundation's zone name, and libc's offset for now, which is what Hermes
// `Date` uses. Recorded once at launch and again whenever either changes, with how many
// zone and significant-time-change notifications arrived, which is what Calendar refreshes on.
static NSUInteger zoneChangeNotifications = 0;
static NSUInteger significantTimeChanges = 0;
static NSString *lastZoneRecord = nil;

static void RecordTimeZoneIfChanged(void) {
  time_t now = time(NULL);
  struct tm local;
  localtime_r(&now, &local);
  NSString *detail = [NSString stringWithFormat:@"%@|%ld|%lu|%lu", NSTimeZone.systemTimeZone.name,
                                                 (long)local.tm_gmtoff,
                                                 (unsigned long)zoneChangeNotifications,
                                                 (unsigned long)significantTimeChanges];
  if ([detail isEqualToString:lastZoneRecord]) return;
  lastZoneRecord = detail;
  Record(@"tz", detail);
}

static void StartTimeZoneRecording(void) {
  [NSNotificationCenter.defaultCenter addObserverForName:NSSystemTimeZoneDidChangeNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(__unused NSNotification *note) {
    zoneChangeNotifications++;
    RecordTimeZoneIfChanged();
  }];
  [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationSignificantTimeChangeNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(__unused NSNotification *note) {
    significantTimeChanges++;
    RecordTimeZoneIfChanged();
  }];
  RecordTimeZoneIfChanged();
  [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(__unused NSTimer *timer) {
    RecordTimeZoneIfChanged();
  }];
}

// The clock E2E reads the wall clock the process sees, from Foundation, libc and JavaScriptCore.
// Recorded at launch and whenever it jumps against the monotonic clock, with how many clock-change
// and significant-time-change notifications arrived.
static NSUInteger clockChangeNotifications = 0;
static NSUInteger clockSignificantChanges = 0;
static double lastClockSkew = NAN;
static NSUInteger lastClockNotes = NSUIntegerMax;
static JSContext *clockScript = nil;

static double MonotonicMs(void) {
  return (double)clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1e6;
}

static void RecordWait(NSString *kind, double start) {
  NSString *waited = [NSString stringWithFormat:@"%.0f", MonotonicMs() - start];
  dispatch_async(dispatch_get_main_queue(), ^{ Record(kind, waited); });
}

// Deadlines that apps build from the wall clock: each one should take its real 300 ms. A wait
// that never ends records nothing.
static void ProbeWallDeadlines(void) {
  dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
  dispatch_async(queue, ^{
    NSCondition *condition = [[NSCondition alloc] init];
    double start = MonotonicMs();
    [condition lock];
    [condition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.3]];
    [condition unlock];
    RecordWait(@"wait-condition", start);
  });
  double start = MonotonicMs();
  dispatch_after(dispatch_walltime(NULL, 300 * (int64_t)NSEC_PER_MSEC), queue, ^{
    RecordWait(@"wait-walltime", start);
  });
  dispatch_after(dispatch_time(DISPATCH_WALLTIME_NOW, 300 * (int64_t)NSEC_PER_MSEC), queue, ^{
    RecordWait(@"wait-walltime-now", start);
  });
  struct timespec now;
  clock_gettime(CLOCK_REALTIME, &now);
  dispatch_after(dispatch_walltime(&now, 300 * (int64_t)NSEC_PER_MSEC), queue, ^{
    RecordWait(@"wait-walltime-timespec", start);
  });
}

static void RecordClockIfChanged(void) {
  struct timespec monotonic;
  clock_gettime(CLOCK_MONOTONIC, &monotonic);
  double now = NSDate.date.timeIntervalSince1970;
  double skew = now - ((double)monotonic.tv_sec + (double)monotonic.tv_nsec / 1e9);
  NSUInteger notes = clockChangeNotifications + clockSignificantChanges;
  if (fabs(skew - lastClockSkew) < 2 && notes == lastClockNotes) return;
  lastClockSkew = skew;
  lastClockNotes = notes;
  double script = [[clockScript evaluateScript:@"Date.now() / 1000"] toDouble];
  Record(@"clock", [NSString stringWithFormat:@"%.0f|%ld|%.0f|%lu|%lu", now, (long)time(NULL),
                                              script, (unsigned long)clockChangeNotifications,
                                              (unsigned long)clockSignificantChanges]);
  ProbeWallDeadlines();
}

static void StartClockRecording(void) {
  clockScript = [[JSContext alloc] init];
  [NSNotificationCenter.defaultCenter addObserverForName:NSSystemClockDidChangeNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(__unused NSNotification *note) {
    clockChangeNotifications++;
    RecordClockIfChanged();
  }];
  [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationSignificantTimeChangeNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(__unused NSNotification *note) {
    clockSignificantChanges++;
    RecordClockIfChanged();
  }];
  RecordClockIfChanged();
  [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(__unused NSTimer *timer) {
    RecordClockIfChanged();
  }];
}

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
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
  RecordURLContexts(connectionOptions.URLContexts);
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
  if ([arguments containsObject:@"--time-zone-test"]) StartTimeZoneRecording();
  if ([arguments containsObject:@"--clock-test"]) StartClockRecording();
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
