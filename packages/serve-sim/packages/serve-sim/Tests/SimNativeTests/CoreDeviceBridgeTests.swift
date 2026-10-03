import XCTest
@testable import SimNative

final class CoreDeviceBridgeTests: XCTestCase {
    private let udid = "recording-test-device"
    private let knownPose = CoreDeviceBridge.HingeState(
        angle: 180, orientation: "portrait", tableMode: false
    )

    func testSuspendedReadCannotOverwriteCommandsThatReturnToTheSamePose() async {
        let reader = ControlledHingeAngleReader()
        let bridge = CoreDeviceBridge(hingeAngleReader: { _ in await reader.read() })
        await bridge.updateHingeState(udid: udid) { $0 = knownPose }
        let read = Task { await bridge.hingeState(udid: udid) }
        await reader.waitForRead(0)

        await bridge.updateHingeState(udid: udid) { $0.angle = 0 }
        await bridge.updateHingeState(udid: udid) { $0.angle = 180 }
        await reader.resolve(0, angle: 90)

        let result = await read.value
        let cached = await bridge.cachedHingeState(udid: udid)
        XCTAssertEqual(result, knownPose)
        XCTAssertEqual(cached, knownPose)
    }

    func testSuspendedReadCannotRestoreStateFromAPreviousCapture() async {
        let reader = ControlledHingeAngleReader()
        let bridge = CoreDeviceBridge(hingeAngleReader: { _ in await reader.read() })
        await bridge.updateHingeState(udid: udid) { $0 = knownPose }
        let read = Task { await bridge.hingeState(udid: udid) }
        await reader.waitForRead(0)

        await bridge.resetForNewCapture(udid: udid)
        let reset = await bridge.cachedHingeState(udid: udid)
        XCTAssertEqual(reset, CoreDeviceBridge.HingeState())
        // Identical state and revision in the new capture still belong to a new boot.
        await bridge.updateHingeState(udid: udid) { $0 = knownPose }
        await reader.resolve(0, angle: 90)

        let result = await read.value
        XCTAssertEqual(result, knownPose)
    }

    func testOlderReadCannotReplaceANewerReadThatCompletesFirst() async {
        let reader = ControlledHingeAngleReader()
        let bridge = CoreDeviceBridge(hingeAngleReader: { _ in await reader.read() })
        await bridge.updateHingeState(udid: udid) { $0 = knownPose }
        let older = Task { await bridge.hingeState(udid: udid) }
        await reader.waitForRead(0)
        let newer = Task { await bridge.hingeState(udid: udid) }
        await reader.waitForRead(1)

        await reader.resolve(1, angle: 45)
        let newerResult = await newer.value
        await reader.resolve(0, angle: 90)
        let olderResult = await older.value
        let cached = await bridge.cachedHingeState(udid: udid)

        XCTAssertEqual(newerResult, .init(angle: 45))
        XCTAssertEqual(olderResult, newerResult)
        XCTAssertEqual(cached, newerResult)
    }

    func testOlderReadCannotOverwriteNewerReadsThatReturnToTheSameAngle() async {
        let reader = ControlledHingeAngleReader()
        let bridge = CoreDeviceBridge(hingeAngleReader: { _ in await reader.read() })
        await bridge.updateHingeState(udid: udid) { $0.angle = 180 }
        let oldest = Task { await bridge.hingeState(udid: udid) }
        await reader.waitForRead(0)

        let middle = Task { await bridge.hingeState(udid: udid) }
        await reader.waitForRead(1)
        await reader.resolve(1, angle: 90)
        _ = await middle.value
        let newest = Task { await bridge.hingeState(udid: udid) }
        await reader.waitForRead(2)
        await reader.resolve(2, angle: 180)
        _ = await newest.value
        await reader.resolve(0, angle: 90)

        let result = await oldest.value
        let cached = await bridge.cachedHingeState(udid: udid)
        XCTAssertEqual(result, .init(angle: 180))
        XCTAssertEqual(cached, .init(angle: 180))
    }

    func testUnavailableReadRetainsSuccessfulCommandState() async {
        let bridge = CoreDeviceBridge(hingeAngleReader: { _ in nil })
        await bridge.updateHingeState(udid: udid) { $0 = knownPose }

        let result = await bridge.hingeState(udid: udid)

        XCTAssertEqual(result, knownPose)
    }

    func testExternalAngleChangeClearsPoseFieldsWithNoReadback() async {
        let bridge = CoreDeviceBridge(hingeAngleReader: { _ in 45.5 })
        await bridge.updateHingeState(udid: udid) { $0 = knownPose }

        let result = await bridge.hingeState(udid: udid)
        let cached = await bridge.cachedHingeState(udid: udid)

        XCTAssertEqual(result, .init(angle: 45.5))
        XCTAssertEqual(cached, result)
    }
}

private actor ControlledHingeAngleReader {
    private var nextIndex = 0
    private var reads: [Int: CheckedContinuation<Double?, Never>] = [:]
    private var waiters: [Int: CheckedContinuation<Void, Never>] = [:]

    func read() async -> Double? {
        let index = nextIndex
        nextIndex += 1
        return await withCheckedContinuation { continuation in
            reads[index] = continuation
            waiters.removeValue(forKey: index)?.resume()
        }
    }

    func waitForRead(_ index: Int) async {
        guard reads[index] == nil else { return }
        await withCheckedContinuation { waiters[index] = $0 }
    }

    func resolve(_ index: Int, angle: Double?) {
        reads.removeValue(forKey: index)?.resume(returning: angle)
    }
}
