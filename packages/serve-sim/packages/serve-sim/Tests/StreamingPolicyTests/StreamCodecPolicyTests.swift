import XCTest
@testable import StreamingPolicy

final class StreamCodecPolicyTests: XCTestCase {
    func testIsH264IsCaseInsensitive() {
        XCTAssertTrue(StreamCodecPolicy.isH264("H264"))
        XCTAssertTrue(StreamCodecPolicy.isH264("h264"))
        XCTAssertFalse(StreamCodecPolicy.isH264("VP8"))
        XCTAssertFalse(StreamCodecPolicy.isH264(""))
    }

    /// Retransmission and error correction share the negotiated list with the media codec,
    /// so a positional read can hand the clamp a name that is not a codec at all.
    func testPicksTheMediaCodecPastAuxiliaryEntries() {
        XCTAssertEqual(StreamCodecPolicy.mediaCodecName(from: ["rtx", "H264"]), "H264")
        XCTAssertEqual(StreamCodecPolicy.mediaCodecName(from: ["red", "ulpfec", "VP8"]), "VP8")
        XCTAssertEqual(StreamCodecPolicy.mediaCodecName(from: ["RTX", "H264"]), "H264")
        XCTAssertEqual(StreamCodecPolicy.mediaCodecName(from: ["H264", "rtx"]), "H264")
        XCTAssertNil(StreamCodecPolicy.mediaCodecName(from: ["rtx", "red"]))
        XCTAssertNil(StreamCodecPolicy.mediaCodecName(from: []))
    }
}
