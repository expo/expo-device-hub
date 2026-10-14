import XCTest
@testable import SimNative

final class DeviceStateDeliveryTests: XCTestCase {
    func testBlockedDispatchCoalescesToTheLatestCompleteSnapshot() async {
        let blocked = expectation(description: "first dispatch queued")
        let completed = expectation(description: "latest state delivered")
        let dispatch = DeviceStateDispatchProbe(onBlocked: { blocked.fulfill() }, onLatest: { completed.fulfill() })
        let delivery = DeviceStateDelivery { snapshot, delivery in await dispatch.send(snapshot, delivery: delivery) }
        delivery.submit(snapshot(1, angle: 90))
        await fulfillment(of: [blocked], timeout: 2)
        for revision in 2..<100 { delivery.submit(snapshot(UInt64(revision), angle: Double(revision))) }
        delivery.submit(snapshot(100))
        await dispatch.release()
        await fulfillment(of: [completed], timeout: 2)
        await delivery.cancel()?.value
        let received = await dispatch.received
        XCTAssertEqual(received.map(\.revision), [1, 100])
        XCTAssertEqual(received.last?.state, .init())
    }

    func testCancellationRetiresQueuedDispatchAndPendingState() async {
        let blocked = expectation(description: "dispatch queued")
        let dispatch = DeviceStateDispatchProbe(onBlocked: { blocked.fulfill() })
        let delivery = DeviceStateDelivery { snapshot, delivery in await dispatch.send(snapshot, delivery: delivery) }
        delivery.submit(snapshot(1, angle: 90))
        await fulfillment(of: [blocked], timeout: 2)
        delivery.submit(snapshot(2, angle: 45))
        let finishing = delivery.cancel()
        delivery.submit(snapshot(3, angle: 180))
        await dispatch.release()
        await finishing?.value
        delivery.submit(snapshot(4, angle: 0))
        let received = await dispatch.received
        XCTAssertTrue(received.isEmpty)
        XCTAssertFalse(delivery.isActive)
    }

    private func snapshot(_ revision: UInt64, angle: Double? = nil) -> DeviceStateSnapshot {
        .init(generation: 1, revision: revision, state: .init(angle: angle))
    }
}

private actor DeviceStateDispatchProbe {
    private var blocked = false
    private var gate: CheckedContinuation<Void, Never>?
    private(set) var received: [DeviceStateSnapshot] = []
    private let onBlocked: @Sendable () -> Void
    private let onLatest: @Sendable () -> Void

    init(onBlocked: @escaping @Sendable () -> Void, onLatest: @escaping @Sendable () -> Void = {}) {
        self.onBlocked = onBlocked
        self.onLatest = onLatest
    }

    func send(_ snapshot: DeviceStateSnapshot, delivery: DeviceStateDelivery) async {
        if !blocked {
            blocked = true
            await withCheckedContinuation { gate = $0; onBlocked() }
        }
        guard delivery.isActive else { return }
        received.append(snapshot)
        if snapshot.revision == 100 { onLatest() }
    }

    func release() { gate?.resume(); gate = nil }
}
