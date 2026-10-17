// Fixture app for the launch tests. Records every launch and opened URL in its
// own data container so a test can read back what the launch carried.
// UIKit puts the app on the scene lifecycle, so URLs arrive at the scene
// delegate; the app delegate never sees them.

#import <AVFoundation/AVFoundation.h>
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
@end

@implementation FixtureKeyboardController

- (void)viewDidLoad {
  [super viewDidLoad];
  [NSNotificationCenter.defaultCenter addObserver:self
      selector:@selector(softwareKeyboardShown:)
      name:UIKeyboardDidShowNotification object:nil];
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
