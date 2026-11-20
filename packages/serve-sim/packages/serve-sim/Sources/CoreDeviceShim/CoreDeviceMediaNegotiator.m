#import "CoreDeviceMediaNegotiator.h"
#import <arpa/inet.h>
#import <dlfcn.h>
#import <errno.h>
#import <netinet/in.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <os/lock.h>
#import <poll.h>
#import <sys/socket.h>
#import <unistd.h>

@interface NSObject (SSMediaStreamNegotiator)
- (instancetype)initWithMode:(NSInteger)mode options:(NSDictionary *)options error:(NSError **)error;
- (id)offer;
- (BOOL)setAnswer:(NSData *)answer withError:(NSError **)error;
- (id)generateMediaStreamConfigurationWithError:(NSError **)error;
- (id)dictionary;
@end

static NSString *const SSStandaloneHEVCFeatures = @"FLS;MS:-1;LF:-1;LTR;CABAC;POS:0;EOD:1;HTS:2;RR:3;AR:16/9,5/8;XR:16/9,5/8;";
static NSNumber *const SSHEVCPayload = @100;
static IMP SSOriginalScreenFeatures;

static NSDictionary *SSScreenDecoderFeatures(id self, SEL selector) {
    NSDictionary *original = ((NSDictionary *(*)(id, SEL))SSOriginalScreenFeatures)(self, selector);
    NSMutableDictionary *features = [original mutableCopy];
    if (features[SSHEVCPayload]) features[SSHEVCPayload] = SSStandaloneHEVCFeatures;
    return features;
}

static BOOL SSLongTermReferencesDisabled(id self, SEL selector) {
    return NO;
}

static void SSDisableLongTermReferences(NSString *className) {
    Method getter = class_getInstanceMethod(NSClassFromString(className), @selector(ltrpEnabled));
    if (getter) method_setImplementation(getter, (IMP)SSLongTermReferencesDisabled);
}

static BOOL SSInstallNegotiatorOverrides(void) {
    static dispatch_once_t once;
    static BOOL installed;
    dispatch_once(&once, ^{
        if (!dlopen("/System/Library/PrivateFrameworks/AVConference.framework/AVConference", RTLD_NOW)) return;
        Class settings = NSClassFromString(@"AVCMediaStreamNegotiatorSettingsCoreDeviceScreenSharing");
        Method features = class_getInstanceMethod(settings, @selector(featureListString));
        if (!features) return;
        SSOriginalScreenFeatures = method_setImplementation(features, (IMP)SSScreenDecoderFeatures);
        SSDisableLongTermReferences(@"AVCMediaStreamNegotiatorSettings");
        SSDisableLongTermReferences(@"VCMediaNegotiatorLocalConfiguration");
        installed = YES;
    });
    return installed;
}

NSObject *SSMediaStreamNegotiator(NSDictionary *options, NSInteger mode) {
    if (!SSInstallNegotiatorOverrides()) return nil;
    Class negotiatorClass = NSClassFromString(@"AVCMediaStreamNegotiator");
    if (!negotiatorClass) return nil;
    NSError *error = nil;
    id negotiator = [(id)[negotiatorClass alloc] initWithMode:mode options:options error:&error];
    return error ? nil : negotiator;
}

NSData *SSMediaStreamOffer(NSObject *negotiator) {
    id offer = [negotiator offer];
    return [offer isKindOfClass:NSData.class] ? offer : nil;
}

NSDictionary *SSMediaStreamApplyAnswer(NSObject *negotiator, NSData *answer) {
    NSError *error = nil;
    if (![negotiator setAnswer:answer withError:&error]) return nil;
    id configuration = [negotiator generateMediaStreamConfigurationWithError:&error];
    if (error || !configuration) return nil;
    id dictionary = [configuration dictionary];
    return [dictionary isKindOfClass:NSDictionary.class] ? dictionary : nil;
}

@implementation SSMediaStreamReceiver {
    os_unfair_lock _lock;
    int _descriptor;
    uint16_t _reservedPort;
}

- (instancetype)init {
    if ((self = [super init])) {
        _lock = OS_UNFAIR_LOCK_INIT;
        _descriptor = -1;
    }
    return self;
}

- (void)dealloc {
    [self close];
}

- (uint16_t)reservedPort {
    return _reservedPort;
}

- (int)descriptor {
    os_unfair_lock_lock(&_lock);
    int descriptor = _descriptor;
    os_unfair_lock_unlock(&_lock);
    return descriptor;
}

- (void)replaceDescriptor:(int)descriptor {
    os_unfair_lock_lock(&_lock);
    int previous = _descriptor;
    _descriptor = descriptor;
    os_unfair_lock_unlock(&_lock);
    if (previous >= 0) close(previous);
}

static void SSEnlargeReceiveBuffer(int descriptor) {
    int size = 4 * 1024 * 1024;
    setsockopt(descriptor, SOL_SOCKET, SO_RCVBUF, &size, sizeof(size));
}

- (NSString *)bindForTunnel:(NSString *)tunnelAddress {
    struct sockaddr_in6 destination = {0}, source = {0};
    destination.sin6_len = sizeof(destination);
    destination.sin6_family = AF_INET6;
    destination.sin6_port = htons(9);
    if (inet_pton(AF_INET6, tunnelAddress.UTF8String, &destination.sin6_addr) != 1) return nil;
    int route = socket(AF_INET6, SOCK_DGRAM, 0);
    if (route < 0) return nil;
    socklen_t length = sizeof(source);
    bool routed = connect(route, (struct sockaddr *)&destination, sizeof(destination)) == 0
        && getsockname(route, (struct sockaddr *)&source, &length) == 0;
    close(route);
    if (!routed) return nil;
    char address[INET6_ADDRSTRLEN];
    if (!inet_ntop(AF_INET6, &source.sin6_addr, address, sizeof(address))) return nil;
    int descriptor = socket(AF_INET6, SOCK_DGRAM, 0);
    if (descriptor < 0) return nil;
    source.sin6_port = 0;
    length = sizeof(source);
    if (bind(descriptor, (struct sockaddr *)&source, sizeof(source)) != 0
        || getsockname(descriptor, (struct sockaddr *)&source, &length) != 0) {
        close(descriptor);
        return nil;
    }
    SSEnlargeReceiveBuffer(descriptor);
    _reservedPort = ntohs(source.sin6_port);
    [self replaceDescriptor:descriptor];
    return @(address);
}

- (void)releaseReservedSocket {
    [self replaceDescriptor:-1];
}

- (BOOL)adoptSharedSockets:(xpc_object_t)sockets {
    __block int adopted = -1;
    xpc_dictionary_apply(sockets, ^bool(const char *key, xpc_object_t value) {
        if (xpc_get_type(value) != XPC_TYPE_FD) return true;
        int descriptor = xpc_fd_dup(value);
        if (adopted < 0) adopted = descriptor;
        else if (descriptor >= 0) close(descriptor);
        return true;
    });
    if (adopted < 0) return NO;
    SSEnlargeReceiveBuffer(adopted);
    [self replaceDescriptor:adopted];
    return YES;
}

- (NSData *)receiveWithTimeout:(int)milliseconds failed:(BOOL *)failed {
    *failed = NO;
    int descriptor = [self descriptor];
    if (descriptor < 0) {
        *failed = YES;
        return nil;
    }
    struct pollfd waiter = {descriptor, POLLIN, 0};
    int ready = poll(&waiter, 1, milliseconds);
    if (ready < 0) {
        *failed = errno != EINTR;
        return nil;
    }
    if (ready == 0) return nil;
    if (waiter.revents & (POLLERR | POLLHUP | POLLNVAL)) {
        *failed = YES;
        return nil;
    }
    uint8_t buffer[65536];
    ssize_t received = recv(descriptor, buffer, sizeof(buffer), 0);
    if (received < 0) {
        *failed = errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK;
        return nil;
    }
    return received > 0 ? [NSData dataWithBytes:buffer length:(NSUInteger)received] : nil;
}

- (BOOL)send:(NSData *)packet {
    int descriptor = [self descriptor];
    if (descriptor < 0) return NO;
    return send(descriptor, packet.bytes, packet.length, 0) == (ssize_t)packet.length;
}

- (void)close {
    [self replaceDescriptor:-1];
}

@end
