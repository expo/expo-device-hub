/// The size the framebuffer is snapshotted at, so the capture does not move the whole
/// screen through the GPU only to shrink it a step later.
public struct SnapshotSizePolicy: Equatable, Sendable {
    public let width: Int
    public let height: Int

    /// 4:2:0 snapshots require even dimensions, including unscaled frames.
    /// A zero or negative limit disables downscaling, not encoder alignment.
    public init(width: Int, height: Int, maxDimension: Int) {
        let longest = max(width, height)
        if maxDimension > 0, longest > maxDimension, width > 0, height > 0 {
            let scale = Double(maxDimension) / Double(longest)
            self.width = SnapshotSizePolicy.even(Double(width) * scale)
            self.height = SnapshotSizePolicy.even(Double(height) * scale)
            return
        }
        self.width = SnapshotSizePolicy.even(Double(width))
        self.height = SnapshotSizePolicy.even(Double(height))
    }

    private static func even(_ value: Double) -> Int {
        max(2, Int(value.rounded()) & ~1)
    }
}
