import Testing

@testable import StreamingPolicy

@Suite("PhysicalScreenPolicy")
struct PhysicalScreenPolicyTests {
    private func display(_ id: UInt32, active: Bool? = nil, primary: Bool = false,
                         integrated: Bool = false) -> PhysicalDisplayCandidate {
        PhysicalDisplayCandidate(displayID: id, isActive: active, isPrimary: primary, isIntegrated: integrated,
                                 nativeWidth: 1170, nativeHeight: 2532)
    }

    @Test("chooses the only active display")
    func onlyActiveDisplay() {
        let chosen = PhysicalScreenPolicy.chooseDisplay([
            display(1, active: false, primary: true, integrated: true),
            display(2, active: true),
            display(3, active: false),
        ])
        #expect(chosen?.displayID == 2)
    }

    @Test("chooses the primary display when no display or several report active")
    func primaryWithoutOneActive() {
        let inactive = [display(1, primary: true, integrated: true), display(2), display(3), display(4)]
        #expect(PhysicalScreenPolicy.chooseDisplay(inactive)?.displayID == 1)
        let twoActive = [display(2, active: true), display(1, active: true, primary: true, integrated: true)]
        #expect(PhysicalScreenPolicy.chooseDisplay(twoActive)?.displayID == 1)
    }

    @Test("falls back to an integrated display, then to none")
    func integratedFallback() {
        #expect(PhysicalScreenPolicy.chooseDisplay([display(2), display(5, integrated: true)])?.displayID == 5)
        #expect(PhysicalScreenPolicy.chooseDisplay([display(2), display(3)]) == nil)
        #expect(PhysicalScreenPolicy.chooseDisplay([]) == nil)
    }

    @Test("crops the encoder padding to the native screen in portrait and landscape")
    func cropsPadding() {
        #expect(PhysicalScreenPolicy.contentSize(encodedWidth: 1184, encodedHeight: 2576, nativeWidth: 1170, nativeHeight: 2532)
            == PhysicalContentSize(width: 1170, height: 2532))
        #expect(PhysicalScreenPolicy.contentSize(encodedWidth: 2576, encodedHeight: 1184, nativeWidth: 1170, nativeHeight: 2532)
            == PhysicalContentSize(width: 2532, height: 1170))
        #expect(PhysicalScreenPolicy.contentSize(encodedWidth: 1216, encodedHeight: 2656, nativeWidth: 1206, nativeHeight: 2622)
            == PhysicalContentSize(width: 1206, height: 2622))
    }

    @Test("scales the native size down when the stream is smaller than the screen")
    func scalesDownLargerScreens() {
        #expect(PhysicalScreenPolicy.contentSize(encodedWidth: 2736, encodedHeight: 2064, nativeWidth: 2752, nativeHeight: 2064)
            == PhysicalContentSize(width: 2736, height: 2052))
    }

    @Test("keeps the encoded size without a usable native size")
    func encodedFallback() {
        let encoded = PhysicalContentSize(width: 1184, height: 2576)
        #expect(PhysicalScreenPolicy.contentSize(encodedWidth: 1184, encodedHeight: 2576, nativeWidth: nil, nativeHeight: nil) == encoded)
        #expect(PhysicalScreenPolicy.contentSize(encodedWidth: 1184, encodedHeight: 2576, nativeWidth: .nan, nativeHeight: 0) == encoded)
        #expect(PhysicalScreenPolicy.contentSize(encodedWidth: 1184, encodedHeight: 2576, nativeWidth: 0, nativeHeight: 2532) == encoded)
    }

    @Test("requires CoreDevice 642 or later with every symbol present")
    func hostSupport() {
        #expect(PhysicalDeviceSupport.host(coreDeviceVersion: "651.32", symbolsAvailable: true) == .supported)
        #expect(PhysicalDeviceSupport.host(coreDeviceVersion: "642", symbolsAvailable: true) == .supported)
        #expect(PhysicalDeviceSupport.host(coreDeviceVersion: "641.9", symbolsAvailable: true) == .needsXcode27)
        #expect(PhysicalDeviceSupport.host(coreDeviceVersion: "651.32", symbolsAvailable: false) == .needsXcode27)
        #expect(PhysicalDeviceSupport.host(coreDeviceVersion: nil, symbolsAvailable: true) == .needsXcode27)
        #expect(PhysicalDeviceSupport.needsXcode27.message == "needs Xcode 27")
    }

    @Test("requires iOS 27 on the phone")
    func deviceSupport() {
        #expect(PhysicalDeviceSupport.device(osVersion: "27.2.1") == .supported)
        #expect(PhysicalDeviceSupport.device(osVersion: "28.0") == .supported)
        #expect(PhysicalDeviceSupport.device(osVersion: "26.4") == .needsIOS27)
        #expect(PhysicalDeviceSupport.device(osVersion: nil) == .needsIOS27)
        #expect(PhysicalDeviceSupport.needsIOS27.message == "needs iOS 27")
        #expect(PhysicalDeviceSupport.needsIOS27.rawValue == "needs-ios-27")
    }

    @Test("matches a CoreDevice identifier or a hardware UDID, ignoring case")
    func identity() {
        let identifier = "0BC25F62-CB38-5086-B4EE-CE206F4DED0B"
        let udid = "00008101-0016603236F0801E"
        #expect(CoreDeviceIdentity.matches(identifier, identifier: identifier, hardwareUDID: udid))
        #expect(CoreDeviceIdentity.matches(udid, identifier: identifier, hardwareUDID: udid))
        #expect(CoreDeviceIdentity.matches(udid.lowercased(), identifier: identifier, hardwareUDID: udid))
        #expect(CoreDeviceIdentity.matches(identifier.lowercased(), identifier: identifier, hardwareUDID: nil))
        #expect(!CoreDeviceIdentity.matches(udid, identifier: identifier, hardwareUDID: nil))
        #expect(!CoreDeviceIdentity.matches("", identifier: identifier, hardwareUDID: ""))
        #expect(!CoreDeviceIdentity.matches("00008101-0000000000000000", identifier: identifier, hardwareUDID: udid))
    }
}
