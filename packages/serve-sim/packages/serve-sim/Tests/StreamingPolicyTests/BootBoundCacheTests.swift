import Testing
@testable import StreamingPolicy

@Suite("Boot-bound cache")
struct BootBoundCacheTests {
    @Test("a lookup stores its value when no reset happened")
    func storesCurrentLookup() {
        var cache = BootBoundCache<String, String, Int>()
        let lookup = cache.beginLookup(scope: "A")

        let stored = cache.store(1, for: "A:hid", from: lookup)
        #expect(stored)
        #expect(cache["A:hid"] == 1)
    }

    @Test("reset drops values from the previous boot")
    func resetDropsValues() {
        var cache = BootBoundCache<String, String, Int>()
        cache.store(1, for: "A:hid", from: cache.beginLookup(scope: "A"))

        cache.reset(scope: "A")

        #expect(cache["A:hid"] == nil)
    }

    // Regression guard for Duo reboot recovery: a capability lookup from the
    // old boot can resume after a new capture resets CoreDevice.
    @Test("a lookup that crosses a reset cannot store its stale value")
    func rejectsLookupAcrossReset() {
        var cache = BootBoundCache<String, String, Int>()
        let stale = cache.beginLookup(scope: "A")

        cache.reset(scope: "A")

        #expect(!cache.isCurrent(stale))
        let storedStale = cache.store(1, for: "A:hid", from: stale)
        #expect(!storedStale)
        #expect(cache["A:hid"] == nil)

        let fresh = cache.beginLookup(scope: "A")
        let storedFresh = cache.store(2, for: "A:hid", from: fresh)
        #expect(storedFresh)
        #expect(cache["A:hid"] == 2)
    }

    // Two Duos on one server: a new capture of B must not break A's input.
    @Test("resetting one device keeps another device's values and lookups")
    func resetIsScopedToOneDevice() {
        var cache = BootBoundCache<String, String, Int>()
        cache.store(1, for: "A:hid", from: cache.beginLookup(scope: "A"))
        cache.store(2, for: "B:hid", from: cache.beginLookup(scope: "B"))
        let inFlightA = cache.beginLookup(scope: "A")

        cache.reset(scope: "B")

        #expect(cache["A:hid"] == 1)
        #expect(cache["B:hid"] == nil)
        #expect(cache.isCurrent(inFlightA))
        let storedA = cache.store(3, for: "A:orientation", from: inFlightA)
        #expect(storedA)
        #expect(cache["A:orientation"] == 3)
    }

    @Test("removing one value keeps lookups current")
    func removeKeepsLookupsCurrent() {
        var cache = BootBoundCache<String, String, Int>()
        let lookup = cache.beginLookup(scope: "A")
        cache.store(1, for: "A:hid", from: lookup)

        cache.removeValue(forKey: "A:hid")

        #expect(cache["A:hid"] == nil)
        #expect(cache.isCurrent(lookup))
    }
}
