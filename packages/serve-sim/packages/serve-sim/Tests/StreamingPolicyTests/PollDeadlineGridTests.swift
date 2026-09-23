import Testing

@testable import StreamingPolicy

@Suite("PollDeadlineGrid")
struct PollDeadlineGridTests {
    private static let interval: UInt64 = 16_666_667
    private static let base: UInt64 = 1_000_000_000

    private func grid() -> PollDeadlineGrid {
        PollDeadlineGrid(firstDeadlineNanoseconds: Self.base, intervalNanoseconds: Self.interval)
    }

    private func slot(_ n: UInt64, plus offset: UInt64 = 0) -> UInt64 {
        Self.base &+ n &* Self.interval &+ offset
    }

    @Test("reports nothing for a wake that lands on its slot")
    func onTime() {
        var grid = grid()
        #expect(grid.wake(atNanoseconds: slot(0)) == 0)
        #expect(grid.wake(atNanoseconds: slot(1)) == 0)
    }

    @Test("reports how far past its slot a late wake landed")
    func late() {
        var grid = grid()
        #expect(grid.wake(atNanoseconds: slot(0, plus: 4_000_000)) == 4_000_000)
        #expect(grid.wake(atNanoseconds: slot(1, plus: 2_000_000)) == 2_000_000)
    }

    @Test("lands back on the grid after skipping whole slots")
    func skipsWholeSlots() {
        var grid = grid()
        #expect(grid.wake(atNanoseconds: slot(5)) == 5 * Self.interval)
        #expect(grid.wake(atNanoseconds: slot(6, plus: 3_000_000)) == 3_000_000)
    }

    @Test("keeps measuring after a stall that ended mid-slot")
    func staysOnGridAfterMidSlotStall() {
        var grid = grid()
        _ = grid.wake(atNanoseconds: slot(5, plus: Self.interval / 2))
        let reported = (6...20).map { grid.wake(atNanoseconds: slot(UInt64($0), plus: 5_000_000)) }
        #expect(reported == Array(repeating: 5_000_000, count: 15))
    }

    @Test("treats a zero interval as unmeasurable rather than dividing by it")
    func zeroInterval() {
        var grid = PollDeadlineGrid(firstDeadlineNanoseconds: 10, intervalNanoseconds: 0)
        #expect(grid.wake(atNanoseconds: 5_000) == 0)
    }
}
