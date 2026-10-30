import Foundation
import StreamingPolicy

/// Metadata for the same SimScreen descriptor that supplies a framebuffer.
/// Read through Objective-C messages: CoreSimulator's ROCK proxies forward
/// these selectors but do not consistently support valueForKey:.
struct SimDisplayMetadata: Equatable {
    let screenID: UInt32
    let orientation: String?
    let chromeIdentifier: String?
    let screenType: UInt64?

    var integratedScreenID: UInt32? { screenType == 0 ? screenID : nil }

    /// Legacy phone/pad profiles declare geometry instead of screen IDs.
    static func legacyScreenSize(capabilities profile: [String: Any]) -> Dimensions? {
        let capabilities: [String: Any]
        if let nested = profile["capabilities"] {
            guard let nested = nested as? [String: Any] else { return nil }
            capabilities = nested
        } else {
            capabilities = profile
        }
        guard capabilities["displays"] == nil,
              let idiom = capabilities["idiom"] as? String, ["phone", "pad"].contains(idiom),
              let dimensions = capabilities["ScreenDimensionsCapability"] as? [String: Any],
              let rawWidth = dimensions["main-screen-width"] as? NSNumber,
              CFGetTypeID(rawWidth) != CFBooleanGetTypeID(),
              let width = Int(exactly: rawWidth.doubleValue), width > 0,
              let rawHeight = dimensions["main-screen-height"] as? NSNumber,
              CFGetTypeID(rawHeight) != CFBooleanGetTypeID(),
              let height = Int(exactly: rawHeight.doubleValue), height > 0 else { return nil }
        return Dimensions(width: width, height: height)
    }

    static func legacyScreenSize(from device: NSObject) -> Dimensions? {
        guard let profile = deviceTypeCapabilities(from: device) else { return nil }
        return legacyScreenSize(capabilities: profile)
    }

    func recordingScreen(in profile: SimulatorDisplayProfile) -> RecordingScreen? {
        guard let integratedScreenID else { return nil }
        return profile.recordingScreen(screenID: integratedScreenID, chromeIdentifier: chromeIdentifier)
    }

    func applying(_ current: CoreDeviceDisplayState?) -> Self {
        guard let current, current.screenID == screenID,
              let orientation = current.orientation else { return self }
        return Self(
            screenID: screenID, orientation: orientation,
            chromeIdentifier: chromeIdentifier, screenType: screenType
        )
    }

    static func read(from descriptor: NSObject) -> Self? {
        let selector = NSSelectorFromString("screenProperties")
        guard descriptor.responds(to: selector),
              let properties = descriptor.perform(selector)?.takeUnretainedValue() as? NSObject
        else { return nil }
        return read(properties: properties)
    }

    static func read(properties: NSObject) -> Self? {
        let object: AnyObject = properties
        guard let screenID = object.simScreenID?() else { return nil }
        return Self(
            screenID: screenID,
            orientation: (object.simUIOrientation?()).flatMap(SimulatorScreenOrientation.name),
            chromeIdentifier: object.simChromeIdentifier?(),
            screenType: object.simScreenType?()
        )
    }
}

/// Getter signatures from the local CoreSimDeviceIO SimScreenProperties
/// protocol. Optional dynamic dispatch keeps older Xcode
/// releases that lack the screen API on the existing framebuffer path.
@objc private protocol SimDisplayPropertiesAccess {
    @objc(screenID) func simScreenID() -> UInt32
    @objc(uiOrientation) func simUIOrientation() -> UInt32
    @objc(chromeIdentifier) func simChromeIdentifier() -> String?
    @objc(screenType) func simScreenType() -> UInt64
}

extension SimulatorDisplayProfile {
    /// Reads the static display profile from a SimDevice's device type.
    static func read(from device: NSObject) -> SimulatorDisplayProfile {
        guard let profile = deviceTypeCapabilities(from: device),
              let capabilities = profile["capabilities"] as? [String: Any],
              let displays = capabilities["displays"] as? [[String: Any]]
        else { return SimulatorDisplayProfile() }
        return SimulatorDisplayProfile(displays: displays)
    }
}

private func deviceTypeCapabilities(from device: NSObject) -> [String: Any]? {
    let typeSelector = NSSelectorFromString("deviceType")
    let capabilitiesSelector = NSSelectorFromString("capabilities")
    guard device.responds(to: typeSelector),
          let type = device.perform(typeSelector)?.takeUnretainedValue() as? NSObject,
          type.responds(to: capabilitiesSelector) else { return nil }
    return type.perform(capabilitiesSelector)?.takeUnretainedValue() as? [String: Any]
}
