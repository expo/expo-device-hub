/// Runs input only after the shared native setup task has succeeded.
public struct HIDInputSetup: Sendable {
    private let setup: Task<Void, Error>

    public init(_ initialize: @escaping @Sendable () async throws -> Void) {
        setup = Task { try await initialize() }
    }

    public func run<Result>(_ input: () async -> Result) async throws -> Result {
        try await setup.value
        return await input()
    }
}
