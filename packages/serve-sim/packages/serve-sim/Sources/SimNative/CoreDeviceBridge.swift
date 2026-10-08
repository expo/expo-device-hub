import Foundation
import CoreDeviceShim
import StreamingPolicy

/// A narrow adapter for CoreDevice's private Swift API. Apple does not ship its
/// module interface, so the C target preserves the ABI through guarded symbol
/// trampolines. No private symbol is a load-time dependency of the Node addon.
actor CoreDeviceBridge {
    static let shared = CoreDeviceBridge()

    enum BridgeError: Error { case unavailable, deviceUnavailable, initializationTimedOut, resetDuringLookup }

    private var manager: CoreDeviceManagerObject?
    private let managerReadiness = SharedReadiness()
    private var capabilities = BootBoundCache<String, String, CoreDeviceCapabilityObject>()
    private var hingeSupport: [String: Bool] = [:]
    private var hingeResetGenerations: [String: UInt64] = [:]
    struct HingeState: Equatable, Sendable {
        var angle: Double?
        var orientation: String?
        var tableMode: Bool?
    }
    enum HingeField: Hashable { case orientation, tableMode }
    struct HingeCommand {
        let generation: UInt64
        let angleRevision: UInt64
        let needsAngleReadback: Bool
    }
    private struct HingeReadbackState {
        var revision: UInt64 = 0
        var pendingFields: Set<HingeField> = []
    }
    private var hingeStates: [String: HingeState] = [:]
    private var hingeStateRevisions: [String: UInt64] = [:]
    private var hingeReadbackStates: [String: HingeReadbackState] = [:]
    private let hingeAngleReader: (@Sendable (String) async -> Double?)?

    init(hingeAngleReader: (@Sendable (String) async -> Double?)? = nil) {
        self.hingeAngleReader = hingeAngleReader
    }

    func cachedHingeState(udid: String) -> HingeState {
        hingeStates[udid] ?? HingeState()
    }

    @discardableResult
    func updateHingeState(udid: String, command: HingeCommand? = nil, field: HingeField? = nil,
                          _ update: (inout HingeState) -> Void) -> Bool {
        guard command.map({ $0.generation == hingeResetGenerations[udid, default: 0] }) ?? true else { return false }
        update(&hingeStates[udid, default: HingeState()])
        hingeStateRevisions[udid, default: 0] &+= 1
        if let field {
            if let command, command.needsAngleReadback,
               command.angleRevision == hingeReadbackStates[udid, default: HingeReadbackState()].revision {
                hingeReadbackStates[udid, default: HingeReadbackState()].pendingFields.insert(field)
            } else {
                hingeReadbackStates[udid, default: HingeReadbackState()].pendingFields.remove(field)
            }
        }
        return true
    }

    func prepareHingeCommand(udid: String, readAngle: Bool = true) async -> HingeCommand? {
        let generation = hingeResetGenerations[udid, default: 0]
        let angleRevision = hingeReadbackStates[udid, default: HingeReadbackState()].revision
        let read: Bool
        if readAngle { read = await refreshHingeAngle(udid: udid) }
        else { read = false }
        guard hingeResetGenerations[udid, default: 0] == generation else { return nil }
        let currentRevision = hingeReadbackStates[udid, default: HingeReadbackState()].revision
        return HingeCommand(generation: generation,
                            angleRevision: currentRevision,
                            needsAngleReadback: !read && angleRevision == currentRevision)
    }

    func updateHingeAngle(udid: String, angle: Double) {
        updateHingeState(udid: udid) { $0.angle = angle }
        confirmHingeAngle(udid: udid)
    }

    private func confirmHingeAngle(udid: String) {
        hingeReadbackStates[udid, default: HingeReadbackState()].revision &+= 1
        hingeReadbackStates[udid, default: HingeReadbackState()].pendingFields.removeAll()
    }

    /// CoreDevice's capability objects belong to a simulator boot. A new capture
    /// session must not reuse them after that device boots again in the same
    /// serve-sim process.
    ///
    /// Only this device's capabilities and lookups reset. The shared manager
    /// stays: after a reboot it lists the device again, and other devices keep
    /// using it.
    func resetForNewCapture(udid: String) {
        capabilities.reset(scope: udid)
        hingeResetGenerations[udid, default: 0] &+= 1
        hingeSupport.removeValue(forKey: udid)
        hingeStates.removeValue(forKey: udid)
        hingeStateRevisions.removeValue(forKey: udid)
        hingeReadbackStates.removeValue(forKey: udid)
    }

    func hingeState(udid: String) async -> HingeState {
        _ = await refreshHingeAngle(udid: udid)
        return cachedHingeState(udid: udid)
    }

    // @ref LLP 0004#confirmed-hinge-state — reconcile readback without erasing newer command fields
    private func refreshHingeAngle(udid: String) async -> Bool {
        let generation = hingeResetGenerations[udid, default: 0]
        let previous = hingeStates[udid]
        let revision = hingeStateRevisions[udid, default: 0]
        let angle: Double?
        if let hingeAngleReader { angle = await hingeAngleReader(udid) }
        else { angle = await readHingeAngle(udid: udid) }
        // Preserve newer commands, reads, and boot state across the native await.
        guard hingeResetGenerations[udid, default: 0] == generation,
              hingeStateRevisions[udid, default: 0] == revision else { return false }
        if let angle {
            let pending = hingeReadbackStates[udid]?.pendingFields ?? []
            updateHingeState(udid: udid) { state in
                if let oldAngle = previous?.angle, abs(oldAngle - angle) > 0.01 {
                    if !pending.contains(.orientation) { state.orientation = nil }
                    if !pending.contains(.tableMode) { state.tableMode = nil }
                }
                state.angle = angle
            }
            confirmHingeAngle(udid: udid)
            return true
        }
        // If readback is unavailable, retain the last individually successful
        // sends, including the portion of a preset applied before its failure.
        return false
    }

    func remoteDevice(udid: String) async throws -> CoreDeviceRemoteDevice {
        guard SSCoreDeviceInitialize() else { throw BridgeError.unavailable }
        let lookup = capabilities.beginLookup(scope: udid)
        if manager == nil {
            // Initializes resilient class metadata and field offsets before
            // using the class metadata's allocating initializer.
            _ = coreDeviceSharedManager()
            guard let managerMetadata = SSCoreDeviceSymbol("$s10CoreDevice0B7ManagerCN"),
                  let visibilityMetadata = SSCoreDeviceSymbol("$s10CoreDevice0B15VisibilityClassON"),
                  let visibilityType = unsafeBitCast(visibilityMetadata, to: Any.Type.self) as? any Hashable.Type
            else { throw BridgeError.unavailable }
            let managerType = unsafeBitCast(managerMetadata, to: CoreDeviceManagerObject.Type.self)
            let visibilitySet = Self.makeVisibilitySet(visibilityType)
            manager = withExtendedLifetime(visibilitySet) {
                let rawSet = withUnsafePointer(to: visibilitySet) {
                    UnsafeRawPointer($0).load(as: UnsafeMutableRawPointer.self)
                }
                // The private initializer consumes the Set. Keep the original
                // Any-owned value alive until initialization has completed.
                SSCoreDeviceRetainBridgeObject(rawSet)
                return managerType.create(connection: coreDeviceServiceConnection(), allowed: rawSet)
            }
        }
        guard let manager else { throw BridgeError.unavailable }
        do {
            try await managerReadiness.waitUntilReady {
                await self.managerIsInitialized()
            }
        } catch SharedReadiness.Failure.timedOut {
            throw BridgeError.initializationTimedOut
        }
        guard capabilities.isCurrent(lookup) else { throw BridgeError.resetDuringLookup }
        guard let device = manager.allDevices().first(where: { $0.identifier().uuidString.caseInsensitiveCompare(udid) == .orderedSame })
        else { throw BridgeError.deviceUnavailable }
        return device
    }

    private func managerIsInitialized() -> Bool {
        manager?.initialized() == true
    }

    private static func makeVisibilitySet<T: Hashable>(_: T.Type) -> Any {
        // Open Apple's actual enum type, using its allCases getter rather than
        // constructing enum tags or hashing a substitute Swift type.
        let cases = unsafeBitCast(coreDeviceVisibilityAllCases(), to: [T].self)
        return Set(cases)
    }

    func capability(udid: String, metadataSymbol: String, witnessSymbol: String) async throws -> CoreDeviceCapabilityObject {
        let key = "\(udid):\(metadataSymbol)"
        if let existing = capabilities[key] { return existing }
        let lookup = capabilities.beginLookup(scope: udid)
        let device = try await remoteDevice(udid: udid)
        guard capabilities.isCurrent(lookup) else { throw BridgeError.resetDuringLookup }
        guard let metadata = SSCoreDeviceSymbol(metadataSymbol),
              let witness = SSCoreDeviceSymbol(witnessSymbol)
        else { throw BridgeError.unavailable }
        let capability = CoreDeviceCapabilityObject()
        let emptyStaticMember = UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)
        defer { emptyStaticMember.deallocate() }
        // CapabilityStaticMember<T> is empty but resilient: its generic
        // method takes an address, actual T metadata, and its conformance.
        try await device.implementation(capability.storage, emptyStaticMember, metadata, witness)
        capability.initialized = true
        // An old lookup may resume after a new capture clears the cache.
        // Discard it instead of letting the next HID session reuse its handle.
        guard capabilities.store(capability, for: key, from: lookup) else { throw BridgeError.resetDuringLookup }
        return capability
    }

    func setHingeAngle(udid: String, angle: Double, command: HingeCommand? = nil) async -> Bool {
        let generation = command?.generation ?? hingeResetGenerations[udid, default: 0]
        guard hingeResetGenerations[udid, default: 0] == generation else { return false }
        guard angle.isFinite, (0...180).contains(angle) else { return false }
        guard let rawData = SSCoreDeviceHingeData(angle) else { return false }
        let data = Unmanaged<NSData>.fromOpaque(rawData).takeRetainedValue() as Data
        let sent = await sendControl(udid: udid, data: data)
        guard hingeResetGenerations[udid, default: 0] == generation else { return false }
        if sent { updateHingeAngle(udid: udid, angle: angle) }
        return sent
    }

    func setHingePose(udid: String, pose: String) async -> Bool {
        guard let command = await prepareHingeCommand(udid: udid, readAngle: false) else { return false }
        return await HingePoseControl.apply(
            pose,
            tableModeAvailable: { await self.tableModeAvailable(udid: udid) },
            setAngle: { await self.setHingeAngle(udid: udid, angle: $0, command: command) },
            setTableMode: { await self.setTableMode(udid: udid, enabled: $0, command: command) },
            setOrientation: { await self.setPhysicalOrientation(udid: udid, value: $0, command: command) },
            waitForLandscapeCover: {
                let clock = ContinuousClock()
                let deadline = clock.now.advanced(by: .milliseconds(1500))
                while clock.now < deadline {
                    if let displays = try? await CoreDeviceDisplayInfo.read(udid: udid),
                       displays.contains(where: { $0.screenID == 1 && $0.isActive && $0.orientation == "landscape_left" }) { break }
                    do { try await Task.sleep(for: .milliseconds(50)) }
                    catch { return false }
                }
                // Apps that lock portrait and missing optional display metadata
                // must still allow Tent after this best-effort readback.
                return true
            }
        )
    }

    func tableModeAvailable(udid: String) async -> Bool {
        guard SSCoreDeviceTableModeAvailable() else { return false }
        // Check the per-device capability as well as the exported symbols,
        // without sending a sensor event or moving the hinge.
        return (try? await capability(
            udid: udid,
            metadataSymbol: "$s10CoreDevice29UniversalHIDServiceCapabilityVN",
            witnessSymbol: "$s10CoreDevice29UniversalHIDServiceCapabilityVAA0bE0AAWP"
        )) != nil
    }

    func setTableMode(udid: String, enabled: Bool, command: HingeCommand? = nil) async -> Bool {
        let generation = command?.generation ?? hingeResetGenerations[udid, default: 0]
        guard hingeResetGenerations[udid, default: 0] == generation else { return false }
        // Older Xcodes can provide hinge/rotation controls without the table
        // sensor. Releasing an unavailable sensor is a no-op; enabling it must
        // still fail, and a real send failure must not be reported as success.
        guard SSCoreDeviceTableModeAvailable() else {
            fputs("[hid] CoreDevice Table Mode unavailable in this Xcode\n", stderr)
            if !enabled { updateHingeState(udid: udid, command: command, field: .tableMode) { $0.tableMode = false } }
            return !enabled
        }
        do {
            let metadataSymbol = "$s10CoreDevice29UniversalHIDServiceCapabilityVN"
            let capability = try await capability(
                udid: udid, metadataSymbol: metadataSymbol,
                witnessSymbol: "$s10CoreDevice29UniversalHIDServiceCapabilityVAA0bE0AAWP"
            )
            guard hingeResetGenerations[udid, default: 0] == generation else { return false }
            let sent = SSCoreDeviceSendTableMode(capability.storage, enabled)
            if sent { updateHingeState(udid: udid, command: command, field: .tableMode) { $0.tableMode = enabled } }
            if !sent { capabilities.removeValue(forKey: "\(udid):\(metadataSymbol)") }
            return sent
        } catch BridgeError.unavailable {
            fputs("[hid] CoreDevice Table Mode capability unavailable\n", stderr)
            guard hingeResetGenerations[udid, default: 0] == generation else { return false }
            if !enabled { updateHingeState(udid: udid, command: command, field: .tableMode) { $0.tableMode = false } }
            return !enabled
        } catch {
            fputs("[hid] CoreDevice Table Mode failed: \(error)\n", stderr)
            return false
        }
    }

    func setPhysicalOrientation(udid: String, value: String, command: HingeCommand? = nil) async -> Bool {
        let generation = command?.generation ?? hingeResetGenerations[udid, default: 0]
        guard hingeResetGenerations[udid, default: 0] == generation else { return false }
        guard ["portrait", "pud", "landscape-left", "landscape-right", "faceup", "facedown"].contains(value) else { return false }
        guard let rawData = value.withCString({ SSCoreDeviceOrientationData($0) }) else { return false }
        let data = Unmanaged<NSData>.fromOpaque(rawData).takeRetainedValue() as Data
        let sent = await sendControl(udid: udid, data: data)
        guard hingeResetGenerations[udid, default: 0] == generation else { return false }
        if sent { updateHingeState(udid: udid, command: command, field: .orientation) { $0.orientation = value } }
        return sent
    }

    func setOrientation(udid: String, deviceOrientation: UInt32, nativeRotation: Int = 0,
                        command: HingeCommand? = nil) async -> Bool {
        guard let value = SimulatorScreenOrientation.vendorControlValue(
                  forDeviceOrientation: deviceOrientation, nativeRotation: nativeRotation
              ) else { return false }
        return await setPhysicalOrientation(udid: udid, value: value, command: command)
    }

    private func sendControl(udid: String, data: Data) async -> Bool {
        do {
            let capability = try await capability(
                udid: udid,
                metadataSymbol: "$s10CoreDevice26VendorDefinedHIDCapabilityVN",
                witnessSymbol: "$s10CoreDevice26VendorDefinedHIDCapabilityVAA0B10CapabilityAAWP"
            )
            let words = unsafeBitCast(data, to: (UInt64, UInt64).self)
            let sent = withExtendedLifetime(data) {
                SSCoreDeviceSendControl(capability.storage, words.0, words.1)
            }
            if !sent { capabilities.removeValue(forKey: "\(udid):$s10CoreDevice26VendorDefinedHIDCapabilityVN") }
            return sent
        } catch {
            fputs("[hid] CoreDevice control unavailable: \(error)\n", stderr)
            return false
        }
    }

    func supportsHingeAngle(udid: String) async -> Bool {
        guard #available(macOS 15.0, *) else { return false }
        if let supported = hingeSupport[udid] { return supported }
        let generation = hingeResetGenerations[udid, default: 0]
        do {
            let supported = try await withMotionManager(udid: udid) { SSCoreDeviceMotionSupportsHinge($0) }
            guard hingeResetGenerations[udid, default: 0] == generation else { return false }
            hingeSupport[udid] = supported
            return supported
        } catch {
            // MonitorMotion is absent on ordinary nonfoldable simulators.
            return false
        }
    }

    @available(macOS 15.0, *)
    func withMotionManager<Result>(
        udid: String, body: (UnsafeMutableRawPointer) async throws -> Result
    ) async throws -> Result {
        guard SSCoreDeviceMotionAvailable(),
              let managerMetadata = SSCoreDeviceMotionManagerMetadata(),
              let errorMetadata = SSCoreDeviceErrorMetadata(),
              let callPointer = SSCoreDeviceMotionManagerPointer()
        else { throw BridgeError.unavailable }
        let capability = try await capability(
            udid: udid,
            metadataSymbol: "$s10CoreDevice23MonitorMotionCapabilityVN",
            witnessSymbol: "$s10CoreDevice23MonitorMotionCapabilityVAA0bE0AAWP"
        )
        let result = UnsafeMutableRawPointer.allocate(byteCount: Int(SSCoreDeviceValueSize(managerMetadata)), alignment: 16)
        let errorBuffer = UnsafeMutableRawPointer.allocate(byteCount: Int(SSCoreDeviceValueSize(errorMetadata)), alignment: 16)
        defer { result.deallocate(); errorBuffer.deallocate() }
        // The real resilient error is written into `error`. An empty
        // typed error preserves the async failure flag without interpreting
        // Apple's private CoreDeviceError layout in Swift.
        typealias MotionCall = @convention(thin) (UnsafeMutableRawPointer, UnsafeMutableRawPointer, UnsafeRawPointer, UnsafeRawPointer, UnsafeRawPointer) async throws(CoreDeviceCallFailed) -> Void
        let call = unsafeBitCast(callPointer, to: MotionCall.self)
        do {
            try await call(result, errorBuffer,
                           capability.storage.load(fromByteOffset: 24, as: UnsafeRawPointer.self),
                           capability.storage.load(fromByteOffset: 32, as: UnsafeRawPointer.self),
                           capability.storage)
        } catch {
            SSCoreDeviceDestroyValue(errorBuffer, errorMetadata)
            throw error
        }
        defer { SSCoreDeviceDestroyValue(result, managerMetadata) }
        return try await body(result)
    }

}

private struct CoreDeviceCallFailed: Error {}

// These types supply the Swift calling convention only. Objects and protocol
// metadata always come from CoreDevice; no instance of a substitute is made.
private protocol CoreDeviceServiceConnection {}
private protocol CoreDeviceOpaqueCapability {}

@_silgen_name("SSCDShared")
private func coreDeviceSharedManager() -> CoreDeviceManagerObject
@_silgen_name("SSCDConnection")
private func coreDeviceServiceConnection() -> any CoreDeviceServiceConnection
@_silgen_name("SSCDVisibilityAllCases")
private func coreDeviceVisibilityAllCases() -> UnsafeRawPointer

private class CoreDeviceManagerObject {
    @_silgen_name("SSCDCreateManager")
    static func create(connection: __owned any CoreDeviceServiceConnection, allowed: UnsafeRawPointer) -> CoreDeviceManagerObject
    @_silgen_name("SSCDAllDevices")
    final func allDevices() -> [CoreDeviceRemoteDevice]
    @_silgen_name("SSCDInitialized")
    final func initialized() -> Bool
}

class CoreDeviceRemoteDevice {
    @_silgen_name("SSCDIdentifier")
    final func identifier() -> UUID
    @_silgen_name("SSCDImplementation")
    final func implementation(_ result: UnsafeMutableRawPointer, _ empty: UnsafeRawPointer, _ metadata: UnsafeRawPointer, _ witness: UnsafeRawPointer) async throws
    @_silgen_name("SSCDDisplayInfo")
    final func displayInfo(_ result: UnsafeMutableRawPointer) async throws
}

final class CoreDeviceCapabilityObject {
    let storage = UnsafeMutableRawPointer.allocate(byteCount: MemoryLayout<any CoreDeviceOpaqueCapability>.size, alignment: MemoryLayout<any CoreDeviceOpaqueCapability>.alignment)
    var initialized = false

    deinit {
        if initialized {
            // Swift destroys the existential using the actual implementation's
            // metadata, including boxed values if Apple changes the type.
            storage.assumingMemoryBound(to: (any CoreDeviceOpaqueCapability).self).deinitialize(count: 1)
        }
        storage.deallocate()
    }
}
