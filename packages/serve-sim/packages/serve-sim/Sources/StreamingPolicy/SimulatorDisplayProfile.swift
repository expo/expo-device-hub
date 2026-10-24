import Foundation

/// Integrated panels from the existing simulator profile, excluding virtual outputs.
public struct SimulatorDisplayProfile: Sendable {
    public let integratedDisplayCount: Int
    public let singleIntegratedScreenID: UInt32?
    public let nativeRotations: [UInt32: Int]
    private let recordingScreens: [UInt32: RecordingScreen]

    public var isFoldable: Bool { integratedDisplayCount == 2 }

    public func recordingScreen(screenID: UInt32, chromeIdentifier: String?) -> RecordingScreen? {
        guard let screen = recordingScreens[screenID] else { return nil }
        if let chromeIdentifier, Self.screen(chromeIdentifier: chromeIdentifier) != screen { return nil }
        return screen
    }

    public init(displays: [[String: Any]] = []) {
        var integratedIDs = Set<UInt32>()
        var rotations: [UInt32: Int] = [:]
        var panelIdentities: [(UInt32, RecordingScreen?)] = []
        for display in displays {
            guard display["displayType"] as? String == "integrated",
                  let id = display["screenID"] as? NSNumber,
                  let screenID = UInt32(exactly: id.int64Value) else { continue }
            integratedIDs.insert(screenID)
            panelIdentities.append((screenID, (display["chromeIdentifier"] as? String).flatMap(Self.screen)))
            if let rotation = display["nativeRotation"] as? NSNumber,
               [0, 90, 180, 270].contains(rotation.intValue) {
                rotations[screenID] = rotation.intValue
            }
        }
        integratedDisplayCount = integratedIDs.count
        singleIntegratedScreenID = integratedIDs.count == 1 ? integratedIDs.first : nil
        nativeRotations = rotations
        if integratedIDs.count == 2, panelIdentities.count == 2,
           let first = panelIdentities[0].1, let second = panelIdentities[1].1,
           first != second {
            recordingScreens = [panelIdentities[0].0: first, panelIdentities[1].0: second]
        } else {
            recordingScreens = [:]
        }
    }

    private static func screen(chromeIdentifier: String) -> RecordingScreen? {
        switch chromeIdentifier {
        case "phone14", "com.apple.dt.devicekit.chrome.phone14": return .inner
        case "phone15", "com.apple.dt.devicekit.chrome.phone15": return .outer
        default: return nil
        }
    }
}
