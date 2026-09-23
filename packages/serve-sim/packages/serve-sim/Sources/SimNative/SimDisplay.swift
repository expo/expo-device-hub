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
