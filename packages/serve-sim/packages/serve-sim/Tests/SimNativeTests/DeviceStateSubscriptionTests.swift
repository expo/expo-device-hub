import XCTest
@testable import SimNative

final class DeviceStateSubscriptionTests: XCTestCase {
    private let udid = "shared-observer-test-device"

    func testTwoSubscribersShareOneProducerUntilTheLastUnsubscribe() async {
        let connected = expectation(description: "one shared producer")
        let firstUpdated = expectation(description: "first subscriber")
        let secondUpdated = expectation(description: "second subscriber")
        let source = DeviceStateProducerProbe(onConnect: { _ in connected.fulfill() })
        let bridge = makeBridge(source)
        let first = await bridge.subscribeDeviceState(udid: udid) { state in
            if state.angle == 90 { firstUpdated.fulfill() }
        }
        await fulfillment(of: [connected], timeout: 2)
        let second = await bridge.subscribeDeviceState(udid: udid) { state in
            if state.angle == 90 { secondUpdated.fulfill() }
        }
        await source.yield(0, .angle(.init(angle: 90, timestamp: 11)))
        await fulfillment(of: [firstUpdated, secondUpdated], timeout: 2)
        let observed = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(observed, .init(angle: 90))
        await first()
        let endedBeforeLast = await source.endedConnections
        XCTAssertTrue(endedBeforeLast.isEmpty)
        await second()
        let count = await source.connectionCount
        let ended = await source.endedConnections
        XCTAssertEqual(count, 1)
        XCTAssertEqual(ended, [0])
    }

    func testReplacementWaitsForThePreviousProducerTeardown() async {
        let firstConnected = expectation(description: "first producer")
        let secondConnected = expectation(description: "replacement producer")
        let tearingDown = expectation(description: "teardown paused")
        let source = DeviceStateProducerProbe(onConnect: { index in
            (index == 0 ? firstConnected : secondConnected).fulfill()
        }, onTeardown: { _ in tearingDown.fulfill() }, holdFirstTeardown: true)
        let bridge = makeBridge(source)
        let first = await bridge.subscribeDeviceState(udid: udid) { _ in }
        await fulfillment(of: [firstConnected], timeout: 2)
        let stopping = Task { await first() }
        await fulfillment(of: [tearingDown], timeout: 2)
        let starting = Task { await bridge.subscribeDeviceState(udid: self.udid) { _ in } }
        try? await Task.sleep(for: .milliseconds(50))
        let beforeTeardown = await source.connectionCount
        XCTAssertEqual(beforeTeardown, 1)
        await source.releaseTeardown()
        await stopping.value
        let second = await starting.value
        await fulfillment(of: [secondConnected], timeout: 2)
        let maximum = await source.maximumActiveConnections
        XCTAssertEqual(maximum, 1)
        await second()
    }

    func testBootResetRestartsExistingLeasesAndRejectsLateOldCallbacks() async {
        let oldConnected = expectation(description: "old boot")
        let newConnected = expectation(description: "new boot")
        let source = DeviceStateProducerProbe(onConnect: { index in
            (index == 0 ? oldConnected : newConnected).fulfill()
        })
        let bridge = makeBridge(source)
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { _ in }
        await fulfillment(of: [oldConnected], timeout: 2)
        await source.inject(0, .angle(.init(angle: 90, timestamp: 11)))
        await bridge.resetForNewCapture(udid: udid)
        await fulfillment(of: [newConnected], timeout: 2)
        await source.inject(0, .angle(.init(angle: 180, timestamp: 999)))
        let reset = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(reset, .init())
        await source.inject(1, .angle(.init(angle: 45, timestamp: 12)))
        let current = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(current, .init(angle: 45))
        let maximum = await source.maximumActiveConnections
        XCTAssertEqual(maximum, 1)
        await unsubscribe()
    }

    func testReconnectClearsKnownStateAndOldBufferedSamplesCannotRestoreIt() async {
        let oldConnected = expectation(description: "initial producer")
        let recovered = expectation(description: "reconnected producer")
        let source = DeviceStateProducerProbe(onConnect: { index in
            (index == 0 ? oldConnected : recovered).fulfill()
        })
        let bridge = makeBridge(source)
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { _ in }
        await fulfillment(of: [oldConnected], timeout: 2)
        await source.inject(0, .angle(.init(angle: 90, timestamp: 12)))
        await source.finish(0)
        await fulfillment(of: [recovered], timeout: 2)
        await source.inject(0, .angle(.init(angle: 180, timestamp: 999)))
        await source.inject(1, .angle(.init(angle: 180, timestamp: 11)))
        let unknown = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(unknown, .init())
        await source.inject(1, .angle(.init(angle: 45, timestamp: 13)))
        let fresh = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(fresh, .init(angle: 45))
        await unsubscribe()
    }

    func testFailureReconnects() async {
        let connected = expectation(description: "initial producer")
        let recovered = expectation(description: "producer after failure")
        let source = DeviceStateProducerProbe(onConnect: { index in
            (index == 0 ? connected : recovered).fulfill()
        })
        let bridge = makeBridge(source)
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { _ in }
        await fulfillment(of: [connected], timeout: 2)
        await source.finish(0, throwing: true)
        await fulfillment(of: [recovered], timeout: 2)
        await unsubscribe()
        let count = await source.connectionCount
        let terminated = await source.endedConnections
        XCTAssertEqual(count, 2)
        XCTAssertEqual(terminated, [0, 1])
    }

    func testLastUnsubscribeCancelsBackoff() async {
        let connected = expectation(description: "producer")
        let backingOff = expectation(description: "known state cleared before backoff")
        let source = DeviceStateProducerProbe(onConnect: { _ in connected.fulfill() })
        let bridge = makeBridge(source, reconnectDelay: .seconds(60))
        let received = ObservedStateProbe()
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { state in
            if received.clearedAfterKnown(state) { backingOff.fulfill() }
        }
        await fulfillment(of: [connected], timeout: 2)
        await source.inject(0, .angle(.init(angle: 90, timestamp: 11)))
        await source.finish(0)
        await fulfillment(of: [backingOff], timeout: 2)
        let started = ContinuousClock.now
        await unsubscribe()
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
        let count = await source.connectionCount
        XCTAssertEqual(count, 1)
    }

    func testBootResetDuringBackoffRetiresTheOldConnection() async {
        let connected = expectation(description: "old boot")
        let ended = expectation(description: "old connection ended")
        let replacement = expectation(description: "replacement boot")
        let source = DeviceStateProducerProbe(onConnect: { index in
            (index == 0 ? connected : replacement).fulfill()
        }, onEnd: { index in if index == 0 { ended.fulfill() } })
        let bridge = makeBridge(source, reconnectDelay: .seconds(60))
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { _ in }
        await fulfillment(of: [connected], timeout: 2)
        await source.finish(0)
        await fulfillment(of: [ended], timeout: 2)
        await bridge.resetForNewCapture(udid: udid)
        await fulfillment(of: [replacement], timeout: 2)
        await source.inject(0, .angle(.init(angle: 180, timestamp: 999)))
        await source.inject(1, .angle(.init(angle: 45, timestamp: 11)))
        let current = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(current.angle, 45)
        await unsubscribe()
        let count = await source.connectionCount
        XCTAssertEqual(count, 2)
    }

    func testCancelledCallbackCannotPublishObservedState() async {
        let connected = expectation(description: "producer")
        let source = DeviceStateProducerProbe(onConnect: { _ in connected.fulfill() })
        let bridge = makeBridge(source)
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { _ in }
        await fulfillment(of: [connected], timeout: 2)
        await Task {
            withUnsafeCurrentTask { $0?.cancel() }
            await source.inject(0, .angle(.init(angle: 90, timestamp: 11)))
        }.value
        let observed = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(observed, .init())
        await unsubscribe()
    }

    func testUnsupportedReadbackEndsWithoutReconnect() async {
        let unsupported = expectation(description: "unsupported producer")
        unsupported.assertForOverFulfill = true
        let bridge = CoreDeviceBridge(deviceStateConsumer: { _, _ in unsupported.fulfill(); return false })
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { _ in }
        await fulfillment(of: [unsupported], timeout: 2)
        let current = await bridge.observedDeviceState(udid: udid)
        XCTAssertEqual(current, .init())
        await unsubscribe()
    }

    private func makeBridge(_ source: DeviceStateProducerProbe, reconnectDelay: Duration = .milliseconds(10)) -> CoreDeviceBridge {
        CoreDeviceBridge(deviceStateConsumer: { _, receive in try await source.consume(receive) },
                         hingeClock: { 10 }, reconnectDelay: reconnectDelay)
    }
}

private actor DeviceStateProducerProbe {
    typealias Receiver = @Sendable (DeviceStateUpdate) async -> Void
    private var streams: [Int: AsyncThrowingStream<DeviceStateUpdate, Error>.Continuation] = [:]
    private var receivers: [Int: Receiver] = [:]
    private var teardown: CheckedContinuation<Void, Never>?
    private var activeConnections = 0
    private(set) var maximumActiveConnections = 0
    private(set) var connectionCount = 0
    private(set) var endedConnections: [Int] = []
    private let onConnect: @Sendable (Int) -> Void
    private let onTeardown: @Sendable (Int) -> Void
    private let onEnd: @Sendable (Int) -> Void
    private let holdFirstTeardown: Bool

    init(onConnect: @escaping @Sendable (Int) -> Void,
         onTeardown: @escaping @Sendable (Int) -> Void = { _ in }, holdFirstTeardown: Bool = false,
         onEnd: @escaping @Sendable (Int) -> Void = { _ in }) {
        self.onConnect = onConnect
        self.onTeardown = onTeardown
        self.holdFirstTeardown = holdFirstTeardown
        self.onEnd = onEnd
    }

    func consume(_ receive: @escaping Receiver) async throws -> Bool {
        let index = connectionCount
        connectionCount += 1
        activeConnections += 1
        maximumActiveConnections = max(maximumActiveConnections, activeConnections)
        receivers[index] = receive
        let stream = AsyncThrowingStream<DeviceStateUpdate, Error> { streams[index] = $0 }
        defer {
            streams.removeValue(forKey: index)
            activeConnections -= 1
            endedConnections.append(index)
            onEnd(index)
        }
        onConnect(index)
        for try await update in stream { await receive(update) }
        if holdFirstTeardown && index == 0 {
            onTeardown(index)
            await withCheckedContinuation { teardown = $0 }
        }
        return true
    }

    func yield(_ index: Int, _ update: DeviceStateUpdate) { streams[index]?.yield(update) }
    func inject(_ index: Int, _ update: DeviceStateUpdate) async { await receivers[index]?(update) }
    func finish(_ index: Int, throwing: Bool = false) {
        if throwing { streams[index]?.finish(throwing: ProducerError.disconnected) }
        else { streams[index]?.finish() }
    }
    func releaseTeardown() { teardown?.resume(); teardown = nil }
}

private enum ProducerError: Error { case disconnected }

private final class ObservedStateProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var known = false

    func clearedAfterKnown(_ state: CoreDeviceBridge.HingeState) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if state != .init() { known = true; return false }
        return known
    }
}
