import Testing
@testable import StreamingPolicy

@Suite("Boot-bound cache")
struct BootBoundCacheTests {
    @Test("a lookup stores its value when no reset happened")
    func storesCurrentLookup() {
        var cache = BootBoundCache<String, Int>()
        let lookup = cache.beginLookup()

        let stored = cache.store(1, for: "hid", from: lookup)
        #expect(stored)
        #expect(cache["hid"] == 1)
    }

    @Test("reset drops values from the previous boot")
    func resetDropsValues() {
        var cache = BootBoundCache<String, Int>()
        cache.store(1, for: "hid", from: cache.beginLookup())

        cache.reset()

        #expect(cache["hid"] == nil)
    }

    // Regression guard for Duo reboot recovery: a capability lookup from the
    // old boot can resume after a new capture resets CoreDevice.
    @Test("a lookup that crosses a reset cannot store its stale value")
    func rejectsLookupAcrossReset() {
        var cache = BootBoundCache<String, Int>()
        let stale = cache.beginLookup()

        cache.reset()

        #expect(!cache.isCurrent(stale))
        let storedStale = cache.store(1, for: "hid", from: stale)
        #expect(!storedStale)
        #expect(cache["hid"] == nil)

        let fresh = cache.beginLookup()
        let storedFresh = cache.store(2, for: "hid", from: fresh)
        #expect(storedFresh)
        #expect(cache["hid"] == 2)
    }

    @Test("removing one value keeps lookups current")
    func removeKeepsLookupsCurrent() {
        var cache = BootBoundCache<String, Int>()
        let lookup = cache.beginLookup()
        cache.store(1, for: "hid", from: lookup)

        cache.removeValue(forKey: "hid")

        #expect(cache["hid"] == nil)
        #expect(cache.isCurrent(lookup))
    }
}
