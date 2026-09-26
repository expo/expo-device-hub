/// Runs input only after the shared native setup task has succeeded.
///
/// Setup starts on the first input, not at construction. A Duo capture resets
/// CoreDevice's boot-bound state before HID asks for capabilities; starting
/// setup earlier can bind the injector to a capability from the previous boot.
public struct HIDInputSetup: Sendable {
    private let starter: Starter

    public init(_ initialize: @escaping @Sendable () async throws -> Void) {
        starter = Starter(initialize)
    }

    public func run<Result>(_ input: () async -> Result) async throws -> Result {
        try await starter.task().value
        return await input()
    }
}

private actor Starter {
    private let initialize: @Sendable () async throws -> Void
    private var setup: Task<Void, Error>?

    init(_ initialize: @escaping @Sendable () async throws -> Void) {
        self.initialize = initialize
    }

    func task() -> Task<Void, Error> {
        if let setup { return setup }
        let started = Task { try await initialize() }
        setup = started
        return started
    }
}
