import Testing
@testable import StreamingPolicy

@Suite("Shared native service readiness")
struct SharedReadinessTests {
    @Test("concurrent callers share initialization and later calls reuse success")
    func sharesInitialization() async throws {
        let readiness = SharedReadiness()
        let probe = ReadinessProbe()
        async let first: Void = readiness.waitUntilReady { await probe.check() }
        await probe.waitForFirstCheck()
        async let second: Void = readiness.waitUntilReady { await probe.check() }
        await probe.becomeReady()
        try await first
        try await second
        try await readiness.waitUntilReady { await probe.check() }
        #expect(await probe.checks == 1)
    }

    @Test("timeout fails explicitly and a later caller can retry")
    func retriesAfterTimeout() async throws {
        let readiness = SharedReadiness(timeout: .milliseconds(20), pollInterval: .milliseconds(1))
        await #expect(throws: SharedReadiness.Failure.timedOut) {
            try await readiness.waitUntilReady { false }
        }
        let probe = ReadinessProbe()
        await probe.becomeReady()
        try await readiness.waitUntilReady { await probe.check() }
        try await readiness.waitUntilReady { await probe.check() }
        #expect(await probe.checks == 1)
    }

    @Test("the deadline includes time spent checking readiness")
    func boundsElapsedTime() async {
        let readiness = SharedReadiness(timeout: .milliseconds(30), pollInterval: .milliseconds(1))
        let probe = SlowReadinessProbe()
        await #expect(throws: SharedReadiness.Failure.timedOut) {
            try await readiness.waitUntilReady { await probe.check() }
        }
        #expect(await probe.checks <= 2)
    }

    @Test("cancelling one caller does not cancel shared initialization")
    func cancellationIsLocal() async throws {
        let readiness = SharedReadiness()
        let probe = ReadinessProbe()
        let first = Task { try await readiness.waitUntilReady { await probe.check() } }
        await probe.waitForFirstCheck()
        first.cancel()
        async let second: Void = readiness.waitUntilReady { await probe.check() }
        await probe.becomeReady()
        await #expect(throws: CancellationError.self) { try await first.value }
        try await second
        #expect(await probe.checks == 1)
    }
}

private actor ReadinessProbe {
    private(set) var checks = 0
    private var ready = false
    private var checksWaiting: [CheckedContinuation<Bool, Never>] = []
    private var startedWaiting: [CheckedContinuation<Void, Never>] = []

    func check() async -> Bool {
        checks += 1
        startedWaiting.forEach { $0.resume() }
        startedWaiting.removeAll()
        if ready { return true }
        return await withCheckedContinuation { checksWaiting.append($0) }
    }

    func waitForFirstCheck() async {
        if checks > 0 { return }
        await withCheckedContinuation { startedWaiting.append($0) }
    }

    func becomeReady() {
        ready = true
        checksWaiting.forEach { $0.resume(returning: true) }
        checksWaiting.removeAll()
    }
}

private actor SlowReadinessProbe {
    private(set) var checks = 0

    func check() async -> Bool {
        checks += 1
        try? await Task.sleep(for: .milliseconds(20))
        return false
    }
}
