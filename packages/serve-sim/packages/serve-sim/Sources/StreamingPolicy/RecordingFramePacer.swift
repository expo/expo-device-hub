public struct RecordingFramePacer: Sendable {
    public struct Tick: Equatable, Sendable {
        public let index: Int64
        public let missed: UInt64
    }

    public static let intervalNanoseconds: UInt64 = 16_666_667
    private let startNanoseconds: UInt64
    private var lastIndex: Int64 = -1
    private var finished = false

    public init(startNanoseconds: UInt64) {
        self.startNanoseconds = startNanoseconds
    }

    public mutating func tick(atNanoseconds now: UInt64) -> Tick? {
        guard !finished, now >= startNanoseconds,
              now - startNanoseconds >= Self.intervalNanoseconds else { return nil }
        return advance(to: Int64((now - startNanoseconds - Self.intervalNanoseconds)
                                  / Self.intervalNanoseconds))
    }

    public mutating func finish(atNanoseconds now: UInt64) -> Tick? {
        guard !finished else { return nil }
        finished = true
        guard now >= startNanoseconds else { return nil }
        return advance(to: Int64((now - startNanoseconds) / Self.intervalNanoseconds))
    }

    private mutating func advance(to index: Int64) -> Tick? {
        guard index > lastIndex else { return nil }
        let missed = UInt64(index - lastIndex - 1)
        lastIndex = index
        return Tick(index: index, missed: missed)
    }
}
