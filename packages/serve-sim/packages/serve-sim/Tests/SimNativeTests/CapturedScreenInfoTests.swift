import XCTest
import StreamingPolicy
@testable import SimNative

final class CapturedScreenInfoTests: XCTestCase {
    func testRecordingRetainsIntegratedPanelIdentityAndUnpaddedGeometry() {
        for screenID in [UInt32(0), 1, 3] {
            let screen = CapturedScreenInfo(width: 101, height: 103, display: SimDisplayMetadata(
                screenID: screenID, orientation: "landscape_left", chromeIdentifier: nil, screenType: 0
            ))

            XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(
                width: 101, height: 103, orientation: "landscape_left", screenId: screenID
            ))
        }
    }

    func testExternalDisplayKeepsGeometryAndRotationWithoutIntegratedPanelIdentity() {
        for screenType in [UInt64(1), 2, 3] {
            let screen = CapturedScreenInfo(width: 1920, height: 1080, display: SimDisplayMetadata(
                screenID: 2, orientation: "landscape_right", chromeIdentifier: nil, screenType: screenType
            ))

            XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(
                width: 1920, height: 1080, orientation: "landscape_right"
            ))
        }
    }

    func testUnknownDisplayTypeDoesNotClaimIntegratedPanelIdentity() {
        let screen = CapturedScreenInfo(width: 120, height: 240, display: SimDisplayMetadata(
            screenID: 3, orientation: "portrait", chromeIdentifier: nil, screenType: nil
        ))

        XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait"
        ))
    }

    func testMissingDisplayMetadataRetainsOnlyKnownGeometry() {
        let screen = CapturedScreenInfo(width: 120, height: 240, display: nil)

        XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(width: 120, height: 240))
    }
}
