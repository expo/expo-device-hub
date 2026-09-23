import Testing

@testable import StreamingPolicy

@Suite("SimulatorScreenOrientation")
struct SimulatorScreenOrientationTests {
    @Test("maps device-orientation values to Device Hub's vendor control values")
    func vendorControlValues() {
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 1) == "portrait")
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 2) == "pud")
        // Device orientations have the opposite landscape numbering from
        // SimScreenUIOrientation, so app landscape_left sends device value 4.
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 3) == "landscape-left")
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 4) == "landscape-right")
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 0) == nil)
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: UInt32.max) == nil)
    }

    @Test("rotates the Duo inner panel to the requested framebuffer orientation")
    func innerPanelVendorControlValues() {
        // The inner display is mounted at 270 degrees in Apple's profile.
        // Sending a physical portrait pose leaves its framebuffer at rot90.
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 1, nativeRotation: 270) == "landscape-left")
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 4, nativeRotation: 270) == "portrait")
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 2, nativeRotation: 270) == "landscape-right")
        #expect(SimulatorScreenOrientation.vendorControlValue(forDeviceOrientation: 3, nativeRotation: 270) == "pud")
    }

    @Test("reports the simulator screen's actual orientation, including Duo's landscape panel")
    func screenOrientations() {
        #expect(SimulatorScreenOrientation.name(for: 1) == "portrait")
        #expect(SimulatorScreenOrientation.name(for: 2) == "portrait_upside_down")
        #expect(SimulatorScreenOrientation.name(for: 3) == "landscape_left")
        #expect(SimulatorScreenOrientation.name(for: 4) == "landscape_right")
    }

    @Test("does not replace a known orientation with an ambiguous or future screen value")
    func unknownOrientation() {
        #expect(SimulatorScreenOrientation.name(for: 0) == nil)
        #expect(SimulatorScreenOrientation.name(for: UInt32.max) == nil)
    }

    @Test("maps authoritative CoreDevice display rotations and ignores unknown values")
    func coreDeviceRotation() {
        #expect(SimulatorScreenOrientation.name(forRotation: "rot0") == "portrait")
        #expect(SimulatorScreenOrientation.name(forRotation: "rot90") == "landscape_left")
        #expect(SimulatorScreenOrientation.name(forRotation: "rot180") == "portrait_upside_down")
        #expect(SimulatorScreenOrientation.name(forRotation: "rot270") == "landscape_right")
        #expect(SimulatorScreenOrientation.name(forRotation: "unknown") == nil)
    }
}
