import CoreMedia
import CoreVideo
import StreamingPolicy
import XCTest

@testable import SimNative

final class FakePhysicalSession: PhysicalStreamSession, @unchecked Sendable {
    private let lock = NSLock()
    private var frameHandler: (@Sendable (CVPixelBuffer) -> Void)?
    private var endHandler: (@Sendable (String) -> Void)?
    private var stops = 0
    var startError: Error?

    func start(onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
               onEnd: @escaping @Sendable (String) -> Void) async throws {
        if let startError { throw startError }
        lock.withLock {
            frameHandler = onFrame
            endHandler = onEnd
        }
    }

    func stop() async { lock.withLock { stops += 1 } }

    var started: Bool { lock.withLock { frameHandler != nil } }
    var stopCount: Int { lock.withLock { stops } }

    func deliver(_ pixels: CVPixelBuffer) { lock.withLock { frameHandler }?(pixels) }
    func fail(_ cause: String) { lock.withLock { endHandler }?(cause) }
}

final class EmittedFrames: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [(size: Dimensions, canvas: Dimensions?, screen: CapturedScreenInfo)] = []
    private var ends: [ScreenSourceEnd] = []
    private var changes = 0

    func append(_ pixels: CVPixelBuffer, canvas: Dimensions?, screen: CapturedScreenInfo) {
        lock.withLock { frames.append((pixels.dimensions, canvas, screen)) }
    }

    func ended(_ end: ScreenSourceEnd) { lock.withLock { ends.append(end) } }
    func changed() { lock.withLock { changes += 1 } }

    var all: [(size: Dimensions, canvas: Dimensions?, screen: CapturedScreenInfo)] { lock.withLock { frames } }
    var endings: [ScreenSourceEnd] { lock.withLock { ends } }
    var screenChanges: Int { lock.withLock { changes } }
}

func paddedFrame(width: Int, height: Int, contentWidth: Int, contentHeight: Int) -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                        [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
    let pixels = buffer!
    CVPixelBufferLockBaseAddress(pixels, [])
    let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(pixels)
    for y in 0..<height {
        for x in 0..<width {
            let pixel = base + y * stride + x * 4
            let content = x < contentWidth && y < contentHeight
            pixel[0] = 0
            pixel[1] = content ? 255 : 0
            pixel[2] = content ? 0 : 255
            pixel[3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(pixels, [])
    return pixels
}

func bgra(_ pixels: CVPixelBuffer, x: Int, y: Int) -> (blue: UInt8, green: UInt8, red: UInt8) {
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
    let pixel = base + y * CVPixelBufferGetBytesPerRow(pixels) + x * 4
    return (pixel[0], pixel[1], pixel[2])
}

let iPhone12Display = PhysicalDisplayCandidate(
    displayID: 1, isActive: nil, isPrimary: true, isIntegrated: true, nativeWidth: 1170, nativeHeight: 2532,
    currentRotation: "rot0", chromeIdentifier: "com.apple.dt.devicekit.chrome.phone4"
)

func fakeConnection(_ session: FakePhysicalSession, displays: [PhysicalDisplayCandidate] = [iPhone12Display]) -> PhysicalDeviceConnection {
    PhysicalDeviceConnection(
        description: PhysicalDeviceDescription(identifier: "0BC25F62-CB38-5086-B4EE-CE206F4DED0B",
                                               hardwareUDID: "00008101-0016603236F0801E", osVersion: "27.2.1",
                                               isPhysical: true, state: "connected", displays: displays),
        session: session,
        readOrientation: { "portrait" }
    )
}

final class PhysicalScreenSourceTests: XCTestCase {
    private func waitUntil(_ condition: () async -> Bool, timeout: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(timeout)
        while await !condition(), Date() < deadline { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    private func startedSource(_ session: FakePhysicalSession, frames: EmittedFrames,
                               idleIntervalNs: UInt64 = 10_000_000_000, maxDimension: Int = 0,
                               first: CVPixelBuffer? = nil) async throws -> PhysicalScreenSource {
        let source = PhysicalScreenSource(open: { _ in fakeConnection(session) }, idleIntervalNs: idleIntervalNs)
        await source.setSnapshotMaxDimension(maxDimension)
        _ = await source.subscribeScreenChanges { frames.changed() }
        let frame = first ?? paddedFrame(width: 1184, height: 2576, contentWidth: 1170, contentHeight: 2532)
        async let started: Void = source.start(
            deviceUDID: "00008101-0016603236F0801E", screenID: nil,
            onFrame: { pixels, _, canvas, screen in frames.append(pixels, canvas: canvas, screen: screen) },
            onEnd: { frames.ended($0) }
        )
        await waitUntil { session.started }
        session.deliver(frame)
        try await started
        return source
    }

    func testCropsEncoderPaddingFromVideoFramesAndScreenshots() async throws {
        let session = FakePhysicalSession()
        let frames = EmittedFrames()
        let source = try await startedSource(session, frames: frames)

        let first = try XCTUnwrap(frames.all.first)
        XCTAssertEqual(first.size, Dimensions(width: 1170, height: 2532))
        XCTAssertEqual(first.canvas, Dimensions(width: 1170, height: 2532))
        XCTAssertEqual(first.screen.width, 1170)
        XCTAssertEqual(first.screen.height, 2532)
        XCTAssertEqual(first.screen.display?.screenID, 1)
        XCTAssertEqual(first.screen.display?.orientation, "portrait")
        XCTAssertEqual(first.screen.display?.chromeIdentifier, "com.apple.dt.devicekit.chrome.phone4")
        let canvas = await source.webRTCEncodeCanvasSize()
        XCTAssertEqual(canvas, Dimensions(width: 1170, height: 2532))
        let upright = await source.framesUpright()
        XCTAssertTrue(upright)

        let screenshot = try await source.screenshotPixels(screenID: 1)
        XCTAssertEqual(screenshot.pixels.dimensions, Dimensions(width: 1170, height: 2532))
        for (x, y) in [(0, 0), (1169, 0), (0, 2531), (1169, 2531)] {
            let pixel = bgra(screenshot.pixels, x: x, y: y)
            XCTAssertGreaterThan(pixel.green, 200, "(\(x), \(y)) is padding")
            XCTAssertLessThan(pixel.red, 60, "(\(x), \(y)) is padding")
        }
        await source.stop(preservingObservers: false)
    }

    func testScalesToTheRequestedSnapshotSize() async throws {
        let session = FakePhysicalSession()
        let frames = EmittedFrames()
        let source = try await startedSource(session, frames: frames, maxDimension: 1280)
        let expected = PhysicalFrameCopier.target(content: PhysicalContentSize(width: 1170, height: 2532), maxDimension: 1280)
        XCTAssertEqual(frames.all.first?.size, expected)
        XCTAssertEqual(expected.height, 1280)
        XCTAssertEqual(frames.all.first?.canvas, Dimensions(width: 1170, height: 2532))
        let screenshot = try await source.screenshotPixels(screenID: 1)
        XCTAssertEqual(screenshot.pixels.dimensions, Dimensions(width: 1170, height: 2532))
        await source.stop(preservingObservers: false)
    }

    func testLandscapeFramesCropToTheTurnedNativeSize() async throws {
        let session = FakePhysicalSession()
        let frames = EmittedFrames()
        let source = try await startedSource(session, frames: frames)
        let changesBefore = frames.screenChanges
        session.deliver(paddedFrame(width: 2576, height: 1184, contentWidth: 2532, contentHeight: 1170))
        await waitUntil { frames.all.count >= 2 }
        XCTAssertEqual(frames.all.last?.size, Dimensions(width: 2532, height: 1170))
        XCTAssertEqual(frames.all.last?.canvas, Dimensions(width: 2532, height: 1170))
        XCTAssertGreaterThan(frames.screenChanges, changesBefore)
        let screen = await source.getScreenSize()
        XCTAssertEqual(screen?.width, 2532)
        await source.stop(preservingObservers: false)
    }

    func testReemitsTheLastFrameOnTheIdleFloor() async throws {
        let session = FakePhysicalSession()
        let frames = EmittedFrames()
        let source = try await startedSource(session, frames: frames, idleIntervalNs: 40_000_000)
        await waitUntil { frames.all.count >= 4 }
        let counts = await source.frameCounts()
        XCTAssertEqual(counts.screen, 1)
        XCTAssertGreaterThanOrEqual(counts.idle, 3)
        XCTAssertTrue(frames.all.allSatisfy { $0.size == Dimensions(width: 1170, height: 2532) })
        await source.stop(preservingObservers: false)
    }

    func testAFailedSessionEndsWithDeviceDisconnectedAndStopsTheStream() async throws {
        let session = FakePhysicalSession()
        let frames = EmittedFrames()
        let source = try await startedSource(session, frames: frames, idleIntervalNs: 20_000_000)
        session.fail("the stream socket failed")
        await waitUntil { !frames.endings.isEmpty && session.stopCount == 1 }
        XCTAssertEqual(frames.endings, [.iPhoneDisconnected])
        XCTAssertEqual(frames.endings.first?.reason, .deviceDisconnected)
        XCTAssertEqual(frames.endings.first?.message, "iPhone disconnected")
        XCTAssertEqual(session.stopCount, 1)
        let emitted = frames.all.count
        session.fail("again")
        session.deliver(paddedFrame(width: 1184, height: 2576, contentWidth: 1170, contentHeight: 2532))
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(frames.all.count, emitted)
        XCTAssertEqual(frames.endings.count, 1)
        do {
            _ = try await source.screenshotPixels(screenID: 1)
            XCTFail("an ended source has no screen")
        } catch {}
        await source.stop(preservingObservers: false)
        XCTAssertEqual(session.stopCount, 1)
    }

    func testEndSignalSerializesForJavaScript() throws {
        let json = try XCTUnwrap(ScreenSourceEnd.iPhoneDisconnected.json().data(using: .utf8))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: String])
        XCTAssertEqual(object, ["reason": "device-disconnected", "message": "iPhone disconnected"])
    }

    func testStopStopsTheSessionOnce() async throws {
        let session = FakePhysicalSession()
        let frames = EmittedFrames()
        let source = try await startedSource(session, frames: frames)
        await source.stop(preservingObservers: false)
        await source.stop(preservingObservers: false)
        XCTAssertEqual(session.stopCount, 1)
        XCTAssertTrue(frames.endings.isEmpty)
    }

    func testRefusesAScreenThePhoneDoesNotHave() async throws {
        let session = FakePhysicalSession()
        let source = PhysicalScreenSource(open: { _ in fakeConnection(session) })
        do {
            try await source.start(deviceUDID: "00008101-0016603236F0801E", screenID: 2,
                                   onFrame: { _, _, _, _ in }, onEnd: { _ in })
            XCTFail("screen 2 is not the phone's screen")
        } catch {
            XCTAssertEqual("\(error)", "The iPhone has no screen 2")
        }
        XCTAssertEqual(session.stopCount, 1)
    }

    func testStartFailsWhenThePhoneEndsBeforeItsFirstFrame() async throws {
        let session = FakePhysicalSession()
        let frames = EmittedFrames()
        let source = PhysicalScreenSource(open: { _ in fakeConnection(session) })
        async let started: Void = source.start(
            deviceUDID: "00008101-0016603236F0801E", screenID: nil,
            onFrame: { _, _, _, _ in }, onEnd: { frames.ended($0) }
        )
        await waitUntil { session.started }
        session.fail("no packets for 5.0 s")
        do {
            try await started
            XCTFail("the phone never sent a frame")
        } catch {
            XCTAssertEqual("\(error)", "iPhone disconnected")
        }
        XCTAssertEqual(frames.endings, [.iPhoneDisconnected])
    }

    func testCaptureEngineLatchesTheEndForLateSubscribers() async throws {
        let session = FakePhysicalSession()
        let source = PhysicalScreenSource(open: { _ in fakeConnection(session) })
        let engine = CaptureEngine(
            deviceUDID: "00008101-0016603236F0801E",
            options: CaptureEngineOptions(mjpegFps: 5, mjpegQuality: 0.7, maxDimension: 0, h264Fps: 30, h264Bitrate: 4_000_000),
            kind: .physical, screenSource: source
        )
        let early = EmittedFrames()
        _ = await engine.subscribeEnd { early.ended($0) }
        async let started: Void = engine.start()
        await waitUntil { session.started }
        session.deliver(paddedFrame(width: 1184, height: 2576, contentWidth: 1170, contentHeight: 2532))
        try await started
        let upright = await engine.framesUpright()
        XCTAssertTrue(upright)
        let size = await engine.currentScreenSize()
        XCTAssertEqual(size.width, 1170)
        XCTAssertEqual(size.height, 2532)

        session.fail("usage assertion invalidated")
        await waitUntil { !early.endings.isEmpty }
        XCTAssertEqual(early.endings, [.iPhoneDisconnected])
        let late = EmittedFrames()
        _ = await engine.subscribeEnd { late.ended($0) }
        XCTAssertEqual(late.endings, [.iPhoneDisconnected])
        try await engine.stop()
    }
}

final class PhysicalDeviceDescriptionTests: XCTestCase {
    private static let iPhone12DeviceInfo: [String: Any] = [
        "identifier": "0BC25F62-CB38-5086-B4EE-CE206F4DED0B",
        "values": [
            ["descriptorIdentifier": ["domain": "com.apple.CoreDevice", "key": "udid"], "value": "00008101-0016603236F0801E"],
            ["descriptorIdentifier": ["domain": "com.apple.CoreDevice", "key": "reality"], "value": "physical"],
            ["descriptorIdentifier": ["domain": "com.apple.CoreDevice", "key": "state"], "value": "connected"],
            ["descriptorIdentifier": ["domain": "com.apple.CoreDevice", "key": "osVersionNumber"],
             "value": ["components": [27, 2, 1, 0, 0], "originalComponentsCount": 3, "stringValue": "27.2.1"]],
            ["descriptorIdentifier": ["domain": "com.apple.CoreDevice", "key": "displayInfo"], "value": [
                "backlightState": "activeOn",
                "displays": [
                    ["displayId": 1, "primary": true, "external": false, "nativeSize": [1170, 2532],
                     "currentOrientation": "rot0", "chromeIdentifier": "com.apple.dt.devicekit.chrome.phone4",
                     "type": ["integrated": [String: Any]()]],
                    ["displayId": 2, "primary": false, "external": true, "nativeSize": [1184, 2544],
                     "currentOrientation": "rot0", "type": ["wireless": [String: Any]()]],
                    ["displayId": 3, "primary": false, "external": true, "nativeSize": [0, 0],
                     "currentOrientation": "rot0", "type": ["wireless": [String: Any]()]],
                ],
            ]],
        ],
    ]

    func testReadsTheHardwareUDIDVersionAndPrimaryDisplay() throws {
        let description = PhysicalDeviceDescription.parse(Self.iPhone12DeviceInfo)
        XCTAssertEqual(description.identifier, "0BC25F62-CB38-5086-B4EE-CE206F4DED0B")
        XCTAssertEqual(description.hardwareUDID, "00008101-0016603236F0801E")
        XCTAssertEqual(description.osVersion, "27.2.1")
        XCTAssertTrue(description.isPhysical)
        XCTAssertEqual(description.state, "connected")
        XCTAssertEqual(description.displays.count, 3)
        XCTAssertTrue(description.displays.allSatisfy { $0.isActive == nil })
        let display = try XCTUnwrap(description.display)
        XCTAssertEqual(display.displayID, 1)
        XCTAssertEqual(display.nativeWidth, 1170)
        XCTAssertEqual(display.nativeHeight, 2532)
        XCTAssertTrue(display.isIntegrated)
        XCTAssertEqual(display.chromeIdentifier, "com.apple.dt.devicekit.chrome.phone4")
    }

    func testAnUnreadableDescriptionHasNoDisplay() {
        let description = PhysicalDeviceDescription.parse(["identifier": "X"])
        XCTAssertNil(description.display)
        XCTAssertNil(description.hardwareUDID)
        XCTAssertFalse(description.isPhysical)
    }

    func testSupportReportShapesForJavaScript() throws {
        func object(_ report: PhysicalSupportReport) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(report.json().utf8)) as? [String: Any])
        }
        let xcode = try object(PhysicalSupportReport(support: .needsXcode27, coreDeviceVersion: "500.1", osVersion: nil, deviceFound: nil))
        XCTAssertEqual(xcode["supported"] as? Bool, false)
        XCTAssertEqual(xcode["reason"] as? String, "needs-xcode-27")
        XCTAssertEqual(xcode["message"] as? String, "needs Xcode 27")
        let ios = try object(PhysicalSupportReport(support: .needsIOS27, coreDeviceVersion: "651.32", osVersion: "26.4", deviceFound: true))
        XCTAssertEqual(ios["reason"] as? String, "needs-ios-27")
        XCTAssertEqual(ios["message"] as? String, "needs iOS 27")
        XCTAssertEqual(ios["osVersion"] as? String, "26.4")
        let supported = try object(PhysicalSupportReport(support: .supported, coreDeviceVersion: "651.32", osVersion: "27.2.1", deviceFound: true))
        XCTAssertEqual(supported["supported"] as? Bool, true)
        XCTAssertNil(supported["reason"])
    }

    func testCoreDeviceLookupMatchesTheIdentifierBeforeTheHardwareUDID() {
        let devices = [("SIM-1", "SIM-1"), ("0BC25F62-CB38-5086-B4EE-CE206F4DED0B", "00008101-0016603236F0801E")]
        var hardwareReads = 0
        func find(_ id: String) -> String? {
            CoreDeviceBridge.first(matching: id, in: devices, identifier: { $0.0 }, hardwareUDID: {
                hardwareReads += 1
                return $0.1
            })?.0
        }
        XCTAssertEqual(find("sim-1"), "SIM-1")
        XCTAssertEqual(hardwareReads, 0)
        XCTAssertEqual(find("0BC25F62-CB38-5086-B4EE-CE206F4DED0B"), "0BC25F62-CB38-5086-B4EE-CE206F4DED0B")
        XCTAssertEqual(find("00008101-0016603236F0801E"), "0BC25F62-CB38-5086-B4EE-CE206F4DED0B")
        XCTAssertNil(find("00008101-FFFFFFFFFFFFFFFF"))
    }
}
