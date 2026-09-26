/// Caches values that belong to one simulator boot.
///
/// `reset()` drops every value and invalidates lookups that started before it,
/// so a lookup that resumes after a reboot cannot store a handle from the
/// previous boot.
public struct BootBoundCache<Key: Hashable, Value> {
    public struct Lookup: Equatable, Sendable {
        fileprivate let generation: UInt64
    }

    private var values: [Key: Value] = [:]
    private var generation: UInt64 = 0

    public init() {}

    public subscript(key: Key) -> Value? { values[key] }

    public func beginLookup() -> Lookup { Lookup(generation: generation) }

    public func isCurrent(_ lookup: Lookup) -> Bool { lookup.generation == generation }

    /// Stores `value` only if no reset happened since `lookup` began.
    @discardableResult
    public mutating func store(_ value: Value, for key: Key, from lookup: Lookup) -> Bool {
        guard isCurrent(lookup) else { return false }
        values[key] = value
        return true
    }

    public mutating func removeValue(forKey key: Key) {
        values.removeValue(forKey: key)
    }

    public mutating func reset() {
        generation &+= 1
        values.removeAll()
    }
}
