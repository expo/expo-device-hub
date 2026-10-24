import Foundation

// Compiled with the production lookup helper and HIDInputSetup by the Bun suite.
@main
struct HIDServicesRegression {
    static func main() async throws {
        switch CommandLine.arguments[1] {
        case "ready":
            let probe = ServiceProbe()
            let services = try await probe.open()
            precondition(services.digitizer == 100 && services.keyboard == 200)
            let events = await probe.events
            precondition(events == ["touch-service", "keyboard-service"])
        case "keyboard-failure":
            let probe = ServiceProbe(keyboardFailures: 10)
            let setup = HIDInputSetup { _ = try await probe.open() }
            async let touch = rejectedCode { try await setup.run { await probe.control("touch") } }
            async let home = rejectedCode { try await setup.run { await probe.control("home") } }
            let codes = await [touch, home]
            precondition(codes == [9, 9])
            for control in ["rotation", "memory-warning", "touch"] {
                let code = await rejectedCode { try await setup.run { await probe.control(control) } }
                precondition(code == 9)
            }
            let events = await probe.events
            precondition(events == Array(repeating: ["touch-service", "keyboard-service", "delay"], count: 9).flatMap { $0 }
                + ["touch-service", "keyboard-service"])
            let underlying = await probe.lastError?.userInfo[NSUnderlyingErrorKey] as? NSError
            precondition(underlying?.domain == "TestKeyboardService" && underlying?.code == 42)
        case "transient-keyboard":
            let probe = ServiceProbe(keyboardFailures: 2)
            let setup = HIDInputSetup { _ = try await probe.open() }
            try await setup.run { await probe.control("touch") }
            try await setup.run { await probe.control("home") }
            let events = await probe.events
            precondition(events == ["touch-service", "keyboard-service", "delay",
                                    "touch-service", "keyboard-service", "delay",
                                    "touch-service", "keyboard-service", "touch", "home"])
        case "touch-failure":
            let probe = ServiceProbe(touchFails: true)
            let code = await rejectedCode { _ = try await probe.open() }
            precondition(code == 8)
            let events = await probe.events
            precondition(events == Array(repeating: ["touch-service", "delay"], count: 9).flatMap { $0 } + ["touch-service"])
        case "cancelled-retry":
            let probe = ServiceProbe(keyboardFailures: 10, cancelDelay: true)
            do {
                _ = try await probe.open()
                preconditionFailure("Expected cancellation")
            } catch {
                precondition(error is CancellationError)
            }
            let events = await probe.events
            precondition(events == ["touch-service", "keyboard-service", "delay"])
        default:
            preconditionFailure("Unknown scenario")
        }
    }

    private static func rejectedCode(_ run: () async throws -> Void) async -> Int {
        do {
            try await run()
            preconditionFailure("Expected service lookup failure")
        } catch {
            precondition((error as NSError).domain == "HIDInjector")
            return (error as NSError).code
        }
    }
}

private actor ServiceProbe {
    private var keyboardFailures: Int
    private let touchFails: Bool
    private let cancelDelay: Bool
    private(set) var events: [String] = []
    private(set) var lastError: NSError?

    init(keyboardFailures: Int = 0, touchFails: Bool = false, cancelDelay: Bool = false) {
        self.keyboardFailures = keyboardFailures
        self.touchFails = touchFails
        self.cancelDelay = cancelDelay
    }

    func open() async throws -> (digitizer: Int, keyboard: Int) {
        do {
            return try await CoreDeviceHIDServices.open(
                digitizer: { try await self.digitizer() },
                keyboard: { try await self.keyboard() },
                retryDelay: { try await self.delay() }
            )
        } catch {
            lastError = error as NSError
            throw error
        }
    }

    private func digitizer() throws -> Int {
        events.append("touch-service")
        if touchFails { throw NSError(domain: "TestTouchService", code: 1) }
        return 100
    }

    private func keyboard() throws -> Int {
        events.append("keyboard-service")
        if keyboardFailures > 0 {
            keyboardFailures -= 1
            throw NSError(domain: "TestKeyboardService", code: 42)
        }
        return 200
    }

    private func delay() throws {
        events.append("delay")
        if cancelDelay { throw CancellationError() }
    }

    func control(_ name: String) { events.append(name) }
}
