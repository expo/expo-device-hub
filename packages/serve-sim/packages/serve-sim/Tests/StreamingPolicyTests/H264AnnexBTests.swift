import Foundation
import XCTest
@testable import StreamingPolicy

final class H264AnnexBTests: XCTestCase {
    func testPrependsParameterSetsToKeyframeAndConvertsNALLengths() {
        let output = H264AnnexB.convert(
            avcc: Data([0, 0, 0, 2, 0x65, 0x88, 0, 0, 0, 1, 0x06]),
            parameterSets: [Data([0x67, 0x42]), Data([0x68, 0xce])], keyframe: true
        )
        XCTAssertEqual(output, Data([
            0, 0, 0, 1, 0x67, 0x42,
            0, 0, 0, 1, 0x68, 0xce,
            0, 0, 0, 1, 0x65, 0x88,
            0, 0, 0, 1, 0x06,
        ]))
    }

    func testRejectsTruncatedNAL() {
        XCTAssertNil(H264AnnexB.convert(
            avcc: Data([0, 0, 0, 4, 0x41]), parameterSets: [], keyframe: false
        ))
    }
}
