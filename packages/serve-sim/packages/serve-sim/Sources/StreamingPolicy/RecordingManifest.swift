import Foundation

public struct RecordingManifest: Codable, Equatable {
    public struct FirstFrameWallClock: Codable, Equatable {
        public let unixMs: Int64
        public let iso8601: String
    }

    public let firstFrameWallClock: FirstFrameWallClock
    public let width: Int
    public let height: Int
    public let recording: String

    public init(firstFrame: Date, width: Int, height: Int) {
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
