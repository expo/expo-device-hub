import CoreDeviceShim
import Foundation
import XCTest
@testable import SimNative

final class CoreDeviceDisplayInfoTests: XCTestCase {
    func testReadingDisplaysReleasesTheGettersArrayAfterTheResponseIsGone() throws {
        guard SSCoreDeviceDisplayAvailable(),
              let infoMetadata = SSCoreDeviceDisplayInfoMetadata(),
              let displayMetadata = SSCoreDeviceDisplayMetadata(),
              let infoType = unsafeBitCast(infoMetadata, to: Any.Type.self) as? any Decodable.Type
        else { throw XCTSkip("CoreDevice display information unavailable on this host") }

        let fixture = """
        {"backlightState":"off","displays":[{
          "bounds":[[0,0],[100,200]],"frame":[[0,0],[100,200]],"displayId":1,
          "name":"LCD","deviceName":"primary","nativeOrientation":"rot0","currentOrientation":"rot90",
          "logicalScale":[1,1],"pointScale":3,"nativeSize":[100,200],"primary":true,"active":true,
          "backlightState":"off","external":false,"type":{"integrated":{}},
          "currentMode":{"size":[100,200],"preferredUIScale":3,"refreshRate":60,"bitDepth":8,
                         "colorGamut":"sRGB","hdrMode":"standard"},"availableModes":[]
        }]}
        """
        weak var backingStorage: AnyObject?
        func read<T>(_ value: T) throws {
            var info = value
            try withUnsafeMutablePointer(to: &info) { pointer in
                let ownedArray = try XCTUnwrap(SSCoreDeviceDisplays(pointer))
                backingStorage = Unmanaged<AnyObject>.fromOpaque(ownedArray).takeRetainedValue()
                XCTAssertNotNil(backingStorage)
                let type = unsafeBitCast(displayMetadata, to: Any.Type.self)
                let states = CoreDeviceDisplayInfo.states(from: pointer, displayType: type)
                XCTAssertEqual(states, [.init(screenID: 1, isActive: true, orientation: "landscape_left")])
            }
        }
        try autoreleasepool {
            let info = try JSONDecoder().decode(infoType, from: Data(fixture.utf8))
            try _openExistential(info, do: read)
        }
        XCTAssertNil(backingStorage)
    }
}
