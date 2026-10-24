/// Samples successfully written video frames. Geometry changes keep their own
/// frame time; pose-only changes are kept at most four times per second.
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
        guard last.state != state,
              !last.state.hasSameGeometry(as: state) || timeMs - last.timeMs >= 250 else { return }
        entries.append(entry)
    }

    public mutating func finish() {
        guard let latest, let last = entries.last, latest.state != last.state else { return }
        // Coalesce the last partial pose interval without moving geometry boundaries.
        for index in entries.indices.dropFirst().reversed() {
            guard latest.timeMs - entries[index].timeMs < 250 else { break }
            if entries[index].state.hasSameGeometry(as: entries[index - 1].state) {
                entries.remove(at: index)
                break
            }
        }
        if entries.last?.state != latest.state { entries.append(latest) }
    }
}

private extension RecordingDeviceState {
    func hasSameGeometry(as other: RecordingDeviceState) -> Bool {
        width == other.width && height == other.height && orientation == other.orientation &&
            screen == other.screen && contentRect == other.contentRect
    }
}
