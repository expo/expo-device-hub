import CoreMedia
import CoreVideo
import Foundation
import StreamingPolicy

typealias ScreenSourceFrameHandler = @Sendable (CVPixelBuffer, CMTime, Dimensions?, CapturedScreenInfo) -> Void
typealias ScreenSourceEndHandler = @Sendable (ScreenSourceEnd) -> Void

struct ScreenSourceEnd: Codable, Equatable, Sendable {
    enum Reason: String, Codable, Sendable {
        case deviceDisconnected = "device-disconnected"
    }

    let reason: Reason
    let message: String

    static let iPhoneDisconnected = ScreenSourceEnd(reason: .deviceDisconnected, message: "iPhone disconnected")

    func json() -> String {
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

enum ScreenSourceKind: String, Sendable {
    case simulator
    case physical

    init(argument: String?) throws {
        guard let argument, !argument.isEmpty else {
            self = .simulator
            return
        }
        guard let kind = ScreenSourceKind(rawValue: argument) else {
            throw NSError(domain: "ScreenSource", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Unknown device kind \(argument)"])
        }
        self = kind
    }

    func makeSource() -> any ScreenSource {
        switch self {
        case .simulator: return SimulatorScreenSource()
        case .physical: return PhysicalScreenSource()
        }
    }

    // @ref LLP 0027#the-seam — HID takes its transport, screen and rotations from the source kind
    func inputTarget(deviceUDID: String) async throws -> ScreenInputTarget {
        switch self {
        case .simulator: return try SimulatorScreenSource.inputTarget(deviceUDID: deviceUDID)
        case .physical: return try await PhysicalScreenSource.inputTarget(deviceUDID: deviceUDID)
        }
    }
}

struct ScreenInputTarget: @unchecked Sendable {
    enum Transport: Equatable, Sendable {
        case simulator(prefersCoreDevice: Bool)
        case coreDeviceOnly
    }

    let transport: Transport
    let defaultScreenID: UInt32?
    let screenSize: Dimensions?
    let nativeScreenRotations: [UInt32: Int]
    let isFoldable: Bool
    let simDevice: NSObject?
    let connect: (@Sendable () async throws -> Void)?
}

// @ref LLP 0027#the-seam — CaptureEngine reads a simulator and a phone through one protocol; only a phone calls onEnd
protocol ScreenSource: Actor {
    var isFoldable: Bool { get }
    var supportsDevicePose: Bool { get }

    func start(deviceUDID: String, screenID: UInt32?, onFrame: @escaping ScreenSourceFrameHandler,
               onEnd: @escaping ScreenSourceEndHandler) async throws
    func stop(preservingObservers: Bool) async
    func setSnapshotMaxDimension(_ value: Int)
    func screenshotPixels(screenID: UInt32) async throws -> (pixels: CVPixelBuffer, orientation: String?, screen: RecordingScreen?)
    func getScreenSize() -> CapturedScreenInfo?
    func activeScreenID() async throws -> UInt32
    func subscribeScreenChanges(_ callback: @escaping @Sendable () -> Void) -> @Sendable () async -> Void
    func webRTCEncodeCanvasSize() -> Dimensions?
    func recordingCanvasSize() -> Dimensions?
    func frameCounts() -> (screen: UInt64, idle: UInt64)
    func pickTimings() -> (count: UInt64, sumNs: UInt64, maxNs: UInt64)
    func captureTimings() -> (attempts: UInt64, gapSumNs: UInt64, stalls: UInt64, stallSumNs: UInt64,
                              cpuFallbacks: UInt64, poolDrops: UInt64)
    func pollTimings() -> (ticks: UInt64, lateSumNs: UInt64)
    func surfaceLossTimings() -> (losses: UInt64, lostNs: UInt64, rewires: UInt64)
}
