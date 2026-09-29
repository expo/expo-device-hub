import XCTest
@testable import StreamingPolicy

final class FramePlanesTests: XCTestCase {
    private let width = 64, rows = 32, bytesPerRow = 80

    /// A plane with padding past `width` in each row, as a pixel buffer has.
    private func plane(seed: UInt8, bytesPerRow: Int? = nil) -> [UInt8] {
        let stride = bytesPerRow ?? self.bytesPerRow
        return (0..<(rows * stride)).map { i in
            i % stride < width ? UInt8(truncatingIfNeeded: (i / stride) &* 7 &+ (i % stride) &* 31 &+ Int(seed)) : 0xEE
        }
    }

    private func equal(_ a: [UInt8], _ b: [UInt8], aStride: Int? = nil, bStride: Int? = nil) -> Bool {
        a.withUnsafeBytes { ra in
            b.withUnsafeBytes { rb in
                FramePlanes.equal(ra.baseAddress!, bytesPerRow: aStride ?? bytesPerRow,
                                  rb.baseAddress!, bytesPerRow: bStride ?? bytesPerRow,
                                  rowBytes: width, rows: rows)
            }
        }
    }

    func testIdenticalFramesMatch() {
        XCTAssertTrue(equal(plane(seed: 7), plane(seed: 7)))
    }

    func testAnyChangedPixelByteCounts() {
        // Every row and column, the odd rows a sparse sample would skip included.
        for (y, x) in [(0, 0), (3, 10), (17, 63), (31, 1)] {
            var changed = plane(seed: 7)
            changed[y * bytesPerRow + x] &+= 1
            XCTAssertFalse(equal(changed, plane(seed: 7)), "row \(y), byte \(x)")
        }
    }

    func testRowPaddingDoesNotCount() {
        var padded = plane(seed: 7)
        padded[4 * bytesPerRow + width + 3] &+= 1
        XCTAssertTrue(equal(padded, plane(seed: 7)))
    }

    func testFramesWithDifferentRowPaddingCompareByPixels() {
        XCTAssertTrue(equal(plane(seed: 7, bytesPerRow: 96), plane(seed: 7), aStride: 96))
        var changed = plane(seed: 7, bytesPerRow: 96)
        changed[5 * 96 + 2] &+= 1
        XCTAssertFalse(equal(changed, plane(seed: 7), aStride: 96))
    }

    func testTightlyPackedPlanesCompareInOnePass() {
        let packed = { (seed: UInt8) in (0..<(self.rows * self.width)).map { UInt8(truncatingIfNeeded: $0 &* 13 &+ Int(seed)) } }
        XCTAssertTrue(equal(packed(3), packed(3), aStride: width, bStride: width))
        XCTAssertFalse(equal(packed(3), packed(4), aStride: width, bStride: width))
    }
}
