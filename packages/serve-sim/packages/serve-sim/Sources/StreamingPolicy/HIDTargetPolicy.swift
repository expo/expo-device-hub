/// Pins the selected transport's digitizer target until lift.
public struct HIDTargetPolicy: Sendable {
    private var selectedTarget: UInt32? = 0x32
    private var gestureTarget: UInt32?
    private var gestureIsActive = false

    public init() {}

    public mutating func setScreen(_ screenID: UInt32?, universalHID: Bool = false) {
        // Universal HID assigns touchscreen services 0x100 + display ID.
        // Wait for capture to identify the panel instead of guessing a default.
        selectedTarget = universalHID
            ? screenID.map { 0x100 + $0 }
            : 0x32
    }

    public mutating func target(for phase: String) -> UInt32? {
        switch phase {
        case "begin":
            gestureIsActive = true
            gestureTarget = selectedTarget
            return gestureTarget
        case "move":
            return gestureIsActive ? gestureTarget : selectedTarget
        case "end":
            let target = gestureIsActive ? gestureTarget : selectedTarget
            gestureIsActive = false
            gestureTarget = nil
            return target
        default:
            return nil
        }
    }
}
