#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

// The host side is src/sim-keychain.ts. Both sides share the app's TMPDIR:
//   serve-sim-keychain/requests/<name>.json    written by the host with one rename
//   serve-sim-keychain/responses/<nonce>.json  written here with one rename
// The calls run inside the app, so they use the app's keychain entitlements and
// its default access group, which no process outside the app has.

static const unsigned long long kMaxRequestBytes = 1024 * 1024;

static NSString *mailbox(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || tmp[0] == '\0') return nil;
  return [[NSString stringWithUTF8String:tmp] stringByAppendingPathComponent:@"serve-sim-keychain"];
}

static BOOL isNonce(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *nonce = value;
  if (nonce.length == 0 || nonce.length > 64) return NO;
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
  return [nonce rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

static CFStringRef accessibleConstant(NSString *name) {
  NSDictionary<NSString *, id> *values = @{
    @"afterFirstUnlock" : (__bridge id)kSecAttrAccessibleAfterFirstUnlock,
    @"afterFirstUnlockThisDeviceOnly" : (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    @"whenUnlocked" : (__bridge id)kSecAttrAccessibleWhenUnlocked,
    @"whenUnlockedThisDeviceOnly" : (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    @"whenPasscodeSetThisDeviceOnly" : (__bridge id)kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
  };
  return (__bridge CFStringRef)values[name];
}

static NSData *base64(id value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  return [[NSData alloc] initWithBase64EncodedString:value options:0];
}

// Attribute bytes arrive as base64. Some libraries store the account as data and
// others as a string, and the keychain matches the type it stored.
static id attribute(NSData *bytes, BOOL asData) {
  return asData ? bytes : [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
}

// Service, account, and access group identify a generic password. Without an account, a query
// covers every item in the service, as a library that keeps one item per service deletes them.
// Without a service, it covers the account in every service, for a library that sets no service.
// A query needs one of the two, not empty, so it never covers every item, nor every item without
// a service or without an account. Generic is an attribute: matching
// on it would miss an item stored with another value, and the add would then collide.
static NSMutableDictionary *itemQuery(NSDictionary *operation, BOOL needsAccount, NSString **error) {
  id service = operation[@"service"];
  BOOL hasAccount = operation[@"account"] != nil;
  NSData *account = base64(operation[@"account"]);
  BOOL asData = [operation[@"attributesAsData"] isEqual:@YES];
  if (service != nil && ![service isKindOfClass:NSString.class]) {
    *error = @"service must be a string";
    return nil;
  }
  if ((hasAccount || needsAccount) && (account == nil || attribute(account, asData) == nil)) {
    *error = @"needs a base64 account";
    return nil;
  }
  // A query with neither would match every generic password the app can reach.
  if ([service length] == 0 && account.length == 0) {
    *error = @"needs a nonempty service or account";
    return nil;
  }
  NSMutableDictionary *query =
      [@{(__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword} mutableCopy];
  if (service != nil) query[(__bridge id)kSecAttrService] = service;
  if (hasAccount) query[(__bridge id)kSecAttrAccount] = attribute(account, asData);
  if (operation[@"accessGroup"] != nil) {
    if (![operation[@"accessGroup"] isKindOfClass:NSString.class]) {
      *error = @"accessGroup must be a string";
      return nil;
    }
    query[(__bridge id)kSecAttrAccessGroup] = operation[@"accessGroup"];
  }
  return query;
}

static NSDictionary *deleteItem(NSDictionary *operation) {
  NSString *error = nil;
  NSMutableDictionary *query = itemQuery(operation, NO, &error);
  if (query == nil) return @{@"status" : @(errSecParam), @"error" : error};
  return @{@"status" : @(SecItemDelete((__bridge CFDictionaryRef)query))};
}

static void deleteEach(NSArray *items) {
  for (id item in items) {
    if ([item isKindOfClass:NSDictionary.class]) deleteItem(item);
  }
}

static NSDictionary *setItem(NSDictionary *operation) {
  NSString *error = nil;
  NSMutableDictionary *query = itemQuery(operation, YES, &error);
  NSData *data = base64(operation[@"data"]);
  if (query == nil || data == nil) return @{@"status" : @(errSecParam), @"error" : error ?: @"data must be base64"};
  NSMutableDictionary *attributes = [@{(__bridge id)kSecValueData : data} mutableCopy];
  if (operation[@"generic"] != nil) {
    NSData *generic = base64(operation[@"generic"]);
    id value = generic == nil ? nil : attribute(generic, [operation[@"attributesAsData"] isEqual:@YES]);
    if (value == nil) return @{@"status" : @(errSecParam), @"error" : @"generic must be base64"};
    attributes[(__bridge id)kSecAttrGeneric] = value;
  }
  if (operation[@"accessible"] != nil) {
    CFStringRef accessible = [operation[@"accessible"] isKindOfClass:NSString.class]
        ? accessibleConstant(operation[@"accessible"]) : NULL;
    if (accessible == NULL) return @{@"status" : @(errSecParam), @"error" : @"unknown accessible value"};
    attributes[(__bridge id)kSecAttrAccessible] = (__bridge id)accessible;
  }
  for (NSString *list in @[@"clears", @"replaces"]) {
    if (operation[list] != nil && ![operation[list] isKindOfClass:NSArray.class])
      return @{@"status" : @(errSecParam), @"error" : [list stringByAppendingString:@" must be a list"]};
  }
  // Items the library removes before it stores the key, such as the rest of a one-item service.
  deleteEach(operation[@"clears"]);
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
  if (status == errSecItemNotFound) {
    [query addEntriesFromDictionary:attributes];
    status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
  }
  // Other places a library reads the same key, removed only once the new value is in place. A copy
  // that stays fails the set, as the app could still read the old value there.
  for (id other in operation[@"replaces"]) {
    if (status != errSecSuccess) break;
    if (![other isKindOfClass:NSDictionary.class]) continue;
    OSStatus removed = [deleteItem(other)[@"status"] intValue];
    if (removed != errSecItemNotFound) status = removed;
  }
  return @{@"status" : @(status)};
}


static NSString *attributeBase64(id value) {
  if ([value isKindOfClass:NSData.class]) return [value base64EncodedStringWithOptions:0];
  if ([value isKindOfClass:NSString.class])
    return [[value dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0];
  return nil;
}

// Attributes only. Values never leave the app through this channel.
static NSDictionary *listItems(NSDictionary *operation) {
  NSMutableDictionary *query = [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitAll,
    (__bridge id)kSecReturnAttributes : @YES,
  } mutableCopy];
  NSDictionary *filters = @{@"service" : (__bridge id)kSecAttrService, @"accessGroup" : (__bridge id)kSecAttrAccessGroup};
  for (NSString *key in filters) {
    id value = operation[key];
    if (value == nil) continue;
    if (![value isKindOfClass:NSString.class]) return @{@"status" : @(errSecParam), @"error" : @"filters must be strings"};
    query[filters[key]] = value;
  }
  CFTypeRef found = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
  NSArray *rows = status == errSecSuccess ? (__bridge_transfer NSArray *)found : @[];
  NSMutableArray *items = [NSMutableArray array];
  for (NSDictionary *row in rows) {
    // An item stored without a service reports none, or an empty one.
    id service = row[(__bridge id)kSecAttrService] ?: @"";
    NSString *account = attributeBase64(row[(__bridge id)kSecAttrAccount]);
    if (![service isKindOfClass:NSString.class] || account == nil) continue;
    NSMutableDictionary *item = [@{@"service" : service, @"account" : account} mutableCopy];
    NSString *group = row[(__bridge id)kSecAttrAccessGroup];
    if ([group isKindOfClass:NSString.class]) item[@"accessGroup"] = group;
    [items addObject:item];
  }
  return @{@"status" : @(status == errSecItemNotFound ? errSecSuccess : status), @"items" : items};
}

static NSDictionary *run(id operation) {
  if (![operation isKindOfClass:NSDictionary.class]) return @{@"status" : @(errSecParam), @"error" : @"not an object"};
  NSString *op = operation[@"op"];
  if ([op isEqual:@"set"]) return setItem(operation);
  if ([op isEqual:@"delete"]) return deleteItem(operation);
  if ([op isEqual:@"list"]) return listItems(operation);
  return @{@"status" : @(errSecParam), @"error" : @"unknown op"};
}

static BOOL publish(NSString *responses, NSString *nonce, NSArray *results) {
  NSData *body = [NSJSONSerialization dataWithJSONObject:@{@"nonce" : nonce, @"results" : results} options:0 error:nil];
  NSString *pending = [responses stringByAppendingPathComponent:
      [NSString stringWithFormat:@".%@.%d.pending", nonce, getpid()]];
  NSString *done = [responses stringByAppendingPathComponent:[nonce stringByAppendingPathExtension:@"json"]];
  if (body == nil || ![body writeToFile:pending atomically:NO] || rename(pending.fileSystemRepresentation, done.fileSystemRepresentation) != 0) {
    unlink(pending.fileSystemRepresentation);
    return NO;
  }
  return YES;
}

static void answer(NSString *root, NSString *name) {
  NSString *requests = [root stringByAppendingPathComponent:@"requests"];
  NSString *path = [requests stringByAppendingPathComponent:name];
  // Claimed names drop the .json suffix, so a second process skips them.
  NSString *claimed = [path stringByAppendingFormat:@".%d.claimed", getpid()];
  if (rename(path.fileSystemRepresentation, claimed.fileSystemRepresentation) != 0) return;
  // Only a regular file: a symlink or a FIFO could pass the size check and then block or overread.
  NSDictionary *info = [NSFileManager.defaultManager attributesOfItemAtPath:claimed error:nil];
  NSData *body = [info.fileType isEqualToString:NSFileTypeRegular] && info.fileSize <= kMaxRequestBytes
      ? [NSData dataWithContentsOfFile:claimed]
      : nil;
  // The request can carry secrets; it leaves the disk before anything else runs.
  unlink(claimed.fileSystemRepresentation);
  NSDictionary *request = body ? [NSJSONSerialization JSONObjectWithData:body options:0 error:nil] : nil;
  if (![request isKindOfClass:NSDictionary.class] || !isNonce(request[@"nonce"])
      || ![request[@"operations"] isKindOfClass:NSArray.class]
      || ![request[@"expiresAt"] isKindOfClass:NSNumber.class]) {
    fprintf(stderr, "[serve-sim] keychain: ignored an unreadable request %s\n", name.UTF8String);
    // No results: the host reads that as an answer it cannot use, not as an app that quit.
    if ([request isKindOfClass:NSDictionary.class] && isNonce(request[@"nonce"]))
      publish([root stringByAppendingPathComponent:@"responses"], request[@"nonce"], @[]);
    return;
  }
  // A request queued for a closed app must not overwrite values the app stored much later.
  if ([request[@"expiresAt"] doubleValue] < NSDate.date.timeIntervalSince1970 * 1000) {
    fprintf(stderr, "[serve-sim] keychain: dropped an expired request %s\n", name.UTF8String);
    return;
  }
  NSMutableArray *results = [NSMutableArray array];
  for (id operation in request[@"operations"]) {
    @autoreleasepool {
      [results addObject:run(operation)];
    }
  }
  if (!publish([root stringByAppendingPathComponent:@"responses"], request[@"nonce"], results))
    fprintf(stderr, "[serve-sim] keychain: could not publish the answer to %s\n", name.UTF8String);
}

static void drain(NSString *root) {
  NSString *requests = [root stringByAppendingPathComponent:@"requests"];
  NSArray *names = [[NSFileManager.defaultManager contentsOfDirectoryAtPath:requests error:nil]
      sortedArrayUsingSelector:@selector(compare:)];
  for (NSString *name in names) {
    if ([name hasPrefix:@"."] || ![name.pathExtension isEqual:@"json"]) continue;
    @autoreleasepool {
      answer(root, name);
    }
  }
}

// Polled like the clipboard reader. Creating the folders on each pass also covers an app that
// empties its tmp folder.
static const int64_t kPollIntervalNs = 100 * NSEC_PER_MSEC;

// Held for the life of the app; ARC would otherwise release it when the setup function returns.
static dispatch_source_t pollTimer;

static void poll(NSString *root) {
  for (NSString *dir in @[root, [root stringByAppendingPathComponent:@"requests"],
                          [root stringByAppendingPathComponent:@"responses"]]) {
    if (mkdir(dir.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) return;
  }
  drain(root);
}

__attribute__((constructor))
static void sim_keychain_init(void) {
  NSString *root = mailbox();
  if (root == nil) return;
  dispatch_queue_t queue = dispatch_queue_create("dev.expo.serve-sim.keychain", DISPATCH_QUEUE_SERIAL);
  pollTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
  dispatch_source_set_timer(pollTimer, DISPATCH_TIME_NOW, kPollIntervalNs, kPollIntervalNs / 4);
  dispatch_source_set_event_handler(pollTimer, ^{
    @autoreleasepool {
      poll(root);
    }
  });
  dispatch_resume(pollTimer);
}
