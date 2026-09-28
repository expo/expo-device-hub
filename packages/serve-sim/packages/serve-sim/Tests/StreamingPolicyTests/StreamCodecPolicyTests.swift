import XCTest
@testable import StreamingPolicy

final class StreamCodecPolicyTests: XCTestCase {
    func testIsH264IsCaseInsensitive() {
        XCTAssertTrue(StreamCodecPolicy.isH264("H264"))
        XCTAssertTrue(StreamCodecPolicy.isH264("h264"))
        XCTAssertFalse(StreamCodecPolicy.isH264("VP8"))
        XCTAssertFalse(StreamCodecPolicy.isH264(""))
    }

    func testDominantPrefersH264SoOneSoftwareSessionCannotMaskIt() {
        XCTAssertEqual(StreamCodecPolicy.dominant(["VP8", "H264"]), "H264")
        XCTAssertEqual(StreamCodecPolicy.dominant(["h264", "VP8"]), "h264")
        XCTAssertEqual(StreamCodecPolicy.dominant(["VP8", "VP9"]), "VP8")
        XCTAssertEqual(StreamCodecPolicy.dominant(["", "VP8"]), "VP8")
        XCTAssertNil(StreamCodecPolicy.dominant([]))
        XCTAssertNil(StreamCodecPolicy.dominant(["", ""]))
    }

    func testCodecNameFromMimeType() {
        XCTAssertEqual(StreamCodecPolicy.codecName(fromMimeType: "video/H264"), "H264")
        XCTAssertEqual(StreamCodecPolicy.codecName(fromMimeType: "video/VP8"), "VP8")
        XCTAssertNil(StreamCodecPolicy.codecName(fromMimeType: "video/"))
        XCTAssertNil(StreamCodecPolicy.codecName(fromMimeType: ""))
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

    func testReadsFirstMediaCodecFromActiveVideoAnswer() {
        let answer = """
        m=audio 9 UDP/TLS/RTP/SAVPF 111
        a=rtpmap:111 opus/48000/2
        m=video 0 UDP/TLS/RTP/SAVPF 102
        a=rtpmap:102 H264/90000
        m=video 9 UDP/TLS/RTP/SAVPF 97 96 102
        a=rtpmap:97 rtx/90000
        a=rtpmap:96 VP8/90000
        a=rtpmap:102 H264/90000
        """
        XCTAssertEqual(StreamCodecPolicy.firstVideoCodecName(in: answer), "VP8")
        XCTAssertEqual(StreamCodecPolicy.firstVideoCodecName(
            in: answer.replacingOccurrences(of: "97 96 102", with: "102 97 96")
        ), "H264")
    }
}
