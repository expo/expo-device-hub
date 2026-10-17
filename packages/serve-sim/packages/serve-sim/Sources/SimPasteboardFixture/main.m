#import <UIKit/UIKit.h>

static NSString *const kCopyFixtureText = @"serve-sim-copy-probe";

// Apps linked with the iOS 27 SDK must adopt the scene lifecycle, or UIKit stops them at launch.
@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic, strong) UITextView *textView;
@end

@implementation SceneDelegate
- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  (void)session;
  (void)connectionOptions;
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  UIViewController *root = [UIViewController new];
  root.view.backgroundColor = UIColor.systemBackgroundColor;

  UITextView *textView = [[UITextView alloc] initWithFrame:root.view.bounds];
  textView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  textView.text = kCopyFixtureText;
  textView.editable = YES;
  textView.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  [root.view addSubview:textView];
  self.textView = textView;

  self.window.rootViewController = root;
  [self.window makeKeyAndVisible];
}

- (void)sceneDidBecomeActive:(UIScene *)scene {
  (void)scene;
  [self.textView becomeFirstResponder];
  self.textView.selectedRange = NSMakeRange(0, self.textView.text.length);
  // Tests wait for this file, with this process's pid, before they send Copy.
  NSString *marker = [NSTemporaryDirectory() stringByAppendingPathComponent:@"serve-sim-copy-fixture.selected"];
  [[NSString stringWithFormat:@"%d", getpid()] writeToFile:marker
                                                atomically:YES
                                                  encoding:NSUTF8StringEncoding
                                                     error:nil];
}
@end

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation AppDelegate
- (UISceneConfiguration *)application:(UIApplication *)application
    configurationForConnectingSceneSession:(UISceneSession *)session
                                   options:(UISceneConnectionOptions *)options {
  (void)application;
  (void)options;
  UISceneConfiguration *configuration =
      [UISceneConfiguration configurationWithName:nil sessionRole:session.role];
  configuration.delegateClass = SceneDelegate.class;
  return configuration;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}
