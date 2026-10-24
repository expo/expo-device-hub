#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <Contacts/Contacts.h>
#import <AVFoundation/AVFoundation.h>
#import <Photos/Photos.h>
#import <CoreLocation/CoreLocation.h>
#import <EventKit/EventKit.h>

@interface ProbeScene : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@interface Probe : UIResponder <UIApplicationDelegate, UNUserNotificationCenterDelegate, CLLocationManagerDelegate>
@property(nonatomic, strong) UILabel *identityLabel;
@property(nonatomic, strong) UILabel *eventLabel;
@property(nonatomic, strong) NSMutableDictionary<NSString *, UILabel *> *statusLabels;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) CLLocationManager *locationManager;
@property(nonatomic, strong) CNContactStore *contactStore;
@property(nonatomic, strong) EKEventStore *eventStore;
@property(nonatomic, strong) NSString *folder;
@property(nonatomic) NSInteger launches;
@property(nonatomic, strong) NSMutableArray *events;
- (void)tick;
- (void)performCommand:(NSDictionary *)command;
@end

static NSString *authorizationName(NSInteger value) {
  switch (value) {
    case 0: return @"Not asked";
    case 1: return @"Restricted";
    case 2: return @"Denied";
    case 3: return @"Granted";
    case 4: return @"Limited";
    default: return [NSString stringWithFormat:@"Unknown (%ld)", (long)value];
  }
}

@implementation Probe
- (void)event:(NSDictionary *)event {
  NSMutableDictionary *entry = [event mutableCopy];
  entry[@"timestamp"] = @([NSDate date].timeIntervalSince1970);
  [self.events addObject:entry];
  NSData *data = [NSJSONSerialization dataWithJSONObject:entry options:0 error:NULL];
  NSString *path = [self.folder stringByAppendingPathComponent:@"events.ndjson"];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) [[NSData data] writeToFile:path atomically:YES];
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  [handle seekToEndOfFile];
  [handle writeData:data];
  [handle writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  [handle closeFile];
  NSString *error = [entry[@"error"] isKindOfClass:NSString.class] ? entry[@"error"] : nil;
  if (error) self.eventLabel.text = [NSString stringWithFormat:@"%@: %@", entry[@"event"], error];
  else if ([entry[@"event"] isEqual:@"willPresent"]) self.eventLabel.text = [NSString stringWithFormat:@"Delivered: %@", entry[@"tag"]];
  else if (entry[@"granted"]) self.eventLabel.text = [NSString stringWithFormat:@"%@: %@", entry[@"event"], [entry[@"granted"] boolValue] ? @"granted" : @"not granted"];
  else self.eventLabel.text = [NSString stringWithFormat:@"%@: %@", entry[@"event"], entry[@"tag"] ?: @"finished"];
}

// Buttons and automated commands use the same public app APIs. They never set
// authorization themselves; the labels below independently query the frameworks.
- (void)performCommand:(NSDictionary *)command {
  NSString *action = command[@"action"];
  void (^completion)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self event:@{@"event":action, @"granted":@(granted), @"error":error.localizedDescription ?: [NSNull null]}];
      [self tick];
    });
  };
  if ([action isEqual:@"schedule"]) {
    NSString *tag = command[@"tag"] ?: [NSString stringWithFormat:@"manual-%.0f", [NSDate date].timeIntervalSince1970 * 1000];
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = @"Permission Lab"; content.body = tag; content.sound = UNNotificationSound.defaultSound;
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:tag content:content trigger:[UNTimeIntervalNotificationTrigger triggerWithTimeInterval:1 repeats:NO]];
    [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{ [self event:@{@"event":@"schedule", @"tag":tag, @"error":error.localizedDescription ?: [NSNull null]}]; });
    }];
  } else if ([action isEqual:@"request"]) {
    [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge completionHandler:completion];
  } else if ([action isEqual:@"clear"]) {
    [UNUserNotificationCenter.currentNotificationCenter removeAllDeliveredNotifications];
    [self event:@{@"event":@"clear"}];
  } else if ([action isEqual:@"camera"] || [action isEqual:@"microphone"]) {
    [AVCaptureDevice requestAccessForMediaType:[action isEqual:@"camera"] ? AVMediaTypeVideo : AVMediaTypeAudio completionHandler:^(BOOL granted) { completion(granted, nil); }];
  } else if ([action isEqual:@"photos"] || [action isEqual:@"photos-add"]) {
    [PHPhotoLibrary requestAuthorizationForAccessLevel:[action isEqual:@"photos"] ? PHAccessLevelReadWrite : PHAccessLevelAddOnly handler:^(PHAuthorizationStatus status) { completion(status == PHAuthorizationStatusAuthorized || status == PHAuthorizationStatusLimited, nil); }];
  } else if ([action isEqual:@"contacts"]) {
    [self.contactStore requestAccessForEntityType:CNEntityTypeContacts completionHandler:completion];
  } else if ([action isEqual:@"location"] || [action isEqual:@"location-always"]) {
    if ([action isEqual:@"location-always"]) [self.locationManager requestAlwaysAuthorization];
    else [self.locationManager requestWhenInUseAuthorization];
  } else if ([action isEqual:@"calendar"] || [action isEqual:@"reminders"]) {
    EKEventStore *store = self.eventStore;
    if (@available(iOS 17.0, *)) {
      if ([action isEqual:@"calendar"]) [store requestFullAccessToEventsWithCompletion:completion];
      else [store requestFullAccessToRemindersWithCompletion:completion];
    } else {
      [store requestAccessToEntityType:[action isEqual:@"calendar"] ? EKEntityTypeEvent : EKEntityTypeReminder completion:completion];
    }
  }
}
- (void)requestPermission:(UIButton *)sender {
  self.eventLabel.text = [NSString stringWithFormat:@"Requesting %@…", sender.configuration.title ?: sender.currentTitle];
  [self performCommand:@{@"action":sender.accessibilityIdentifier}];
}
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  [self event:@{@"event":@"location", @"tag":@(manager.authorizationStatus).stringValue}];
}
- (void)tick {
  NSString *path = [self.folder stringByAppendingPathComponent:@"command.json"];
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
    [self performCommand:[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]];
  }
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    [UNUserNotificationCenter.currentNotificationCenter getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
      NSMutableArray *ids = [NSMutableArray array];
      for (UNNotification *notification in notifications) [ids addObject:notification.request.identifier];
      dispatch_async(dispatch_get_main_queue(), ^{
        NSDictionary *sample = @{
          @"timestamp":@([NSDate date].timeIntervalSince1970), @"pid":@(getpid()), @"launchCount":@(self.launches),
          @"notifications":@(settings.authorizationStatus), @"alertSetting":@(settings.alertSetting), @"notificationCenterSetting":@(settings.notificationCenterSetting),
          @"contacts":@([CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts]),
          @"camera":@([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]),
          @"microphone":@([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]),
          @"photos":@([PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite]),
          @"photos-add":@([PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelAddOnly]),
          @"location":@(self.locationManager.authorizationStatus),
          @"calendar":@([EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent]),
          @"reminders":@([EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder]),
          @"delivered":ids, @"events":self.events,
        };
        [[NSJSONSerialization dataWithJSONObject:sample options:NSJSONWritingPrettyPrinted error:NULL] writeToFile:[self.folder stringByAppendingPathComponent:@"state.json"] atomically:YES];
        self.identityLabel.text = [NSString stringWithFormat:@"PID %d  ·  launch count %ld", getpid(), (long)self.launches];
        NSArray *notificationNames = @[@"Not asked", @"Denied", @"Granted", @"Provisional", @"Ephemeral"];
        for (NSString *key in self.statusLabels) {
          if ([key isEqual:@"delivered"]) continue;
          NSInteger value = [sample[[key isEqual:@"alerts"] ? @"alertSetting" : key] integerValue];
          NSString *name;
          if ([key isEqual:@"notifications"]) name = value < notificationNames.count ? notificationNames[value] : @"Unknown";
          else if ([key isEqual:@"alerts"]) name = value == 2 ? @"Enabled" : value == 1 ? @"Disabled" : @"Not initialized / unsupported";
          else if ([key isEqual:@"location"]) name = value == 3 ? @"Always" : value == 4 ? @"When in use" : authorizationName(value);
          else if (([key isEqual:@"calendar"] || [key isEqual:@"reminders"]) && value == 4) name = @"Write only";
          else name = authorizationName(value);
          self.statusLabels[key].text = [NSString stringWithFormat:@"%@ (%ld)", name, (long)value];
        }
        self.statusLabels[@"delivered"].text = [NSString stringWithFormat:@"%lu delivered", (unsigned long)ids.count];
      });
    }];
  }];
}
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.folder = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  NSData *previous = [NSData dataWithContentsOfFile:[self.folder stringByAppendingPathComponent:@"state.json"]];
  NSDictionary *state = previous ? [NSJSONSerialization JSONObjectWithData:previous options:0 error:NULL] : nil;
  self.launches = [state[@"launchCount"] integerValue] + 1;
  self.events = [NSMutableArray array]; self.statusLabels = [NSMutableDictionary dictionary];
  self.contactStore = [CNContactStore new]; self.eventStore = [EKEventStore new];
  self.locationManager = [CLLocationManager new]; self.locationManager.delegate = self;
  UNUserNotificationCenter.currentNotificationCenter.delegate = self;
  self.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(tick) userInfo:nil repeats:YES];
  [self tick]; return YES;
}
- (UISceneConfiguration *)application:(UIApplication *)app configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *config = [[UISceneConfiguration alloc] initWithName:@"Permission Lab" sessionRole:session.role];
  config.delegateClass = ProbeScene.class; return config;
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  [self event:@{@"event":@"willPresent", @"tag":notification.request.identifier}];
  completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
}
@end

static UILabel *label(NSString *text, UIFont *font) {
  UILabel *view = [UILabel new]; view.text = text; view.font = font; view.numberOfLines = 0;
  return view;
}
static void button(UIStackView *stack, NSString *title, NSString *action, Probe *probe) {
  UIButton *view = [UIButton buttonWithType:UIButtonTypeSystem];
  UIButtonConfiguration *config = [UIButtonConfiguration borderedTintedButtonConfiguration];
  config.title = title; config.contentInsets = NSDirectionalEdgeInsetsMake(10, 12, 10, 12);
  view.configuration = config; view.accessibilityIdentifier = action;
  [view addTarget:probe action:@selector(requestPermission:) forControlEvents:UIControlEventTouchUpInside];
  [stack addArrangedSubview:view];
}
@implementation ProbeScene
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  Probe *probe = (Probe *)UIApplication.sharedApplication.delegate;
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  UIViewController *vc = [UIViewController new]; vc.view.backgroundColor = UIColor.systemBackgroundColor;
  UIScrollView *scroll = [UIScrollView new]; scroll.translatesAutoresizingMaskIntoConstraints = NO;
  [vc.view addSubview:scroll];
  UIStackView *stack = [UIStackView new]; stack.axis = UILayoutConstraintAxisVertical; stack.spacing = 14; stack.translatesAutoresizingMaskIntoConstraints = NO;
  [scroll addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [scroll.topAnchor constraintEqualToAnchor:vc.view.safeAreaLayoutGuide.topAnchor], [scroll.bottomAnchor constraintEqualToAnchor:vc.view.safeAreaLayoutGuide.bottomAnchor],
    [scroll.leadingAnchor constraintEqualToAnchor:vc.view.leadingAnchor], [scroll.trailingAnchor constraintEqualToAnchor:vc.view.trailingAnchor],
    [stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:18], [stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-24],
    [stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:20], [stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-20],
    [stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-40],
  ]];
  [stack addArrangedSubview:label(@"Permission Lab", [UIFont preferredFontForTextStyle:UIFontTextStyleLargeTitle])];
  probe.identityLabel = label(@"Reading app identity…", [UIFont monospacedSystemFontOfSize:13 weight:UIFontWeightMedium]);
  probe.identityLabel.accessibilityIdentifier = @"permission.identity"; [stack addArrangedSubview:probe.identityLabel];
  [stack addArrangedSubview:label(@"These are public app API results. Use Hub controls to grant, deny or reset, then watch the status. Some frameworks cache authorization until the app relaunches.", [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote])];
  probe.eventLabel = label(@"Tap a request button to exercise the app's permission flow.", [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote]);
  probe.eventLabel.accessibilityIdentifier = @"permission.last-event"; [stack addArrangedSubview:probe.eventLabel];
  NSArray *rows = @[@[@"notifications", @"Notifications", @"Request notifications"], @[@"camera", @"Camera", @"Request camera"], @[@"microphone", @"Microphone", @"Request microphone"], @[@"photos", @"Photos", @"Request photos"], @[@"photos-add", @"Add to Photos", @"Request add-only photos"], @[@"contacts", @"Contacts", @"Request contacts"], @[@"location", @"Location", @"Request location"], @[@"calendar", @"Calendar", @"Request calendar"], @[@"reminders", @"Reminders", @"Request reminders"]];
  for (NSArray *row in rows) {
    [stack addArrangedSubview:label(row[1], [UIFont preferredFontForTextStyle:UIFontTextStyleHeadline])];
    UILabel *status = label(@"Reading…", [UIFont monospacedSystemFontOfSize:14 weight:UIFontWeightRegular]);
    status.accessibilityIdentifier = [@"permission.status." stringByAppendingString:row[0]];
    probe.statusLabels[row[0]] = status; [stack addArrangedSubview:status];
    button(stack, row[2], [row[0] isEqual:@"notifications"] ? @"request" : row[0], probe);
    if ([row[0] isEqual:@"notifications"]) {
      UILabel *alerts = label(@"Reading alert settings…", [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote]);
      alerts.accessibilityIdentifier = @"permission.status.alerts"; probe.statusLabels[@"alerts"] = alerts; [stack addArrangedSubview:alerts];
      button(stack, @"Send local notification", @"schedule", probe);
      UILabel *delivered = label(@"0 delivered", [UIFont monospacedSystemFontOfSize:13 weight:UIFontWeightRegular]);
      probe.statusLabels[@"delivered"] = delivered; [stack addArrangedSubview:delivered];
      button(stack, @"Clear delivered notifications", @"clear", probe);
    }
    if ([row[0] isEqual:@"location"]) button(stack, @"Request always location", @"location-always", probe);
  }
  self.window.rootViewController = vc; [self.window makeKeyAndVisible]; [probe tick];
}
@end

int main(int argc, char **argv) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(Probe.class)); } }
