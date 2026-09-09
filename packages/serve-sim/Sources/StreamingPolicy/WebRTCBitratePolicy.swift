public struct WebRTCBitratePolicy: Equatable, Sendable {
    public let minimumBitsPerSecond: Int
    public let maximumBitsPerSecond: Int

    public init(targetBitsPerSecond: Int) {
        minimumBitsPerSecond = targetBitsPerSecond * 9 / 10
        maximumBitsPerSecond = targetBitsPerSecond
    }
}
