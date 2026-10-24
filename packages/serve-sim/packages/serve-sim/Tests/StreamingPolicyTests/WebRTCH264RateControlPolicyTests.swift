import XCTest
@testable import StreamingPolicy

final class WebRTCH264RateControlPolicyTests: XCTestCase {
    func testRootFeedsKeepLowLatencyEvenOnAVirtualizedHost() {
        for id in [nil, "paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc",
                   "com.apple.videotoolbox.videoencoder.ave.avc"] {
            XCTAssertTrue(WebRTCH264RateControlPolicy.prefersLowLatency(
                fixedPanel: false, probeEncoderID: id
            ))
        }
    }

    func testParavirtualizedFixedPanelRequestsDefault() {
        XCTAssertFalse(WebRTCH264RateControlPolicy.prefersLowLatency(
            fixedPanel: true,
            probeEncoderID: "paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc"
        ))
    }

    func testUnknownAndNonVirtualFixedPanelsKeepTheExistingRequest() {
        for id in [nil, "", "paravirtualized", "com.apple.videotoolbox.videoencoder.ave.avc",
                   "com.apple.videotoolbox.videoencoder.h264.rtvc"] {
            XCTAssertTrue(WebRTCH264RateControlPolicy.prefersLowLatency(
                fixedPanel: true, probeEncoderID: id
            ))
        }
    }
}
