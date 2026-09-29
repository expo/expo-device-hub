/// A sparse fingerprint of a frame's bytes, so the WebRTC publisher can tell a surface rewrite
/// without new content from a new frame. It samples every other row and every fourth byte, with
/// the columns staggered by row so a thin vertical element is still sampled, and hashes the
/// samples with FNV-1a. A change it does not sample leaves the value as it was.
public struct SparseFrameFingerprint: Sendable {
    public private(set) var value: UInt64 = 0xcbf2_9ce4_8422_2325

    public init() {}

    /// Mixes in one plane: `rowBytes` bytes of pixels in each of `rows` rows, `bytesPerRow` apart.
    public mutating func mix(plane base: UnsafeRawPointer, rowBytes: Int, rows: Int, bytesPerRow: Int) {
        for y in stride(from: 0, to: rows, by: 2) {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in stride(from: (y / 2) % 4, to: rowBytes, by: 4) {
                value = (value ^ UInt64(row[x])) &* 0x0000_0100_0000_01b3
            }
        }
    }
}
