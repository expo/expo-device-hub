import XCTest
@testable import StreamingPolicy

final class WebRTCEncoderIdentityPolicyTests: XCTestCase {
    func testDescribesNothingWithoutALiveCodec() {
        XCTAssertEqual(
            WebRTCEncoderIdentityPolicy.identity(
                liveCodecs: [], h264EncoderID: "vt", h264UsesHardware: true, h264Probed: true
            ),
            .init(id: nil, hardware: nil, codec: nil, probe: false)
        )
    }

    func testCallsVP8SoftwareWithoutAProbe() {
        XCTAssertEqual(
            WebRTCEncoderIdentityPolicy.identity(
                liveCodecs: ["VP8"], h264EncoderID: "vt", h264UsesHardware: true, h264Probed: true
            ),
            .init(id: nil, hardware: false, codec: "VP8", probe: false)
        )
    }

    func testReportsTheProbeForH264WhenItRan() {
        XCTAssertEqual(
            WebRTCEncoderIdentityPolicy.identity(
                liveCodecs: ["H264"], h264EncoderID: "vt", h264UsesHardware: true, h264Probed: true
            ),
            .init(id: "vt", hardware: true, codec: "H264", probe: true)
        )
    }

    func testDescribesNothingWhenH264WasForcedWithoutAProbe() {
        XCTAssertEqual(
            WebRTCEncoderIdentityPolicy.identity(
                liveCodecs: ["H264"], h264EncoderID: nil, h264UsesHardware: nil, h264Probed: false
            ),
            .init(id: nil, hardware: nil, codec: nil, probe: false)
        )
    }
}
