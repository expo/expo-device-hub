import Foundation

public enum RecordingScreen: String, Codable, Sendable {
    case inner
    case outer
}

/// Integer picture extent in the encoded canvas, with a top-left origin.
public struct RecordingContentRect: Codable, Equatable, Sendable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// Screen geometry and pose known when a video frame was submitted.
/// Screen orientation describes the framebuffer; physical orientation describes
/// the Duo device and can differ when an app locks its interface orientation.
public struct RecordingDeviceState: Codable, Equatable {
    public let width: Int
    public let height: Int
    public let orientation: String?
    public let screen: RecordingScreen?
    public let hingeAngle: Double?
    public let physicalOrientation: String?
    public let tableMode: Bool?
    public var contentRect: RecordingContentRect?

    public init(width: Int, height: Int, orientation: String? = nil, screen: RecordingScreen? = nil,
                hingeAngle: Double? = nil, physicalOrientation: String? = nil, tableMode: Bool? = nil,
                contentRect: RecordingContentRect? = nil) {
        self.width = width
        self.height = height
        self.orientation = orientation
        self.screen = screen
        self.hingeAngle = hingeAngle
        self.physicalOrientation = physicalOrientation
        self.tableMode = tableMode
        self.contentRect = contentRect
    }
}

public struct RecordingManifest: Codable, Equatable {
    public struct FirstFrameWallClock: Codable, Equatable {
        public let unixMs: Int64
        public let iso8601: String
    }

    public struct DeviceState: Codable, Equatable {
        /// Milliseconds from the first frame written to recording.mp4.
        public let timeMs: Double
        public let state: RecordingDeviceState

        public init(timeMs: Double, state: RecordingDeviceState) {
            self.timeMs = timeMs
            self.state = state
        }
    }

    public struct Interruption: Codable, Equatable, Sendable {
        public let reason: String
        public let pausedAtSeconds: Double
        public var resumedAtSeconds: Double?

        public init(pausedAtSeconds: Double, resumedAtSeconds: Double? = nil) {
            reason = "simulatorReboot"
            self.pausedAtSeconds = pausedAtSeconds
            self.resumedAtSeconds = resumedAtSeconds
        }
    }

    public let interruptions: [Interruption]?
    public let status: String?
    public let error: String?
    public let firstFrameWallClock: FirstFrameWallClock
    public let width: Int
    public let height: Int
    public let recording: String
    public let deviceStates: [DeviceState]?

    public init(firstFrame: Date, width: Int, height: Int,
                interruptions: [Interruption] = [], error: String? = nil,
                deviceStates: [DeviceState]? = nil) {
        self.interruptions = interruptions.isEmpty ? nil : interruptions
        self.status = error == nil ? nil : "failed"
        self.error = error
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        firstFrameWallClock = FirstFrameWallClock(
            unixMs: Int64((firstFrame.timeIntervalSince1970 * 1_000).rounded()),
            iso8601: formatter.string(from: firstFrame)
        )
        self.width = width
        self.height = height
        recording = "recording.mp4"
        self.deviceStates = deviceStates
    }
}
