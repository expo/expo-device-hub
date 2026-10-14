import Foundation

struct DeviceMotionSample: Decodable, Sendable {
    struct Property: Decodable, Sendable {
        let int: Int?
        private enum CodingKeys: String, CodingKey { case int }
        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: CodingKeys.self)
            int = try? container?.decode(Int.self, forKey: .int)
        }
    }
    let properties: [String: Property]
    let timestamp: Double
}

enum DeviceStateUpdate: Sendable {
    case angle(HingeAngleSample)
    case motion(DeviceMotionSample)
    case orientation(PhysicalOrientationSample)
}

struct PhysicalOrientationSample: Sendable {
    let orientation: String?
    let timestamp: Double
}

enum ObservedPhysicalOrientation {
    static let names = ["portrait", "pud", "landscape-left", "landscape-right", "faceup", "facedown"]
    private static let nativeNames = ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight", "faceUp", "faceDown"]

    static func name(_ value: Int?) -> String? {
        guard let value, (1...names.count).contains(value) else { return nil }
        return names[value - 1]
    }

    static func name(_ value: String) -> String? {
        nativeNames.firstIndex(of: value).map { names[$0] }
    }
}

struct ObservedDeviceState {
    private(set) var state = CoreDeviceBridge.HingeState()
    private var angleTimestamp: Double?
    private var motionTimestamp: Double?
    private var orientationTimestamp: Double?

    @discardableResult
    mutating func apply(_ update: DeviceStateUpdate, since startedAt: Double) -> Bool {
        switch update {
        case .angle(let sample):
            guard fresh(sample.timestamp, since: startedAt, after: angleTimestamp) else { return false }
            angleTimestamp = sample.timestamp
            state.angle = sample.isValid ? sample.angle : nil
        case .motion(let sample):
            guard fresh(sample.timestamp, since: startedAt, after: motionTimestamp) else { return false }
            motionTimestamp = sample.timestamp
            if sample.timestamp > (orientationTimestamp ?? -.infinity) {
                orientationTimestamp = sample.timestamp
                state.orientation = ObservedPhysicalOrientation.name(sample.properties["propertyA"]?.int)
            }
            // @ref LLP 0004#confirmed-hinge-state — native tabletop activity, not the requested sensor setting
            if let pose = sample.properties["propertyC"]?.int, (0...10).contains(pose) {
                state.tableMode = pose != 0
            } else { state.tableMode = nil }
        case .orientation(let sample):
            guard fresh(sample.timestamp, since: startedAt, after: orientationTimestamp) else { return false }
            orientationTimestamp = sample.timestamp
            state.orientation = sample.orientation
        }
        return true
    }

    private func fresh(_ timestamp: Double, since startedAt: Double, after previous: Double?) -> Bool {
        timestamp.isFinite && timestamp >= startedAt && timestamp > (previous ?? -.infinity)
    }

    @discardableResult
    mutating func clear() -> Bool {
        guard state != CoreDeviceBridge.HingeState() else { return false }
        state = CoreDeviceBridge.HingeState()
        return true
    }
}
