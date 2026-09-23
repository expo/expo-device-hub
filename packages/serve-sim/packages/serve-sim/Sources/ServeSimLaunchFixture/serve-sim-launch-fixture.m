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

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation FixtureSceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [[UIViewController alloc] init];
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
