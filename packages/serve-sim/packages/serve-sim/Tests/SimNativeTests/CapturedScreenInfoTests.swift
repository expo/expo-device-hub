import XCTest
import StreamingPolicy
@testable import SimNative

final class CapturedScreenInfoTests: XCTestCase {
    private let profile = SimulatorDisplayProfile(displays: [
        ["displayType": "integrated", "screenID": 7, "chromeIdentifier": "phone14"],
        ["displayType": "integrated", "screenID": 19, "chromeIdentifier": "phone15"],
    ])

    func testRecordingRetainsSemanticPanelIdentityAndUnpaddedGeometry() {
        for (id, chrome, panel) in [(UInt32(7), "phone14", RecordingScreen.inner), (19, "phone15", .outer)] {
            let screen = CapturedScreenInfo(width: 101, height: 103, display: SimDisplayMetadata(
                screenID: id, orientation: "landscape_left", chromeIdentifier: chrome, screenType: 0
            ), displayProfile: profile)
            XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(
                width: 101, height: 103, orientation: "landscape_left", screen: panel
            ))
            XCTAssertEqual(screen.display?.integratedScreenID, id)
        }
    }

    func testRecordingUsesProfileIdentityWhenCapturedChromeIsMissingButOmitsConflicts() {
        for (chrome, panel) in [(nil, RecordingScreen.inner as RecordingScreen?), ("phone15", nil), ("unknown", nil)] {
            let screen = CapturedScreenInfo(width: 120, height: 240, display: SimDisplayMetadata(
                screenID: 7, orientation: "portrait", chromeIdentifier: chrome, screenType: 0
            ), displayProfile: profile)
            XCTAssertEqual(screen.recordingDeviceState.screen, panel)
        }
    }

    func testOrdinaryDisplayDoesNotClaimSemanticPanelFromChromeAlone() {
        let screen = CapturedScreenInfo(width: 120, height: 240, display: SimDisplayMetadata(
            screenID: 7, orientation: "portrait", chromeIdentifier: "phone14", screenType: 0
        ))
        XCTAssertNil(screen.recordingDeviceState.screen)
        XCTAssertEqual(screen.display?.integratedScreenID, 7)
    }

    func testExternalDisplayKeepsGeometryAndRotationWithoutIntegratedPanelIdentity() {
        for screenType in [UInt64(1), 2, 3] {
            let screen = CapturedScreenInfo(width: 1920, height: 1080, display: SimDisplayMetadata(
                screenID: 19, orientation: "landscape_right", chromeIdentifier: "phone15", screenType: screenType
            ), displayProfile: profile)

            XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(
                width: 1920, height: 1080, orientation: "landscape_right"
            ))
        }
    }

    func testUnknownDisplayTypeDoesNotClaimIntegratedPanelIdentity() {
        let screen = CapturedScreenInfo(width: 120, height: 240, display: SimDisplayMetadata(
            screenID: 7, orientation: "portrait", chromeIdentifier: "phone14", screenType: nil
        ), displayProfile: profile)

        XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait"
        ))
    }

    func testMissingDisplayMetadataRetainsOnlyKnownGeometry() {
        let screen = CapturedScreenInfo(width: 120, height: 240, display: nil)

        XCTAssertEqual(screen.recordingDeviceState, RecordingDeviceState(width: 120, height: 240))
    }
}
