#import <UIKit/UIKit.h>
#include <string.h>

static NSString *const kOriginEnvironment = @"SERVE_SIM_NETWORK_FIXTURE_ORIGIN";
static NSString *const kDefaultOrigin = @"http://127.0.0.1:3400/";
static NSUInteger const kUploadBytes = 3 * 1024 * 1024;

static void RecordResult(NSString *value) {
  NSArray<NSString *> *directories =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *path = [directories.firstObject stringByAppendingPathComponent:@"network-requests.tsv"];
  NSString *line = [value stringByAppendingString:@"\n"];
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (handle == nil) {
    [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    return;
  }
  [handle seekToEndOfFile];
  [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
  [handle closeFile];
}

static NSURL *OriginURL(void) {
  NSString *override = NSProcessInfo.processInfo.environment[kOriginEnvironment];
  return [NSURL URLWithString:override.length > 0 ? override : kDefaultOrigin];
}

static void SendRequest(NSURLRequest *request, void (^completion)(NSString *)) {
  NSURLSession *session = [NSURLSession sessionWithConfiguration:
      NSURLSessionConfiguration.ephemeralSessionConfiguration];
  [[session dataTaskWithRequest:request
              completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                  NSInteger status = [(NSHTTPURLResponse *)response statusCode];
                  NSString *result = error == nil
                      ? [NSString stringWithFormat:@"%@ %@ → %ld (%lu B)", request.HTTPMethod,
                                                  request.URL.path, (long)status,
                                                  (unsigned long)data.length]
                      : [NSString stringWithFormat:@"%@ %@ → %@", request.HTTPMethod,
                                                  request.URL.path, error.localizedDescription];
                  [session finishTasksAndInvalidate];
                  RecordResult(result);
                  if (completion) completion(result);
                });
              }] resume];
}

static void SendStartupRequest(NSString *phase) {
  NSString *path = [@"api/startup/" stringByAppendingString:phase];
  SendRequest([NSURLRequest requestWithURL:[NSURL URLWithString:path relativeToURL:OriginURL()]], nil);
}

// The host can request a new session from an already-running fixture without
// depending on simulator touch input or relaunching the app.
static void WatchProfileTrigger(void) {
  NSArray<NSString *> *directories =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *path = [directories.firstObject stringByAppendingPathComponent:@"trigger-profile"];
  [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(__unused NSTimer *timer) {
    NSFileManager *files = NSFileManager.defaultManager;
    if (![files fileExistsAtPath:path]) return;
    [files removeItemAtPath:path error:NULL];
    NSURL *url = [NSURL URLWithString:@"api/profile?source=trigger" relativeToURL:OriginURL()];
    SendRequest([NSURLRequest requestWithURL:url], nil);
  }];
}

__attribute__((constructor)) static void BeforeMain(void) {
  @autoreleasepool {
    SendStartupRequest(@"pre-main");
  }
}

@interface NetworkRequestViewController : UIViewController
@property(nonatomic, strong) UIButton *profileButton;
@property(nonatomic, strong) UIButton *uploadButton;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, strong) NSURL *originURL;
@end

@implementation NetworkRequestViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  self.originURL = OriginURL();

  UILabel *title = [UILabel new];
  title.translatesAutoresizingMaskIntoConstraints = NO;
  title.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle1];
  title.text = @"Network request fixture";

  self.status = [UILabel new];
  self.status.translatesAutoresizingMaskIntoConstraints = NO;
  self.status.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  self.status.numberOfLines = 0;
  self.status.textAlignment = NSTextAlignmentCenter;
  self.status.text = @"Ready";

  self.profileButton = [self buttonWithTitle:@"GET profile" action:@selector(getProfile)];
  self.profileButton.accessibilityIdentifier = @"get-profile";
  self.uploadButton = [self buttonWithTitle:@"POST 3 MB" action:@selector(uploadThreeMegabytes)];
  self.uploadButton.accessibilityIdentifier = @"upload-three-megabytes";

  UIStackView *stack = [[UIStackView alloc]
      initWithArrangedSubviews:@[ title, self.status, self.profileButton, self.uploadButton ]];
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  stack.axis = UILayoutConstraintAxisVertical;
  stack.alignment = UIStackViewAlignmentCenter;
  stack.spacing = 18;
  [self.view addSubview:stack];

  [NSLayoutConstraint activateConstraints:@[
    [stack.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [stack.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
    [stack.leadingAnchor constraintGreaterThanOrEqualToAnchor:self.view.leadingAnchor constant:24],
    [stack.trailingAnchor constraintLessThanOrEqualToAnchor:self.view.trailingAnchor constant:-24],
    [self.profileButton.widthAnchor constraintEqualToConstant:260],
    [self.profileButton.heightAnchor constraintEqualToConstant:64],
    [self.uploadButton.widthAnchor constraintEqualToAnchor:self.profileButton.widthAnchor],
    [self.uploadButton.heightAnchor constraintEqualToAnchor:self.profileButton.heightAnchor],
  ]];
}

- (UIButton *)buttonWithTitle:(NSString *)title action:(SEL)action {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  button.translatesAutoresizingMaskIntoConstraints = NO;
  button.titleLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleHeadline];
  [button setTitle:title forState:UIControlStateNormal];
  [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
  return button;
}

- (void)getProfile {
  NSMutableURLRequest *profile = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:@"api/profile?source=button" relativeToURL:self.originURL]];
  [profile setValue:@"profile" forHTTPHeaderField:@"X-Serve-Sim-Fixture"];
  [self sendRequest:profile fromButton:self.profileButton];
}

- (void)uploadThreeMegabytes {
  NSMutableURLRequest *upload = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:@"api/upload" relativeToURL:self.originURL]];
  upload.HTTPMethod = @"POST";
  NSMutableData *body = [NSMutableData dataWithLength:kUploadBytes];
  memset(body.mutableBytes, 'x', body.length);
  upload.HTTPBody = body;
  [upload setValue:@"application/octet-stream" forHTTPHeaderField:@"Content-Type"];
  [upload setValue:@"upload" forHTTPHeaderField:@"X-Serve-Sim-Fixture"];
  [self sendRequest:upload fromButton:self.uploadButton];
}

- (void)sendRequest:(NSURLRequest *)request fromButton:(UIButton *)button {
  button.enabled = NO;
  self.status.text = [NSString stringWithFormat:@"Sending %@…", request.HTTPMethod];
  SendRequest(request, ^(NSString *result) {
    self.status.text = result;
    button.enabled = YES;
  });
}

@end

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation FixtureSceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)_session
                 options:(UISceneConnectionOptions *)_connectionOptions {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [NetworkRequestViewController new];
  [self.window makeKeyAndVisible];
}

@end

@interface FixtureAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation FixtureAppDelegate

- (BOOL)application:(UIApplication *)_application didFinishLaunchingWithOptions:(NSDictionary *)_options {
  WatchProfileTrigger();
  SendStartupRequest(@"app-delegate");
  return YES;
}

- (UISceneConfiguration *)application:(UIApplication *)_application
    configurationForConnectingSceneSession:(UISceneSession *)session
                                   options:(UISceneConnectionOptions *)_options {
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
