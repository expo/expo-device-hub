import Foundation

/// Whether two frames hold the same pixels, one plane at a time. The WebRTC publisher compares each
/// resized frame with the one it retains: the simulator rewrites its surface without new content,
/// and such a rewrite should not count as a fresh frame. Every pixel byte counts; the padding past
/// `rowBytes` in each row does not.
public enum FramePlanes {
    public static func equal(
        _ a: UnsafeRawPointer, bytesPerRow aStride: Int,
        _ b: UnsafeRawPointer, bytesPerRow bStride: Int,
        rowBytes: Int, rows: Int
    ) -> Bool {
        if aStride == bStride, aStride == rowBytes { return memcmp(a, b, rowBytes * rows) == 0 }
        for y in 0..<rows where memcmp(a + y * aStride, b + y * bStride, rowBytes) != 0 {
            return false
        }
        return true
    }
}
