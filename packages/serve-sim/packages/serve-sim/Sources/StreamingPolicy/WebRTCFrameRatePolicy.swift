/// Cadence for supplemental IOSurface seed polling. SimulatorKit callbacks
/// still deliver prompt changes between polls, so this is not a capture-rate
/// ceiling.
public enum SimulatorCapturePollPolicy {
    public static let pollsPerSecond = 60
    public static let intervalNanoseconds: Int64 = 16_666_667

    public static func intervalNanoseconds(forFixedPanel fixedPanel: Bool) -> Int64 {
        fixedPanel ? 8_333_333 : intervalNanoseconds
    }
}

public struct WebRTCFrameRatePolicy: Equatable, Sendable {
    public static let maximumOutputFramesPerSecond = 140
    public static let unthrottledSourceAdapterFramesPerSecond = 1_000

    public let outputFramesPerSecond: Int

    public init(configuredFramesPerSecond: Int) {
        outputFramesPerSecond = max(
            1,
            min(Self.maximumOutputFramesPerSecond, configuredFramesPerSecond)
        )
    }

    public var sourceAdapterFramesPerSecond: Int {
        Self.unthrottledSourceAdapterFramesPerSecond
    }

    public var senderFramesPerSecond: Int? {
        nil
    }
}
