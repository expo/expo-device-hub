import Foundation
import ObjectiveC

/// Connect/disconnect the simulator's hardware keyboard, the setting behind
/// Simulator.app's I/O → Keyboard → Connect Hardware Keyboard (⌘⇧K). When the
/// hardware keyboard is disconnected the guest shows its on-screen keyboard.
///
/// Drives the per-device CoreSimulator API
/// `-[SimDevice setHardwareKeyboardEnabled:keyboardType:error:]`, so it applies
/// only to the target device (no machine-wide `defaults` write).
enum HardwareKeyboard {
    static func setEnabled(udid: String, enabled: Bool) throws -> Bool {
        SimFrameworks.load()
        guard let device = FrameCapture.findSimDevice(udid: udid) else {
            throw NSError(domain: "HardwareKeyboard", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Device \(udid) not found"])
        }
        let sel = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")
        guard device.responds(to: sel) else {
            throw NSError(domain: "HardwareKeyboard", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "setHardwareKeyboardEnabled: not available on this CoreSimulator"])
        }
        typealias Fn = @convention(c) (
            AnyObject, Selector, ObjCBool, Int, AutoreleasingUnsafeMutablePointer<NSError?>
        ) -> ObjCBool
        let imp = device.method(for: sel)
        let fn = unsafeBitCast(imp, to: Fn.self)
        var error: NSError?
        let ok = fn(device, sel, ObjCBool(enabled), 0, &error)
        if let error { throw error }
        return ok.boolValue
    }
}
