import CoreVideo
import XCTest

@testable import SimNative

final class HEVCFixtureReplayTests: XCTestCase {
    private func packets() throws -> [Data] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "iphone12-home-screen", withExtension: "rtp", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: url)
        let magic = Data("SSRTP1".utf8)
        XCTAssertEqual(data.prefix(magic.count), magic)
        var packets: [Data] = []
        var offset = data.startIndex + magic.count
        while offset + 6 <= data.endIndex {
            let length = Int(data[offset + 4]) << 8 | Int(data[offset + 5])
            let start = offset + 6
            guard start + length <= data.endIndex else { break }
            packets.append(data.subdata(in: start..<start + length))
            offset = start + length
        }
        XCTAssertEqual(offset, data.endIndex)
        return packets
    }

    func testReplaysThreeSecondsOfAnIPhoneHomeScreenThroughTheReceiverAndDecoder() throws {
        let packets = try packets()
        XCTAssertEqual(packets.count, 493)
        let parser = HEVCRTPReceiver()
        let decoder = HEVCDecoder()
        var sizes: [Dimensions] = []
        var failures: [String] = []
        parser.onAccessUnit = { decoder.decode($0.nals, timestamp: $0.timestamp) }
        parser.onLoss = { decoder.invalidate() }
        decoder.onFrame = { sizes.append($0.dimensions) }
        decoder.onFailure = { failures.append($0) }
        for packet in packets { parser.receive(packet) }
        parser.flushPending()

        XCTAssertEqual(failures, [])
        XCTAssertEqual(parser.lossEvents, 0)
        XCTAssertFalse(parser.senderEnded)
        XCTAssertEqual(sizes.count, 79)
        XCTAssertEqual(Set(sizes), [Dimensions(width: 1184, height: 2576)])
        XCTAssertFalse(decoder.needsKeyframe)
    }
}
