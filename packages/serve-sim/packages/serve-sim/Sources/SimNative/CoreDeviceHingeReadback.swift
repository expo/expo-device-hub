import Foundation
import CoreDeviceShim

extension CoreDeviceBridge {
    /// Read one valid native angle; never keep a motion subscription running
    /// after recovery, or wait indefinitely on a runtime that emits no sample.
    func readHingeAngle(udid: String) async -> Double? {
        guard #available(macOS 15.0, *), SSCoreDeviceHingeReadbackAvailable(),
              let metadata = SSCoreDeviceHingeReadbackMetadata(),
              let configMetadata = SSCoreDeviceHingeConfigMetadata(),
              let errorMetadata = SSCoreDeviceErrorMetadata(),
              let pointer = SSCoreDeviceHingeReadbackPointer(),
              let type = unsafeBitCast(metadata, to: Any.Type.self) as? any Encodable.Type,
              let configType = unsafeBitCast(configMetadata, to: Any.Type.self) as? any Decodable.Type
        else { return nil }
        do {
            return try await withMotionManager(udid: udid) { manager in
                func configure<C: Decodable>(_: C.Type) async throws -> Double? {
                    // Open Apple's Codable type instead of assuming the layout
                    // of its resilient config or snapshot structures.
                    let config = UnsafeMutablePointer<C>.allocate(capacity: 1)
                    defer { config.deallocate() }
                    let data = try JSONEncoder().encode(HingeReadbackConfig())
                    config.initialize(to: try JSONDecoder().decode(C.self, from: data))
                    defer { config.deinitialize(count: 1) }
                    func read<T: Encodable>(_: T.Type) async throws -> Double? {
                        let output = UnsafeMutablePointer<AsyncThrowingStream<[T], Error>>.allocate(capacity: 1)
                        let errorBuffer = UnsafeMutableRawPointer.allocate(byteCount: Int(SSCoreDeviceValueSize(errorMetadata)), alignment: 16)
                        defer { output.deallocate(); errorBuffer.deallocate() }
                        typealias Monitor = @convention(thin) (UnsafeMutableRawPointer, UnsafeMutableRawPointer, UnsafeMutableRawPointer, UnsafeMutableRawPointer) async throws(HingeReadbackCallFailed) -> Void
                        let monitor = unsafeBitCast(pointer, to: Monitor.self)
                        do { try await monitor(output, errorBuffer, config, manager) }
                        catch {
                            SSCoreDeviceDestroyValue(errorBuffer, errorMetadata)
                            return nil
                        }
                        let stream = output.move()
                        let latest = HingeReadbackSamples()
                        return try await withThrowingTaskGroup(of: Double?.self) { group in
                            group.addTask {
                                for try await samples in stream {
                                    for sample in samples.reversed() {
                                        let data = try JSONEncoder().encode(sample)
                                        let sample = try JSONDecoder().decode(HingeReadbackSample.self, from: data)
                                        let angle = sample.angle.converted(to: .degrees).value
                                        if sample.isAngleValid, angle.isFinite, (0...180).contains(angle) { await latest.update(angle) }
                                    }
                                }
                                return await latest.angle
                            }
                            group.addTask {
                                let deadline = ContinuousClock.now.advanced(by: .seconds(1))
                                // The first sample may predate the just-sent
                                // HID event. Allow two 10 Hz samples to settle.
                                repeat {
                                    try await Task.sleep(for: .milliseconds(50))
                                    if await latest.isSettled { return await latest.angle }
                                } while ContinuousClock.now < deadline
                                return await latest.angle
                            }
                            defer { group.cancelAll() }
                            return try await group.next() ?? nil
                        }
                    }
                    return try await _openExistential(type, do: read)
                }
                return try await _openExistential(configType, do: configure)
            }
        } catch {
            fputs("[hid] Hinge readback unavailable: \(error)\n", stderr)
            return nil
        }
    }
}

private struct HingeReadbackConfig: Encodable {
    let changeThreshold = Measurement(value: 1.0, unit: UnitAngle.degrees)
    let updateInterval = Duration.milliseconds(100)
}

private struct HingeReadbackSample: Decodable {
    let angle: Measurement<UnitAngle>
    let isAngleValid: Bool
}

private struct HingeReadbackCallFailed: Error {}

private actor HingeReadbackSamples {
    private(set) var angle: Double?
    private var changed = ContinuousClock.now

    func update(_ value: Double) {
        if angle != value { angle = value; changed = .now }
    }

    var isSettled: Bool { angle != nil && ContinuousClock.now - changed >= .milliseconds(200) }
}
