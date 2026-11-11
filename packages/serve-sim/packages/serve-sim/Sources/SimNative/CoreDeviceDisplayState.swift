import Foundation
import CoreDeviceShim

/// Display-info events include physical pose even when the app keeps its screen portrait.
struct DisplayDeviceState: Decodable {
    struct Orientation: Decodable { let currentDeviceOrientation: String }
    let orientation: Orientation?

    var physicalOrientation: String? {
        orientation.flatMap { ObservedPhysicalOrientation.name($0.currentDeviceOrientation) }
    }
}

extension CoreDeviceBridge {
    func consumeDisplayStateUpdates(udid: String,
                                   onRegistered: @escaping @Sendable () async -> Void,
                                   onUpdate: @escaping @Sendable (DeviceStateUpdate) async -> Void) async throws -> Bool {
        guard SSCoreDeviceDisplayAvailable(), SSCoreDeviceDisplayStateAvailable(),
              let metadata = SSCoreDeviceDisplayInfoMetadata(),
              let pointer = SSCoreDeviceDisplayStatePointer(),
              let type = unsafeBitCast(metadata, to: Any.Type.self) as? any Encodable.Type else { return false }
        let capability = try await capability(udid: udid,
            metadataSymbol: "$s10CoreDevice21DisplayInfoCapabilityVN",
            witnessSymbol: "$s10CoreDevice21DisplayInfoCapabilityVAA0bE0AAWP")
        try Task.checkCancellation()
        typealias Start = @convention(thin) (UnsafeMutableRawPointer, UnsafeRawPointer, UnsafeRawPointer, UnsafeRawPointer) async throws -> Void
        let start = unsafeBitCast(pointer, to: Start.self)
        func consume<T: Encodable>(_: T.Type) async throws {
            let result = UnsafeMutablePointer<AsyncThrowingStream<T, Error>>.allocate(capacity: 1)
            defer { result.deallocate() }
            try await start(result, capability.storage.load(fromByteOffset: 24, as: UnsafeRawPointer.self),
                            capability.storage.load(fromByteOffset: 32, as: UnsafeRawPointer.self), capability.storage)
            let stream = result.move()
            await onRegistered()
            for try await value in stream {
                try Task.checkCancellation()
                // DisplayInfo has no source timestamp. Fence its receipt with the existing
                // boot/connection identity; never present a command or a getter as an event.
                let receivedAt = hingeClock()
                let snapshot = try JSONDecoder().decode(DisplayDeviceState.self, from: JSONEncoder().encode(value))
                await onUpdate(.orientation(.init(orientation: snapshot.physicalOrientation, timestamp: receivedAt)))
            }
        }
        try await consume(type)
        return true
    }
}
