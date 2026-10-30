import Foundation
import XCTest
@testable import StreamingPolicy

final class H264SPSReorderLimitTests: XCTestCase {
    /// SPSs captured from VideoToolbox avcC descriptions on Apple silicon, High profile level 5.1.
    /// Low-latency rate control: VUI with a bitstream restriction and max_num_reorder_frames = 0.
    private let lowLatencySPS = Data([39, 100, 0, 51, 172, 19, 20, 60, 4, 192, 20, 158, 106, 154,
                                      129, 1, 1, 3, 194, 1, 8, 248])
    /// Default rate control: no VUI, max_num_ref_frames = 1.
    private let defaultSPS = Data([39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164])
    /// `defaultSPS` with the added VUI, as t3code's viewer-side rewrite produces and Chromium
    /// accepted: bitstream restriction [2, 1, 16, 16, 0, 1].
    private let restrictedSPS = Data([39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208,
                                      68, 35, 80])

    func testAddsZeroReorderVUIToDefaultModeSPS() {
        XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: defaultSPS), restrictedSPS)
    }

    func testKeepsExistingVUI() {
        XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: lowLatencySPS), lowLatencySPS)
        XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: restrictedSPS), restrictedSPS)
    }

    func testLeavesTruncatedSPSUnchanged() {
        for count in 0..<defaultSPS.count {
            let prefix = defaultSPS.prefix(count)
            XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: prefix), prefix, "prefix \(count)")
        }
    }

    func testLeavesUnsupportedLayoutsUnchanged() {
        var notSPS = defaultSPS
        notSPS[0] = 0x28 // PPS
        XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: notSPS), notSPS)
        var high444 = defaultSPS
        high444[1] = 244
        XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: high444), high444)
        let trailingData = defaultSPS + Data([0x80])
        XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: trailingData), trailingData)
        let badEscape = Data([39, 100, 0, 51, 0, 0, 3, 9])
        XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: badEscape), badEscape)
    }

    /// Mutated captures never crash, stay bounded, and a second pass changes nothing.
    func testMutatedInputsAreBoundedAndIdempotent() {
        var seed: UInt64 = 0x9E37_79B9_7F4A_7C15
        func next() -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int(seed >> 33)
        }
        for _ in 0..<20_000 {
            var bytes = [UInt8](next() % 2 == 0 ? defaultSPS : lowLatencySPS)
            for _ in 0...(next() % 3) {
                switch next() % 3 {
                case 0: bytes[next() % bytes.count] = UInt8(next() % 256)
                case 1: bytes.insert(UInt8(next() % 256), at: next() % (bytes.count + 1))
                default: if bytes.count > 1 { bytes.remove(at: next() % bytes.count) }
                }
            }
            let input = Data(bytes)
            let once = H264SPSReorderLimit.addingZeroReorder(to: input)
            XCTAssertLessThanOrEqual(once.count, input.count + 16)
            XCTAssertEqual(H264SPSReorderLimit.addingZeroReorder(to: once), once)
        }
    }
}
