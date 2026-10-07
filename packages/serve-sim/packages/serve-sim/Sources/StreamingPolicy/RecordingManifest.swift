import Foundation

/// Screen geometry and pose known when a video frame was submitted.
/// Screen orientation describes the framebuffer; physical orientation describes
/// the Duo device and can differ when an app locks its interface orientation.
public struct RecordingDeviceState: Codable, Equatable {
    public let width: Int
    public let height: Int
    public let orientation: String?
    public let screenId: UInt32?
    public let hingeAngle: Double?
    public let physicalOrientation: String?
    public let tableMode: Bool?

    public init(width: Int, height: Int, orientation: String? = nil, screenId: UInt32? = nil,
                hingeAngle: Double? = nil, physicalOrientation: String? = nil, tableMode: Bool? = nil) {
        self.width = width
        self.height = height
        self.orientation = orientation
        self.screenId = screenId
        self.hingeAngle = hingeAngle
        self.physicalOrientation = physicalOrientation
        self.tableMode = tableMode
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

    public let firstFrameWallClock: FirstFrameWallClock
    public let width: Int
    public let height: Int
    public let recording: String
    public let deviceStates: [DeviceState]?

    public init(firstFrame: Date, width: Int, height: Int, deviceStates: [DeviceState]? = nil) {
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
