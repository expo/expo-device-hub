/// Schedules touch-up without keeping a scroll operation in the input queue.
/// The owner validates the generation on its actor before lifting the finger.
public struct ScrollGestureIdle: Sendable {
    private var task: Task<Void, Never>?
    private var generation: UInt64 = 0

    public init() {}

    public mutating func schedule(after delay: Duration, onIdle: @escaping @Sendable (UInt64) async -> Void) {
        cancel()
        let generation = self.generation
        task = Task {
            do { try await Task.sleep(for: delay) }
            catch { return }
            await onIdle(generation)
        }
    }

    /// A callback may already be waiting for the actor when its timer is cancelled.
    public mutating func finish(_ generation: UInt64) -> Bool {
        guard generation == self.generation else { return false }
        task = nil
        self.generation &+= 1
        return true
    }

    public mutating func cancel() {
        task?.cancel()
        task = nil
        generation &+= 1
    }
}
