import Testing

@testable import StreamingPolicy

@Suite("SimulatorDisplayProfile")
struct SimulatorDisplayProfileTests {
    @Test("Duo uses the foldable path and retains each panel's mounting rotation")
    func duoProfile() {
        let profile = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 1, "nativeRotation": 0],
            ["displayType": "integrated", "screenID": 3, "nativeRotation": 270],
            ["displayType": "tvOut", "screenID": 2],
            ["displayType": "carPlay", "screenID": 4],
            ["displayType": "scene", "screenID": 5],
        ])
        #expect(profile.isFoldable)
        #expect(profile.singleIntegratedScreenID == nil)
        #expect(profile.nativeRotations == [1: 0, 3: 270])
    }

    @Test("iPhone and iPad remain single-panel devices despite their virtual outputs", arguments: [0, 270])
    func singlePanel(rotation: Int) {
        let profile = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 1, "nativeRotation": rotation],
            ["displayType": "tvOut", "screenID": 2],
            ["displayType": "carPlay", "screenID": 3],
            ["displayType": "scene", "screenID": 4],
        ])
        #expect(!profile.isFoldable)
        #expect(profile.integratedDisplayCount == 1)
        #expect(profile.singleIntegratedScreenID == 1)
    }

    @Test("missing optional rotation does not disable the foldable guard")
    func missingRotation() {
        let profile = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 1],
            ["displayType": "integrated", "screenID": 3],
        ])
        #expect(profile.isFoldable)
        #expect(profile.nativeRotations.isEmpty)
    }

    @Test("missing profiles and duplicate descriptors do not identify a foldable")
    func missingOrDuplicateDisplays() {
        #expect(!SimulatorDisplayProfile().isFoldable)
        let display: [String: Any] = ["displayType": "integrated", "screenID": 1]
        #expect(!SimulatorDisplayProfile(displays: [display, display]).isFoldable)
    }

    @Test("the guard currently requires exactly two integrated displays")
    func threePanels() {
        let profile = SimulatorDisplayProfile(displays: (1...3).map {
            ["displayType": "integrated", "screenID": $0]
        })
        #expect(!profile.isFoldable)
        #expect(profile.singleIntegratedScreenID == nil)
    }
    @Test("a sole integrated panel uses its actual ID without requiring rotation metadata")
    func singlePanelIdentity() {
        let profile = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 19],
            ["displayType": "tvOut", "screenID": 1],
        ])
        #expect(profile.singleIntegratedScreenID == 19)
        #expect(SimulatorDisplayProfile().singleIntegratedScreenID == nil)
    }
    @Test("recording panels follow unique DeviceKit identities rather than numeric ID conventions")
    func recordingPanelIdentity() {
        let profile = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 19, "chromeIdentifier": "com.apple.dt.devicekit.chrome.phone15"],
            ["displayType": "integrated", "screenID": 7, "chromeIdentifier": "phone14"],
            ["displayType": "tvOut", "screenID": 2, "chromeIdentifier": "phone15"],
        ])
        #expect(profile.recordingScreen(screenID: 19, chromeIdentifier: "phone15") == .outer)
        #expect(profile.recordingScreen(screenID: 7, chromeIdentifier: "com.apple.dt.devicekit.chrome.phone14") == .inner)
        #expect(profile.recordingScreen(screenID: 19, chromeIdentifier: nil) == .outer)
        #expect(profile.recordingScreen(screenID: 7, chromeIdentifier: "phone15") == nil)
        #expect(profile.recordingScreen(screenID: 7, chromeIdentifier: "unknown") == nil)
        #expect(profile.recordingScreen(screenID: 2, chromeIdentifier: "phone15") == nil)
    }

    @Test("ordinary, unknown and ambiguous profiles omit semantic recording panels")
    func ambiguousRecordingPanels() {
        let inner: [String: Any] = ["displayType": "integrated", "screenID": 7, "chromeIdentifier": "phone14"]
        let outer: [String: Any] = ["displayType": "integrated", "screenID": 19, "chromeIdentifier": "phone15"]
        let unknown: [String: Any] = ["displayType": "integrated", "screenID": 19, "chromeIdentifier": "phone16"]
        let sameRole: [String: Any] = ["displayType": "integrated", "screenID": 19, "chromeIdentifier": "phone14"]
        let sharedID: [String: Any] = ["displayType": "integrated", "screenID": 7, "chromeIdentifier": "phone15"]
        for displays in [[], [inner], [inner, unknown], [inner, sameRole], [inner, sharedID],
                         [inner, outer, inner]] {
            let profile = SimulatorDisplayProfile(displays: displays)
            #expect(profile.recordingScreen(screenID: 7, chromeIdentifier: "phone14") == nil)
            #expect(profile.recordingScreen(screenID: 19, chromeIdentifier: "phone15") == nil)
        }
    }

}
