import Foundation

public struct RecordingManifest: Codable, Equatable {
    public struct FirstFrameWallClock: Codable, Equatable {
        public let unixMs: Int64
        public let iso8601: String
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

    public init(firstFrame: Date, width: Int, height: Int, interruptions: [Interruption] = [], error: String? = nil) {
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
    }
}
