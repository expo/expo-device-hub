import Foundation
import XCTest
@testable import SimNative

final class RecordingAvailabilityTests: XCTestCase {
    func testEncoderFailureBlocksTheNextRecordingUntilRestart() throws {
        var availability = RecordingAvailability()
        try availability.checkStart()
        availability.finalizationFailed(NSError(
            domain: "serve-sim-recording", code: 7,
            userInfo: [NSLocalizedDescriptionKey: "Hardware pixel transfer failed"]
        ))
        XCTAssertThrowsError(try availability.checkStart()) { error in
            XCTAssertEqual((error as NSError).code, 11)
        }
        try RecordingAvailability().checkStart() // A new serve-sim session starts fresh.
    }

    func testNoFramesAndManifestWriteFailuresPermitAnotherStart() throws {
        for code in [13, 17] {
            var availability = RecordingAvailability()
            availability.finalizationFailed(NSError(domain: "serve-sim-recording", code: code))
            try availability.checkStart()
        }
    }
}
