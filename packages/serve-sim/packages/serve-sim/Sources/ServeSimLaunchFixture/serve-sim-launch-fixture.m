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

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
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
