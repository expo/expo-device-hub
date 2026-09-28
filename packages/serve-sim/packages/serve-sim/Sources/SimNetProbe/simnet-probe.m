// Exercise the configuration factory used by the capture swizzle.

#import <UIKit/UIKit.h>
#include <stdlib.h>
#include <string.h>

static NSURLSession *earlySession;
static NSURLSessionConfiguration *earlyConfiguration;

static BOOL phaseIs(const char *phase) {
  const char *value = getenv("SIMNET_PROBE_PHASE");
  return value && strcmp(value, phase) == 0;
}

__attribute__((constructor)) static void prepareSession(void) {
  if (phaseIs("constructor")) {
    earlySession = [NSURLSession sessionWithConfiguration:NSURLSessionConfiguration.defaultSessionConfiguration];
  }
}


@interface SimNetProbeDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation SimNetProbeDelegate

+ (void)load {
  if (phaseIs("load")) {
    earlySession = [NSURLSession sessionWithConfiguration:NSURLSessionConfiguration.ephemeralSessionConfiguration];
  }
  if (phaseIs("configuration")) earlyConfiguration = NSURLSessionConfiguration.defaultSessionConfiguration;
}


- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [UIViewController new];
  [self.window makeKeyAndVisible];

  // SIMNET_PROBE_DELAY_MS creates the configuration that long after launch, so a test can change
  // the proxy's state between the capture library's startup and the app's first configuration.
  const char *delay = getenv("SIMNET_PROBE_DELAY_MS");
  long delayMs = delay ? strtol(delay, NULL, 10) : 0;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)delayMs * (int64_t)NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    [self sendRequest];
  });
  return YES;
}

- (void)sendRequest {
  const char *target = getenv("SIMNET_PROBE_URL");
  NSString *urlString = target != NULL ? @(target) : @"https://simnet-probe.test/ping";

  NSURLSessionConfiguration *configuration = earlyConfiguration ?: NSURLSessionConfiguration.defaultSessionConfiguration;
  NSURLSession *session = earlySession ?: [NSURLSession sessionWithConfiguration:configuration];
  NSURLSessionDataTask *task = [session dataTaskWithURL:[NSURL URLWithString:urlString]
                                     completionHandler:^(__unused NSData *data,
                                                         __unused NSURLResponse *response,
                                                         NSError *error) {
                                       NSLog(@"[simnetprobe] done error=%@",
                                             error.localizedDescription ?: @"none");
                                     }];
  [task resume];
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(SimNetProbeDelegate.class));
  }
}
