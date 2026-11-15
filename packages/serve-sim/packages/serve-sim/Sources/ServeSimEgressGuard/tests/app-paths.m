// Ordinary app networking probes for the Simulator harness. Each probe targets a
// listener the host harness owns on this machine's own address; nothing leaves it.
#include <TargetConditionals.h>
#if !TARGET_OS_SIMULATOR
#error This probe must target the iOS Simulator.
#endif
#import <Foundation/Foundation.h>
#import <Network/Network.h>
#include <mach-o/dyld.h>
#include <stdlib.h>
#include <string.h>

static const int64_t kTimeout = 5 * NSEC_PER_SEC;

static BOOL mapped(const char *expected) {
  char target[4096], actual[4096];
  if (!realpath(expected, target)) return NO;
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *name = _dyld_get_image_name(i);
    if (name && realpath(name, actual) && strcmp(actual, target) == 0) return YES;
  }
  return NO;
}

static NSDictionary *urlSession(NSString *host, NSString *port, NSString *tag) {
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.timeoutIntervalForRequest = 5;
  configuration.connectionProxyDictionary = @{}; // A system proxy must not hide the direct path.
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://%@:%@/%@-urlsession", host, port, tag]];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  NSObject *lock = [NSObject new];
  __block NSDictionary *result = nil;
  [[session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    (void)data;
    NSDictionary *value = error ? @{@"outcome": @"failed", @"domain": error.domain, @"code": @(error.code)}
                                : @{@"outcome": @"response", @"status": @(((NSHTTPURLResponse *)response).statusCode)};
    @synchronized (lock) {
      if (!result) result = value;
    }
    dispatch_semaphore_signal(done);
  }] resume];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, kTimeout + NSEC_PER_SEC));
  // The first outcome wins; a completion after the timeout cannot change the report.
  NSDictionary *snapshot;
  @synchronized (lock) {
    if (!result) result = @{@"outcome": @"timeout"};
    snapshot = result;
  }
  [session invalidateAndCancel];
  return snapshot;
}

static NSDictionary *nwConnection(NSString *host, NSString *port, NSString *payload, BOOL udp) {
  nw_parameters_t parameters = udp
      ? nw_parameters_create_secure_udp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION)
      : nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
  nw_endpoint_t endpoint = nw_endpoint_create_host(host.UTF8String, port.UTF8String);
  nw_connection_t connection = nw_connection_create(endpoint, parameters);
  dispatch_queue_t queue = dispatch_queue_create("app-paths.nw", DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSMutableDictionary *result = [@{@"outcome": @"timeout"} mutableCopy];
  __block BOOL finished = NO;
  void (^finish)(NSDictionary *) = ^(NSDictionary *value) {
    if (finished) return;
    finished = YES;
    [result setDictionary:value];
    dispatch_semaphore_signal(done);
  };
  nw_connection_set_queue(connection, queue);
  nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, nw_error_t error) {
    int code = error ? nw_error_get_error_code(error) : 0;
    if (state == nw_connection_state_ready) {
      NSData *bytes = [payload dataUsingEncoding:NSUTF8StringEncoding];
      dispatch_data_t content = dispatch_data_create(bytes.bytes, bytes.length, queue, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
      nw_connection_send(connection, content, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true, ^(nw_error_t sendError) {
        finish(sendError ? @{@"outcome": @"sendFailed", @"code": @(nw_error_get_error_code(sendError))}
                         : @{@"outcome": @"sent"});
      });
    } else if (state == nw_connection_state_failed) {
      finish(@{@"outcome": @"failed", @"code": @(code)});
    } else if (state == nw_connection_state_waiting) {
      finish(@{@"outcome": @"waiting", @"code": @(code)});
    }
  });
  nw_connection_start(connection);
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, kTimeout));
  // Read and close the result on its queue, so later callbacks cannot change the report.
  __block NSDictionary *snapshot;
  dispatch_sync(queue, ^{
    finished = YES;
    snapshot = [result copy];
  });
  // Let a sent TCP request reach the listener before cancellation.
  if ([snapshot[@"outcome"] isEqual:@"sent"]) [NSThread sleepForTimeInterval:0.5];
  nw_connection_cancel(connection);
  return snapshot;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 7) {
      fprintf(stderr, "usage: app-paths LOADER GUARD HOST TCP-PORT UDP-PORT TAG\n");
      return 2;
    }
    if (!mapped(argv[1]) || !mapped(argv[2])) {
      fprintf(stderr, "app-paths: loader or guard is not mapped\n");
      return 2;
    }
    NSString *host = @(argv[3]), *tcp = @(argv[4]), *udp = @(argv[5]), *tag = @(argv[6]);
    NSDictionary *output = @{
      @"urlSession": urlSession(host, tcp, tag),
      @"nwTcp": nwConnection(host, tcp, [NSString stringWithFormat:@"GET /%@-nwtcp HTTP/1.0\r\n\r\n", tag], NO),
      @"nwUdp": nwConnection(host, udp, [NSString stringWithFormat:@"%@-nwudp", tag], YES),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:output options:NSJSONWritingSortedKeys error:NULL];
    if (!json) return 1;
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    return 0;
  }
}
