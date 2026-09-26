import Testing
@testable import StreamingPolicy

@Suite("HID input setup")
struct HIDInputSetupTests {
    // Regression guard for Duo reboot recovery: SimHID is constructed with the
    // device session, before capture resets CoreDevice's boot-bound state.
    @Test("setup does not start until the first input")
    func startsOnFirstInput() async throws {
        let injector = PendingHIDInjector()
        let setup = HIDInputSetup { try await injector.setup() }

        try await Task.sleep(for: .milliseconds(20))
        #expect(await injector.setupCalls == 0)

        async let touch: Void = setup.run { await injector.touch() }
        await injector.waitForSetup()
        #expect(await injector.setupCalls == 1)
        await injector.finishSetup()
        try await touch
        #expect(await injector.targets == [0x103])
    }

    @Test("concurrent first inputs share one setup")
    func concurrentFirstInputsShareSetup() async throws {
        let injector = PendingHIDInjector()
        let setup = HIDInputSetup { try await injector.setup() }

        async let first: Void = setup.run { await injector.touch() }
        async let second: Void = setup.run { await injector.touch() }
        await injector.waitForSetup()
        await injector.finishSetup()
        _ = try await (first, second)
        #expect(await injector.setupCalls == 1)
        #expect(await injector.targets == [0x103, 0x103])
    }

    @Test("a touch during setup waits for the foldable target instead of using 0x32")
    func waitsForFoldableSetup() async throws {
        let injector = PendingHIDInjector()
        let setup = HIDInputSetup { try await injector.setup() }
        async let touch: Void = setup.run { await injector.touch() }
        await injector.waitForSetup()

        try await Task.sleep(for: .milliseconds(20))
        #expect(await injector.targets.isEmpty)
        await injector.finishSetup()
        try await touch
        #expect(await injector.targets == [0x103])

        try await setup.run { await injector.touch() }
        #expect(await injector.targets == [0x103, 0x103])
        #expect(await injector.setupCalls == 1)
    }

    @Test("failed setup rejects pending and later input without touching partial state")
    func rejectsAfterFailure() async throws {
        let injector = PendingHIDInjector()
        let setup = HIDInputSetup { try await injector.setup() }
        let pending = Task { try await setup.run { await injector.touch() } }
        await injector.waitForSetup()
        await injector.finishSetup(failing: true)

        await #expect(throws: SetupFailure.unavailable) { try await pending.value }
        await #expect(throws: SetupFailure.unavailable) {
            try await setup.run { await injector.touch() }
        }
        #expect(await injector.targets.isEmpty)
        #expect(await injector.setupCalls == 1)
    }
}

private enum SetupFailure: Error { case unavailable }

private actor PendingHIDInjector {
    private var target = HIDTargetPolicy()
    private var setupContinuation: CheckedContinuation<Void, Error>?
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var targets: [UInt32] = []
    private(set) var setupCalls = 0

    func setup() async throws {
        setupCalls += 1
        try await withCheckedThrowingContinuation { continuation in
            setupContinuation = continuation
            startedWaiters.forEach { $0.resume() }
            startedWaiters.removeAll()
        }
        target.setScreen(3, universalHID: true)
    }

    func waitForSetup() async {
        if setupContinuation != nil { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func finishSetup(failing: Bool = false) {
        if failing {
            setupContinuation?.resume(throwing: SetupFailure.unavailable)
        } else {
            setupContinuation?.resume()
        }
        setupContinuation = nil
    }

    func touch() {
        if let id = target.target(for: "begin") { targets.append(id) }
    }
}
