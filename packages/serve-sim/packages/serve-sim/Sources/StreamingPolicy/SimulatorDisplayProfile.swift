import Foundation

/// Integrated panels from the existing simulator profile, excluding virtual outputs.
public struct SimulatorDisplayProfile: Sendable {
    public let integratedDisplayCount: Int
    public let nativeRotations: [UInt32: Int]

    // The new path worked in iOS 27.2 testing. For older-runtime compatibility,
    // keep it limited to foldables (two integrated displays) for now.
    public var isFoldable: Bool { integratedDisplayCount == 2 }

    public init(displays: [[String: Any]] = []) {
        var integratedIDs = Set<UInt32>()
        var rotations: [UInt32: Int] = [:]
        for display in displays {
            guard display["displayType"] as? String == "integrated",
                  let id = display["screenID"] as? NSNumber,
                  let screenID = UInt32(exactly: id.int64Value) else { continue }
            integratedIDs.insert(screenID)
            if let rotation = display["nativeRotation"] as? NSNumber,
               [0, 90, 180, 270].contains(rotation.intValue) {
                rotations[screenID] = rotation.intValue
            }
        }
        integratedDisplayCount = integratedIDs.count
        nativeRotations = rotations
    }
}
