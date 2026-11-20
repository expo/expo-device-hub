#pragma once
#import <Foundation/Foundation.h>
#import <xpc/xpc.h>

NS_ASSUME_NONNULL_BEGIN

NSObject * _Nullable SSMediaStreamNegotiator(NSDictionary *options, NSInteger mode);
NSData * _Nullable SSMediaStreamOffer(NSObject *negotiator);
NSDictionary * _Nullable SSMediaStreamApplyAnswer(NSObject *negotiator, NSData *answer);

@interface SSMediaStreamReceiver : NSObject
@property (nonatomic, readonly) uint16_t reservedPort;
- (nullable NSString *)bindForTunnel:(NSString *)tunnelAddress;
- (void)releaseReservedSocket;
- (BOOL)adoptSharedSockets:(xpc_object_t)sockets;
- (nullable NSData *)receiveWithTimeout:(int)milliseconds failed:(BOOL *)failed;
- (BOOL)send:(NSData *)packet;
- (void)close;
@end

NS_ASSUME_NONNULL_END
