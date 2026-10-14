import CoreMedia
import CoreVideo
import Foundation
import StreamingPolicy

struct NativeCapturedFrame: @unchecked Sendable {
    let pixelBuffer: CVPixelBuffer
    let timestamp: CMTime
    let wallClock: Date
    let deviceState: RecordingDeviceState
    let contentSize: Dimensions
}

final class NativeFrameMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var frame: NativeCapturedFrame?
    private var active = false
    private var hingeState: CoreDeviceBridge.HingeState?

    func publish(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime, wallClock: Date,
                 deviceState: RecordingDeviceState? = nil) {
        lock.lock()
        defer { lock.unlock() }
        if active {
            let state = deviceState ?? RecordingDeviceState(
                width: CVPixelBufferGetWidth(pixelBuffer), height: CVPixelBufferGetHeight(pixelBuffer)
            )
            frame = NativeCapturedFrame(
                pixelBuffer: pixelBuffer, timestamp: timestamp, wallClock: wallClock,
                deviceState: state,
                contentSize: Dimensions(
                    width: min(state.width, CVPixelBufferGetWidth(pixelBuffer)),
                    height: min(state.height, CVPixelBufferGetHeight(pixelBuffer))
                )
            )
        }
    }

    func setActive(_ value: Bool) {
        lock.lock()
        defer { lock.unlock() }
        active = value
        if !value {
            frame = nil
            hingeState = nil
        }
    }

    func updateHingeState(_ state: CoreDeviceBridge.HingeState) {
        lock.lock()
        defer { lock.unlock() }
        if active { hingeState = state }
    }

    func latest() -> NativeCapturedFrame? {
        lock.lock()
        defer { lock.unlock() }
        guard let frame, let hingeState else { return frame }
        let state = frame.deviceState
        return NativeCapturedFrame(
            pixelBuffer: frame.pixelBuffer, timestamp: frame.timestamp, wallClock: frame.wallClock,
            deviceState: RecordingDeviceState(
                width: state.width, height: state.height, orientation: state.orientation,
                screen: state.screen, hingeAngle: hingeState.angle,
                physicalOrientation: hingeState.orientation, tableMode: hingeState.tableMode,
                contentRect: state.contentRect
            ), contentSize: frame.contentSize
        )
    }
}
