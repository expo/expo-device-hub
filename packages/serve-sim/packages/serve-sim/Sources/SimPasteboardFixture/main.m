#import <UIKit/UIKit.h>

static NSString *const kCopyFixtureText = @"serve-sim-copy-probe";

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic, strong) UITextView *textView;
@end

@implementation AppDelegate
- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  (void)application;
  (void)launchOptions;
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
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
  return YES;
}

- (void)applicationDidBecomeActive:(UIApplication *)application {
  (void)application;
  [self.textView becomeFirstResponder];
  self.textView.selectedRange = NSMakeRange(0, self.textView.text.length);
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}
