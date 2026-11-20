import CoreDeviceShim
import Foundation
import Network
import XPC

struct CoreDeviceMediaStreamError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

final class CoreDeviceUsageAssertionObject {
    @_silgen_name("SSCDMSRelease")
    final func releaseAssertion()
    @_silgen_name("SSCDMSInvalidation")
    final func registerInvalidationHandler(queue: DispatchQueue?, handler: @escaping (Error?) -> Void)
}

extension CoreDeviceRemoteDevice {
    @_silgen_name("SSCDMSDeviceInfo")
    final func deviceInfoValue<Info>() -> Info
    @_silgen_name("SSCDMSConnect")
    final func connect(queue: DispatchQueue?, completion: @escaping (Result<Void, Error>) -> Void)
    @_silgen_name("SSCDMSAcquire")
    final func acquireUsageAssertion<Requirements>(
        reason: String, requirements: Requirements, queue: DispatchQueue?,
        completion: @escaping @Sendable (Result<CoreDeviceUsageAssertionObject, Error>) -> Void
    ) -> Progress
    @_silgen_name("SSCDMSSupportAsync")
    final func mediaStreamSupportInfo<Response>() async throws -> Response
    @_silgen_name("SSCDMSStartAsync")
    final func startMediaStream<Request, Response>(request: Request) async throws -> Response
    @_silgen_name("SSCDMSStopAsync")
    final func stopMediaStream<Request, Response>(request: Request) async throws -> Response
}

@_silgen_name("SSCDMSNegotiatorOptions")
private func coreDeviceNegotiatorOptions<Info>(for info: Info) -> [String: Any]
@_silgen_name("SSCDMSSharedSocket")
private func coreDeviceWithSharedSocketDictionary<Value>(
    sourceAddress: IPv6Address, port: UInt16, remoteAddress: IPv6Address, remotePort: UInt16,
    body: (xpc_object_t) throws -> Value
) throws -> Value
@_silgen_name("SSCDMSClientName")
private func coreDeviceClientNameKey() -> String
@_silgen_name("SSCDMSClientSessionID")
private func coreDeviceClientSessionIDKey() -> String
@_silgen_name("SSCDMSCodableValue")
private func coreDeviceCodableValue<Value>(_ value: __owned Any) -> Value?

enum CoreDeviceMediaStreamCalls {
    static let queue = DispatchQueue(label: "serve-sim.coredevice-media-stream")

    static func available() -> Bool { SSCoreDeviceMediaStreamAvailable() }

    static func type(_ kind: SSCoreDeviceMediaStreamType) throws -> any Decodable.Type {
        guard let metadata = SSCoreDeviceMediaStreamTypeMetadata(kind),
              let type = unsafeBitCast(metadata, to: Any.Type.self) as? any Decodable.Type
        else { throw CoreDeviceMediaStreamError("CoreDevice media stream type \(kind.rawValue) is unavailable") }
        return type
    }

    static func decode(_ kind: SSCoreDeviceMediaStreamType, from object: Any) throws -> any Decodable {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(type(kind), from: data)
    }

    static func jsonObject(_ value: Any) throws -> Any {
        guard let encodable = value as? any Encodable else {
            throw CoreDeviceMediaStreamError("\(Swift.type(of: value)) is not Encodable")
        }
        return try JSONSerialization.jsonObject(with: JSONEncoder().encode(encodable), options: [.fragmentsAllowed])
    }

    static func connect(_ device: CoreDeviceRemoteDevice) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            device.connect(queue: queue) { continuation.resume(with: $0) }
        }
    }

    static func acquireAssertion(_ device: CoreDeviceRemoteDevice, reason: String, requirements: Any) async throws -> CoreDeviceUsageAssertionObject {
        let requirements = try decode(SSCoreDeviceMediaStreamUsageAssertionRequirements, from: requirements)
        func acquire<Requirements: Decodable>(_ requirements: Requirements) async throws -> CoreDeviceUsageAssertionObject {
            try await withCheckedThrowingContinuation { continuation in
                _ = device.acquireUsageAssertion(reason: reason, requirements: requirements, queue: queue) {
                    continuation.resume(with: $0)
                }
            }
        }
        return try await acquire(requirements)
    }

    static func supportInfo(_ device: CoreDeviceRemoteDevice) async throws -> Any {
        func call<Response: Decodable>(_: Response.Type) async throws -> Any {
            try await device.mediaStreamSupportInfo() as Response
        }
        return try await call(type(SSCoreDeviceMediaStreamSupportInfoResponse))
    }

    static func startStream(_ device: CoreDeviceRemoteDevice, request: Any) async throws -> Any {
        func withRequest<Request: Decodable>(_ request: Request) async throws -> Any {
            func withResponse<Response: Decodable>(_: Response.Type) async throws -> Any {
                try await device.startMediaStream(request: request) as Response
            }
            return try await withResponse(type(SSCoreDeviceMediaStreamStartResponse))
        }
        return try await withRequest(decode(SSCoreDeviceMediaStreamStartRequest, from: request))
    }

    static func stopStream(_ device: CoreDeviceRemoteDevice, identifiers: [UInt32]) async throws -> Any {
        func withRequest<Request: Decodable>(_ request: Request) async throws -> Any {
            func withResponse<Response: Decodable>(_: Response.Type) async throws -> Any {
                try await device.stopMediaStream(request: request) as Response
            }
            return try await withResponse(type(SSCoreDeviceMediaStreamStopResponse))
        }
        return try await withRequest(decode(SSCoreDeviceMediaStreamStopRequest, from: ["stopAll": false, "identifiers": identifiers]))
    }

    static func deviceInfo(_ device: CoreDeviceRemoteDevice) throws -> any Decodable {
        func read<Info: Decodable>(_: Info.Type) -> any Decodable { device.deviceInfoValue() as Info }
        return read(try type(SSCoreDeviceMediaStreamDeviceInfo))
    }

    static func negotiatorOptions(for deviceInfo: any Decodable) -> [String: Any] {
        func read<Info: Decodable>(_ info: Info) -> [String: Any] { coreDeviceNegotiatorOptions(for: info) }
        return read(deviceInfo)
    }

    static var clientNameKey: String { coreDeviceClientNameKey() }
    static var clientSessionIDKey: String { coreDeviceClientSessionIDKey() }

    static func codableValueJSON(_ value: Any) throws -> Any? {
        func make<Value: Decodable>(_: Value.Type) throws -> Any? {
            guard let made: Value = coreDeviceCodableValue(value) else { return nil }
            return try jsonObject(made)
        }
        return try make(type(SSCoreDeviceMediaStreamCodableValue))
    }

    static func sharedSocketDictionary<Value>(
        source: IPv6Address, port: UInt16, remote: IPv6Address, remotePort: UInt16,
        body: (xpc_object_t) throws -> Value
    ) throws -> Value {
        try coreDeviceWithSharedSocketDictionary(sourceAddress: source, port: port, remoteAddress: remote, remotePort: remotePort, body: body)
    }
}
