import Testing

@testable import StreamingPolicy

@Suite("CachedSurfaceRevalidation")
struct CachedSurfaceRevalidationTests {
    @Test("keeps a cached surface the descriptor still reports")
    func same() {
        #expect(CachedSurfaceRevalidation.decide(cachedID: 7, liveID: 7) == .keep)
    }

    @Test("replaces a cached surface when the descriptor reports another one")
    func swapped() {
        #expect(CachedSurfaceRevalidation.decide(cachedID: 7, liveID: 8) == .replace)
        #expect(CachedSurfaceRevalidation.decide(cachedID: nil, liveID: 8) == .replace)
    }

    @Test("drops a cached surface the descriptor no longer reports")
    func gone() {
        #expect(CachedSurfaceRevalidation.decide(cachedID: 7, liveID: nil) == .drop)
        #expect(CachedSurfaceRevalidation.decide(cachedID: nil, liveID: nil) == .keep)
    }
}
