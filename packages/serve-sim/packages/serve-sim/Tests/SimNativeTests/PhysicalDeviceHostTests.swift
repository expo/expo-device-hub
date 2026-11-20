import StreamingPolicy
import XCTest
@testable import SimNative

final class PhysicalDeviceHostTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    private func coreDeviceInfoPlist(version: String) throws -> [String: String] {
        let path = directory.appendingPathComponent("Info.plist")
        let info: NSDictionary = ["CFBundleIdentifier": "com.apple.dt.CoreDevice", "CFBundleShortVersionString": version]
        try info.write(to: path)
        return ["SERVE_SIM_COREDEVICE_INFO_PLIST": path.path]
    }

    func testReadsTheInstalledCoreDeviceUnlessTheOverrideNamesAnother() {
        XCTAssertEqual(PhysicalDeviceHost.coreDeviceInfoPlist(environment: [:]), PhysicalDeviceHost.installedCoreDeviceInfoPlist)
        XCTAssertEqual(PhysicalDeviceHost.coreDeviceInfoPlist(environment: ["SERVE_SIM_COREDEVICE_INFO_PLIST": ""]),
                       PhysicalDeviceHost.installedCoreDeviceInfoPlist)
        XCTAssertEqual(PhysicalDeviceHost.coreDeviceInfoPlist(environment: ["SERVE_SIM_COREDEVICE_INFO_PLIST": "/tmp/x.plist"]),
                       "/tmp/x.plist")
    }

    func testAnOlderCoreDeviceNeedsXcode27() throws {
        let environment = try coreDeviceInfoPlist(version: "600.1")

        XCTAssertEqual(PhysicalDeviceHost.coreDeviceVersion(environment: environment), "600.1")
        XCTAssertEqual(PhysicalDeviceHost.support(environment: environment), .needsXcode27)
    }

    func testAMissingCoreDeviceNeedsXcode27() {
        let environment = ["SERVE_SIM_COREDEVICE_INFO_PLIST": directory.appendingPathComponent("missing.plist").path]

        XCTAssertNil(PhysicalDeviceHost.coreDeviceVersion(environment: environment))
        XCTAssertEqual(PhysicalDeviceHost.support(environment: environment), .needsXcode27)
    }
}
