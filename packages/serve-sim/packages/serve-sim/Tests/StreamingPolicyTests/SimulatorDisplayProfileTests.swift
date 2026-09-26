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
        #expect(profile.nativeRotations == [1: 0, 3: 270])
    }

    @Test("iPhone and iPad stay on the legacy path despite their virtual outputs", arguments: [0, 270])
    func singlePanel(rotation: Int) {
        let profile = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 1, "nativeRotation": rotation],
            ["displayType": "tvOut", "screenID": 2],
            ["displayType": "carPlay", "screenID": 3],
            ["displayType": "scene", "screenID": 4],
        ])
        #expect(!profile.isFoldable)
        #expect(profile.integratedDisplayCount == 1)
    }

    // Regression guard for Duo reboot recovery: the reset must not depend on
    // how many framebuffer panels are visible when capture starts.
    @Test("a foldable's main capture resets boot-bound state; panel feeds and single panels do not")
    func bootBoundReset() {
        let duo = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 1],
            ["displayType": "integrated", "screenID": 3],
        ])
        let iPhone = SimulatorDisplayProfile(displays: [
            ["displayType": "integrated", "screenID": 1],
        ])
        #expect(duo.resetsBootBoundStateOnCapture(fixedScreenID: nil))
        #expect(!duo.resetsBootBoundStateOnCapture(fixedScreenID: 3))
        #expect(!iPhone.resetsBootBoundStateOnCapture(fixedScreenID: nil))
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

    @Test("missing profiles and duplicate descriptors do not opt into CoreDevice")
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
    }
}
