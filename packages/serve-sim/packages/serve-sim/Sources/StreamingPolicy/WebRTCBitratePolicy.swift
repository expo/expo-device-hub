/// Bitrate range for the sender's encoding parameters.
///
/// `minimumBitsPerSecond` is a floor WebRTC will not send below, so it has to leave the
/// estimator room to back off on a path slower than the target.
public struct WebRTCBitratePolicy: Equatable, Sendable {
    /// Below this the picture is not worth watching, bad link or not.
    public static let absoluteFloorBitsPerSecond = 300_000
    /// An order of magnitude under the target, so the estimator can back off through a whole
    /// bad link rather than one step of it.
    public static let floorFractionOfTarget = 10

    public let minimumBitsPerSecond: Int
    public let maximumBitsPerSecond: Int

    public init(targetBitsPerSecond: Int) {
        let target = max(0, targetBitsPerSecond)
        maximumBitsPerSecond = target
        // A target under the absolute floor is a deliberate request for a small stream.
        minimumBitsPerSecond = min(
            target,
            max(Self.absoluteFloorBitsPerSecond, target / Self.floorFractionOfTarget)
        )
    }
}
