import Testing

@testable import StreamingPolicy

@Suite("SnapshotSizePolicy")
struct SnapshotSizePolicyTests {
    @Test("leaves a screen already within the limit untouched")
    func withinLimit() {
        let size = SnapshotSizePolicy(width: 588, height: 1280, maxDimension: 1280)
        #expect(size.width == 588)
        #expect(size.height == 1280)
    }

    @Test("scales the long edge to the limit and keeps the aspect ratio")
    func scalesLongEdge() {
        let size = SnapshotSizePolicy(width: 1206, height: 2622, maxDimension: 1280)
        #expect(size.height == 1280)
        #expect(size.width == 588)
    }

    @Test("rounds to even, which encoders take without a conversion pass")
    func roundsToEven() {
        let size = SnapshotSizePolicy(width: 1207, height: 2623, maxDimension: 1281)
        #expect(size.width % 2 == 0)
        #expect(size.height % 2 == 0)
    }

    @Test("never returns a zero edge, which would produce an unusable buffer")
    func neverZero() {
        let size = SnapshotSizePolicy(width: 1206, height: 2622, maxDimension: 1)
        #expect(size.width >= 2)
        #expect(size.height >= 2)
    }

    @Test("treats no limit as no scaling")
    func noLimit() {
        let size = SnapshotSizePolicy(width: 1206, height: 2622, maxDimension: 0)
        #expect(size.width == 1206)
        #expect(size.height == 2622)
    }

    @Test("even-rounds full-size Duo inner frames for 4:2:0 encoding", arguments: [0, -1, 4096])
    func duoInnerOdd(maxDimension: Int) {
        let size = SnapshotSizePolicy(width: 2007, height: 2853, maxDimension: maxDimension)
        #expect(size.width == 2006)
        #expect(size.height == 2852)
    }

    @Test("keeps both dimensions usable when no scaling is requested", arguments: [0, -1, 1])
    func tinyUnscaledEdge(edge: Int) {
        let size = SnapshotSizePolicy(width: edge, height: edge, maxDimension: 0)
        #expect(size.width == 2)
        #expect(size.height == 2)
    }
}
