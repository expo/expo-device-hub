import XCTest
@testable import StreamingPolicy

final class WebRTCFrameRatePolicyTests: XCTestCase {
    func testConfiguredFrameRateControlsOnlyThePublisherCadence() {
        for configuredFramesPerSecond in [30, 60, 140] {
            let policy = WebRTCFrameRatePolicy(
                configuredFramesPerSecond: configuredFramesPerSecond
            )

            XCTAssertEqual(policy.outputFramesPerSecond, configuredFramesPerSecond)
            XCTAssertEqual(policy.sourceAdapterFramesPerSecond, 1_000)
            XCTAssertNil(policy.senderFramesPerSecond)
        }
    }

    func testSimulatorCapturePollRunsAtSixtyHertz() {
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond, 60)
        XCTAssertEqual(SimulatorCapturePollPolicy.intervalNanoseconds, 16_666_667)
    }

    func testClampsOnlyThePublisherCadenceToTheSupportedRange() {
        XCTAssertEqual(
            WebRTCFrameRatePolicy(configuredFramesPerSecond: 0).outputFramesPerSecond,
            1
        )
        XCTAssertEqual(
            WebRTCFrameRatePolicy(configuredFramesPerSecond: 240).outputFramesPerSecond,
            140
        )
    }
}
