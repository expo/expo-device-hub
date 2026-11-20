import Foundation

public struct PhysicalDisplayCandidate: Equatable, Sendable {
    public let displayID: UInt32
    public let isActive: Bool?
    public let isPrimary: Bool
    public let isIntegrated: Bool
    public let nativeWidth: Double
    public let nativeHeight: Double
    public let currentRotation: String?
    public let chromeIdentifier: String?

    public init(displayID: UInt32, isActive: Bool?, isPrimary: Bool, isIntegrated: Bool,
                nativeWidth: Double, nativeHeight: Double,
                currentRotation: String? = nil, chromeIdentifier: String? = nil) {
        self.displayID = displayID
        self.isActive = isActive
        self.isPrimary = isPrimary
        self.isIntegrated = isIntegrated
        self.nativeWidth = nativeWidth
        self.nativeHeight = nativeHeight
        self.currentRotation = currentRotation
        self.chromeIdentifier = chromeIdentifier
    }
}

public struct PhysicalContentSize: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

public enum PhysicalScreenPolicy {
    public static let universalHIDServiceBase: UInt32 = 0x100

    public static func chooseDisplay(_ displays: [PhysicalDisplayCandidate]) -> PhysicalDisplayCandidate? {
        let active = displays.filter { $0.isActive == true }
        if active.count == 1 { return active[0] }
        return displays.first(where: \.isPrimary) ?? displays.first(where: \.isIntegrated)
    }

    public static func contentSize(encodedWidth: Int, encodedHeight: Int,
                                   nativeWidth: Double?, nativeHeight: Double?) -> PhysicalContentSize {
        let encoded = PhysicalContentSize(width: encodedWidth, height: encodedHeight)
        guard encodedWidth > 0, encodedHeight > 0,
              let a = nativeWidth, let b = nativeHeight,
              a.isFinite, b.isFinite, a > 0, b > 0, a <= 16_384, b <= 16_384 else { return encoded }
        let landscape = encodedWidth > encodedHeight
        let width = landscape ? max(a, b) : min(a, b)
        let height = landscape ? min(a, b) : max(a, b)
        let scale = min(Double(encodedWidth) / width, Double(encodedHeight) / height, 1)
        return PhysicalContentSize(
            width: min(encodedWidth, Int((width * scale).rounded())),
            height: min(encodedHeight, Int((height * scale).rounded()))
        )
    }
}

public enum PhysicalDeviceSupport: String, Sendable {
    case supported
    case needsXcode27 = "needs-xcode-27"
    case needsIOS27 = "needs-ios-27"

    public static let minimumCoreDeviceVersion = 642
    public static let minimumOSMajorVersion = 27

    public var message: String? {
        switch self {
        case .supported: return nil
        case .needsXcode27: return "needs Xcode 27"
        case .needsIOS27: return "needs iOS 27"
        }
    }

    public static func host(coreDeviceVersion: String?, symbolsAvailable: Bool) -> Self {
        guard symbolsAvailable, let major = leadingInteger(coreDeviceVersion),
              major >= minimumCoreDeviceVersion else { return .needsXcode27 }
        return .supported
    }

    public static func device(osVersion: String?) -> Self {
        guard let major = leadingInteger(osVersion), major >= minimumOSMajorVersion else { return .needsIOS27 }
        return .supported
    }

    private static func leadingInteger(_ version: String?) -> Int? {
        guard let version, let first = version.split(separator: ".").first else { return nil }
        return Int(first)
    }
}

public enum CoreDeviceIdentity {
    public static func matches(_ requested: String, identifier: String, hardwareUDID: String?) -> Bool {
        if requested.caseInsensitiveCompare(identifier) == .orderedSame { return true }
        guard let hardwareUDID, !hardwareUDID.isEmpty else { return false }
        return requested.caseInsensitiveCompare(hardwareUDID) == .orderedSame
    }
}
