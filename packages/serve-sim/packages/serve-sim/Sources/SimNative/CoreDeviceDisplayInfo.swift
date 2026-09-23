import Foundation
import CoreDeviceShim
import StreamingPolicy

struct CoreDeviceDisplayState: Equatable {
    let screenID: UInt32
    let isActive: Bool
    let orientation: String?
}

/// CoreDevice's active flag tracks the selected panel even when the older
/// SimScreen backlight and orientation properties stop changing after a fold.
enum CoreDeviceDisplayInfo {
    static func read(udid: String) async throws -> [CoreDeviceDisplayState]? {
        guard SSCoreDeviceDisplayAvailable() else { return nil }
        let device = try await CoreDeviceBridge.shared.remoteDevice(udid: udid)
        guard let infoMetadata = SSCoreDeviceDisplayInfoMetadata(),
              let displayMetadata = SSCoreDeviceDisplayMetadata() else { return nil }

        let result = UnsafeMutableRawPointer.allocate(
            byteCount: Int(SSCoreDeviceValueSize(infoMetadata)), alignment: 16
        )
        defer { result.deallocate() }
        try await device.displayInfo(result)
        defer { SSCoreDeviceDestroyValue(result, infoMetadata) }

        // Opening the actual runtime type lets Swift traverse and release
        // Array<Display> using its real stride and value witnesses.
        func readDisplays<T>(_: T.Type) -> [CoreDeviceDisplayState] {
            guard let array = SSCoreDeviceDisplays(result) else { return [] }
            let values = unsafeBitCast(array, to: [T].self)
            return values.map { value in
                var value = value
                return withUnsafeMutablePointer(to: &value) { pointer in
                    let rawOrientation = SSCoreDeviceDisplayOrientation(pointer)
                    let rotation = unsafeBitCast(rawOrientation, to: String.self)
                    return CoreDeviceDisplayState(
                        screenID: SSCoreDeviceDisplayID(pointer),
                        isActive: SSCoreDeviceDisplayActive(pointer) == 1,
                        orientation: SimulatorScreenOrientation.name(forRotation: rotation)
                    )
                }
            }
        }
        let type = unsafeBitCast(displayMetadata, to: Any.Type.self)
        return _openExistential(type, do: readDisplays)
    }
}
