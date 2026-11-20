import CoreDeviceShim
import Foundation
import StreamingPolicy

struct PhysicalDeviceDescription: Equatable, Sendable {
    let identifier: String?
    let hardwareUDID: String?
    let osVersion: String?
    let isPhysical: Bool
    let state: String?
    let displays: [PhysicalDisplayCandidate]

    var display: PhysicalDisplayCandidate? { PhysicalScreenPolicy.chooseDisplay(displays) }

    static func parse(_ deviceInfo: Any) -> PhysicalDeviceDescription {
        let root = deviceInfo as? [String: Any]
        func value(_ key: String) -> Any? { CoreDeviceMediaStreamSession.deviceInfoValue(deviceInfo, key: key) }
        let osVersion = (value("osVersionNumber") as? [String: Any])?["stringValue"] as? String
        let displayInfo = value("displayInfo") as? [String: Any]
        let displays = (displayInfo?["displays"] as? [[String: Any]] ?? []).compactMap(parseDisplay)
        return PhysicalDeviceDescription(
            identifier: root?["identifier"] as? String,
            hardwareUDID: value("udid") as? String,
            osVersion: osVersion,
            isPhysical: value("reality") as? String == "physical",
            state: value("state") as? String,
            displays: displays
        )
    }

    private static func parseDisplay(_ display: [String: Any]) -> PhysicalDisplayCandidate? {
        guard let id = (display["displayId"] as? NSNumber).flatMap({ UInt32(exactly: $0.int64Value) }) else { return nil }
        let size = (display["nativeSize"] as? [NSNumber])?.map(\.doubleValue) ?? []
        let type = display["type"] as? [String: Any]
        return PhysicalDisplayCandidate(
            displayID: id,
            isActive: (display["active"] as? NSNumber)?.boolValue,
            isPrimary: (display["primary"] as? NSNumber)?.boolValue ?? false,
            isIntegrated: type?["integrated"] != nil,
            nativeWidth: size.count == 2 ? size[0] : 0,
            nativeHeight: size.count == 2 ? size[1] : 0,
            currentRotation: display["currentOrientation"] as? String,
            chromeIdentifier: display["chromeIdentifier"] as? String
        )
    }

    static func read(_ device: CoreDeviceRemoteDevice) throws -> PhysicalDeviceDescription {
        guard CoreDeviceMediaStreamCalls.available() else { throw PhysicalDeviceError.unsupported(.needsXcode27) }
        return parse(try CoreDeviceMediaStreamCalls.jsonObject(try CoreDeviceMediaStreamCalls.deviceInfo(device)))
    }
}

enum PhysicalDeviceError: Error, CustomStringConvertible {
    case unsupported(PhysicalDeviceSupport)
    case noDisplay
    case noFrames
    case disconnected
    case screenUnavailable(UInt32)

    var description: String {
        switch self {
        case .unsupported(let support): return "Physical iPhone streaming \(support.message ?? "is unavailable")"
        case .noDisplay: return "The iPhone did not report a screen"
        case .noFrames: return "The iPhone sent no screen frames"
        case .disconnected: return ScreenSourceEnd.iPhoneDisconnected.message
        case .screenUnavailable(let id): return "The iPhone has no screen \(id)"
        }
    }
}

extension PhysicalDeviceError: LocalizedError {
    var errorDescription: String? { description }
}

enum PhysicalDeviceHost {
    static let coreDeviceInfoPlist = "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/Info.plist"

    static func coreDeviceVersion() -> String? {
        guard let info = NSDictionary(contentsOfFile: coreDeviceInfoPlist) else { return nil }
        return info["CFBundleShortVersionString"] as? String
    }

    static func support() -> PhysicalDeviceSupport {
        let version = coreDeviceVersion()
        guard PhysicalDeviceSupport.host(coreDeviceVersion: version, symbolsAvailable: true) == .supported else {
            return .needsXcode27
        }
        return PhysicalDeviceSupport.host(
            coreDeviceVersion: version,
            symbolsAvailable: CoreDeviceMediaStreamCalls.available() && SSCoreDeviceDigitizerAvailable()
        )
    }

    static func report(deviceUDID: String?) async -> PhysicalSupportReport {
        let host = support()
        let version = coreDeviceVersion()
        guard host == .supported, let deviceUDID, !deviceUDID.isEmpty else {
            return PhysicalSupportReport(support: host, coreDeviceVersion: version, osVersion: nil, deviceFound: nil)
        }
        guard let device = try? await CoreDeviceBridge.shared.remoteDevice(udid: deviceUDID),
              let description = try? PhysicalDeviceDescription.read(device) else {
            return PhysicalSupportReport(support: host, coreDeviceVersion: version, osVersion: nil, deviceFound: false)
        }
        return PhysicalSupportReport(support: PhysicalDeviceSupport.device(osVersion: description.osVersion),
                                     coreDeviceVersion: version, osVersion: description.osVersion, deviceFound: true)
    }
}

struct PhysicalSupportReport: Encodable, Equatable {
    let supported: Bool
    let reason: String?
    let message: String?
    let coreDeviceVersion: String?
    let osVersion: String?
    let deviceFound: Bool?

    init(support: PhysicalDeviceSupport, coreDeviceVersion: String?, osVersion: String?, deviceFound: Bool?) {
        supported = support == .supported
        reason = support == .supported ? nil : support.rawValue
        message = support.message
        self.coreDeviceVersion = coreDeviceVersion
        self.osVersion = osVersion
        self.deviceFound = deviceFound
    }

    func json() -> String {
        String(decoding: (try? JSONEncoder().encode(self)) ?? Data("{}".utf8), as: UTF8.self)
    }
}
