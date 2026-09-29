import XCTest
@testable import StreamingPolicy

final class SparseFrameFingerprintTests: XCTestCase {
    private let width = 64, rows = 32, bytesPerRow = 80

    /// A plane with padding past `width` in each row, as a pixel buffer has.
    private func plane(seed: UInt8) -> [UInt8] {
        (0..<(rows * bytesPerRow)).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ Int(seed)) }
    }

    private func fingerprint(_ planes: [UInt8]...) -> UInt64 {
        var fingerprint = SparseFrameFingerprint()
        for bytes in planes {
            bytes.withUnsafeBytes { raw in
                fingerprint.mix(plane: raw.baseAddress!, rowBytes: width, rows: rows, bytesPerRow: bytesPerRow)
            }
        }
        return fingerprint.value
    }

    func testIdenticalFramesMatch() {
        XCTAssertEqual(fingerprint(plane(seed: 7)), fingerprint(plane(seed: 7)))
    }

    func testAOnePixelWideVerticalLineChangesIt() {
        // Every column is sampled in one of four sampled rows, so a line as tall as 8 rows counts.
        for column in 0..<4 {
            var changed = plane(seed: 7)
            for y in 0..<rows { changed[y * bytesPerRow + column] &+= 1 }
            XCTAssertNotEqual(fingerprint(changed), fingerprint(plane(seed: 7)), "column \(column)")
        }
    }

    func testChangesItDoesNotSampleLeaveItAsItWas() {
        // Odd rows and row padding are never sampled; the publisher still sends the newest frame.
        var changed = plane(seed: 7)
        changed[1 * bytesPerRow + 10] &+= 1
        changed[4 * bytesPerRow + width + 3] &+= 1
        XCTAssertEqual(fingerprint(changed), fingerprint(plane(seed: 7)))
    }

    func testTheSecondPlaneCounts() {
        // A color-only change in a 4:2:0 frame lands in the chroma plane.
        var chroma = plane(seed: 9)
        chroma[0] &+= 1
        XCTAssertNotEqual(fingerprint(plane(seed: 7), chroma), fingerprint(plane(seed: 7), plane(seed: 9)))
    }
}
