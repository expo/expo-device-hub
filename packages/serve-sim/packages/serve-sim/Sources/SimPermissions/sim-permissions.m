// Runs inside the Simulator. No app injection, relaunch, or backing-store writes.
#import <Foundation/Foundation.h>
#import <dlfcn.h>

@interface NSObject (SimulatorPermissions)
+ (id)defaultSectionInfoForType:(NSUInteger)type;
- (id)sectionInfoForSectionID:(NSString *)identifier;
- (void)setSectionInfo:(id)info forSectionID:(NSString *)identifier;
@end

static void fail(NSString *message) {
  @throw [NSException exceptionWithName:@"SimulatorPermissions" reason:message userInfo:nil];
}
static void requireSelector(id object, NSString *name) {
  if (![object respondsToSelector:NSSelectorFromString(name)])
    fail([NSString stringWithFormat:@"%@ is unavailable on this Simulator runtime", name]);
}
static void *symbol(void *handle, const char *name) {
  void *value = dlsym(handle, name);
  if (!value) fail([NSString stringWithFormat:@"%s is unavailable on this Simulator runtime", name]);
  return value;
}
static void *framework(const char *path) {
  void *handle = dlopen(path, RTLD_NOW);
  if (!handle) fail([NSString stringWithFormat:@"Cannot load %s: %s", path, dlerror()]);
  return handle;
}
static NSDictionary *notificationState(id info) {
  if (!info) return nil;
  NSMutableDictionary *state = [NSMutableDictionary dictionary];
  for (NSString *key in @[@"allowsNotifications", @"authorizationStatus", @"criticalAlertSetting"]) {
    requireSelector(info, key);
    state[key] = [info valueForKey:key];
  }
  state[@"critical"] = ([state[@"criticalAlertSetting"] integerValue] == 2 ? @YES : @NO);
  [state removeObjectForKey:@"criticalAlertSetting"];
  return state;
}

// @ref LLP 0003#app-permissions — live gateway state; denied and reset differ
static id notifications(NSString *action, NSString *bundle, NSString *value) {
  framework("/System/Library/PrivateFrameworks/BulletinBoard.framework/BulletinBoard");
  id gateway = [[NSClassFromString(@"BBSettingsGateway") alloc] init];
  requireSelector(gateway, @"sectionInfoForSectionID:");
  id info = [gateway sectionInfoForSectionID:bundle];
  if ([action isEqual:@"get"]) return notificationState(info) ?: [NSNull null];
  if (!info && [action isEqual:@"reset"]) return [NSNull null];
  requireSelector(gateway, @"setSectionInfo:forSectionID:");
  if (!info) {
    Class cls = NSClassFromString(@"BBSectionInfo");
    requireSelector(cls, @"defaultSectionInfoForType:");
    info = [cls defaultSectionInfoForType:0];
    requireSelector(info, @"setSectionID:");
    [info setValue:bundle forKey:@"sectionID"];
  }
  BOOL allowed = [action isEqual:@"grant"];
  NSInteger status = allowed ? 2 : [action isEqual:@"revoke"] ? 1 : 0;
  NSMutableDictionary *changes = [@{@"allowsNotifications":@(allowed), @"authorizationStatus":@(status),
    @"criticalAlertSetting":@([value isEqual:@"critical"] && allowed ? 2 : 0)} mutableCopy];
  if (allowed) [changes addEntriesFromDictionary:@{@"alertType":@1, @"lockScreenSetting":@1,
    @"notificationCenterSetting":@1, @"showsInNotificationCenter":@YES, @"showsInLockScreen":@YES}];
  // Validate all required selectors before publishing any change.
  for (NSString *key in changes) {
    NSString *setter = [NSString stringWithFormat:@"set%@%@:", [[key substringToIndex:1] uppercaseString], [key substringFromIndex:1]];
    requireSelector(info, setter);
  }
  // allowsNotifications also updates authorizationStatus. Publish status last,
  // otherwise a reset can silently become a denial.
  for (NSString *key in changes) {
    if (![key isEqual:@"authorizationStatus"]) [info setValue:changes[key] forKey:key];
  }
  [info setValue:@(status) forKey:@"authorizationStatus"];
  [gateway setSectionInfo:info forSectionID:bundle];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
  do {
    NSDictionary *read = notificationState([gateway sectionInfoForSectionID:bundle]);
    if (read && [read[@"authorizationStatus"] integerValue] == status &&
        [read[@"allowsNotifications"] boolValue] == allowed &&
        [read[@"critical"] boolValue] == ([changes[@"criticalAlertSetting"] integerValue] == 2)) return read;
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  } while ([deadline timeIntervalSinceNow] > 0);
  fail(@"Notification service did not confirm the requested state");
  return nil;
}

// @ref LLP 0003#app-permissions — tccd owns TCC writes; no-kill is required
static void tcc(NSString *action, NSString *service, NSString *bundle, NSString *value) {
  void *handle = framework("/System/Library/PrivateFrameworks/TCC.framework/TCC");
  const CFStringRef *noKill = symbol(handle, "kTCCSetNoKill");
  if (!*noKill) fail(@"kTCCSetNoKill is unavailable");
  NSMutableDictionary *options = [@{(__bridge NSString *)*noKill:@YES} mutableCopy];
  Boolean accepted;
  if ([action isEqual:@"reset"]) {
    Boolean (*reset)(CFStringRef, CFStringRef, CFDictionaryRef) = symbol(handle, "TCCAccessResetForBundleIdWithOptions");
    accepted = reset((__bridge CFStringRef)service, (__bridge CFStringRef)bundle, (__bridge CFDictionaryRef)options);
  } else {
    BOOL allowed = [action isEqual:@"grant"];
    options[@"auth_value"] = @(allowed ? ([value isEqual:@"limited"] ? 3 : 2) : 0);
    Boolean (*set)(CFStringRef, CFStringRef, Boolean, CFDictionaryRef) = symbol(handle, "TCCAccessSetForBundleIdWithOptions");
    accepted = set((__bridge CFStringRef)service, (__bridge CFStringRef)bundle, allowed, (__bridge CFDictionaryRef)options);
  }
  if (!accepted) fail([NSString stringWithFormat:@"TCC %@ failed for %@ (%@)", action, bundle, service]);
}

int main(int argc, char **argv) { @autoreleasepool { @try {
  if (argc < 4 || argc > 6) fail(@"Usage: serve-sim-permissions <notifications|location|tcc> <get|grant|revoke|reset> <bundle-id> [value] [tcc-service]");
  NSString *family = @(argv[1]), *action = @(argv[2]), *bundle = @(argv[3]);
  NSString *value = argc > 4 ? @(argv[4]) : @"";
  if (![@[@"get", @"grant", @"revoke", @"reset"] containsObject:action]) fail(@"Unknown permission action");
  id result;
  if ([family isEqual:@"notifications"]) result = notifications(action, bundle, value);
  else if ([family isEqual:@"location"] && [action isEqual:@"get"] && argc == 5) {
    if (![[NSFileManager defaultManager] fileExistsAtPath:value]) result = [NSNull null];
    else {
      NSDictionary *clients = [NSDictionary dictionaryWithContentsOfFile:value];
      if (!clients) fail(@"Cannot read locationd clients plist");
      NSNumber *authorization = clients[[NSString stringWithFormat:@"i%@:", bundle]][@"Authorization"];
      result = authorization ? @{@"Authorization":authorization} : [NSNull null];
    }
  }
  else if ([family isEqual:@"tcc"] && ![action isEqual:@"get"] && argc == 6) {
    tcc(action, @(argv[5]), bundle, value); result = @{@"ok":@YES};
  } else fail(@"Unsupported permission operation");
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:NULL];
  if (!data) fail(@"Cannot encode permission state");
  puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  return 0;
} @catch (NSException *exception) {
  fprintf(stderr, "%s\n", (exception.reason ?: exception.name).UTF8String); return 1;
} } }
