/// Samples successfully written video frames at most four times per second.
/// Callers supply increasing times relative to the first written frame at zero.
public struct RecordingDeviceStateTimeline {
    public private(set) var entries: [RecordingManifest.DeviceState] = []
    private var latest: RecordingManifest.DeviceState?

    public init() {}

    public mutating func append(state: RecordingDeviceState, timeMs: Double) {
        let entry = RecordingManifest.DeviceState(timeMs: timeMs, state: state)
        latest = entry
        guard let last = entries.last else {
            entries.append(entry)
            return
        }
        guard last.state != state, timeMs - last.timeMs >= 250 else { return }
        entries.append(entry)
    }

    public mutating func finish() {
        guard let latest, let last = entries.last, latest.state != last.state else { return }
        // Coalesce the last sample into the final written frame, preserving the
        // initial state. A clip shorter than 250 ms can retain both endpoints.
        if entries.count > 1 { entries.removeLast() }
        if entries.last?.state != latest.state { entries.append(latest) }
    }
}
