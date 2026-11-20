import CoreDeviceShim
import CoreVideo
import Foundation
import Network

protocol PhysicalStreamSession: AnyObject, Sendable {
    func start(onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
               onEnd: @escaping @Sendable (String) -> Void) async throws
    func stop() async
}

final class CoreDeviceMediaStreamSession: PhysicalStreamSession, @unchecked Sendable {
    static let requiredDeviceStates = [
        "com.apple.coredevice.developerModeEnabledIfRequired",
        "com.apple.coredevice.coreDeviceServicesLoaded",
        "com.apple.coredevice.extendedDeviceInfoLoaded",
        "com.apple.coredevice.remoteServiceDiscoveryTrustedConnectivityAvailable",
        "com.apple.coredevice.secureNetworkingAvailable",
    ]
    static let negotiatorMode = 5
    static let clientName = "CoreDeviceScreenSharing"

    struct Timings: CustomStringConvertible {
        var connected: TimeInterval = 0
        var asserted: TimeInterval = 0
        var supported: TimeInterval = 0
        var offered: TimeInterval = 0
        var started: TimeInterval = 0
        var receiving: TimeInterval = 0
        var description: String {
            String(format: "connect %.3f s, assertion %.3f s, support %.3f s, offer %.3f s, start %.3f s, receiving %.3f s",
                   connected, asserted, supported, offered, started, receiving)
        }
    }

    let device: CoreDeviceRemoteDevice
    private(set) var timings = Timings()
    private(set) var streamID: UInt32?
    private(set) var negotiated: [String: Any] = [:]
    private let receiver = SSMediaStreamReceiver()
    private var assertion: CoreDeviceUsageAssertionObject?
    private let lock = NSLock()
    private var stopping = false
    private let loopEnded = DispatchSemaphore(value: 0)
    private var loopRunning = false
    private var ended = false
    private var onEnd: (@Sendable (String) -> Void)?
    private let log: @Sendable (String) -> Void
    var onDatagram: (@Sendable (Data) -> Void)?

    init(device: CoreDeviceRemoteDevice, log: @escaping @Sendable (String) -> Void) {
        self.device = device
        self.log = log
    }

    private var isStopping: Bool { lock.withLock { stopping } }

    private func end(_ cause: String) {
        let handler: (@Sendable (String) -> Void)? = lock.withLock {
            guard !stopping, !ended else { return nil }
            ended = true
            return onEnd
        }
        guard let handler else { return }
        log("media stream ended: \(cause)")
        handler(cause)
    }

    func start(onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
               onEnd: @escaping @Sendable (String) -> Void) async throws {
        lock.withLock { self.onEnd = onEnd }
        let began = ProcessInfo.processInfo.systemUptime
        func mark(_ path: WritableKeyPath<Timings, TimeInterval>) {
            timings[keyPath: path] = ProcessInfo.processInfo.systemUptime - began
        }

        try await CoreDeviceMediaStreamCalls.connect(device)
        mark(\.connected)
        let assertion = try await CoreDeviceMediaStreamCalls.acquireAssertion(
            device, reason: "serve-sim screen stream",
            requirements: ["deviceStates": Self.requiredDeviceStates.map { ["identifier": $0] }, "capabilities": [Any]()]
        )
        self.assertion = assertion
        assertion.registerInvalidationHandler(queue: CoreDeviceMediaStreamCalls.queue) { [weak self] error in
            self?.end("usage assertion invalidated: \(error.map { "\($0)" } ?? "no error")")
        }
        mark(\.asserted)

        let support = try CoreDeviceMediaStreamCalls.jsonObject(try await CoreDeviceMediaStreamCalls.supportInfo(device))
        guard let clientFeatures = ((support as? [String: Any])?["client"] as? [String: Any])?["supportedFeatures"] as? NSNumber else {
            throw CoreDeviceMediaStreamError("media stream support info had no client features")
        }
        mark(\.supported)

        let info = try CoreDeviceMediaStreamCalls.deviceInfo(device)
        guard let tunnel = Self.deviceInfoValue(try CoreDeviceMediaStreamCalls.jsonObject(info), key: "tunnelIPAddressString") as? String,
              !tunnel.isEmpty else { throw CoreDeviceMediaStreamError("device has no tunnel address") }
        guard let localAddress = receiver.bind(forTunnel: tunnel) else {
            throw CoreDeviceMediaStreamError("no route to tunnel \(tunnel)")
        }

        var values = CoreDeviceMediaStreamCalls.negotiatorOptions(for: info)
        values[CoreDeviceMediaStreamCalls.clientNameKey] = Self.clientName
        values[CoreDeviceMediaStreamCalls.clientSessionIDKey] = UUID()
        values["avcMediaStreamOptionCallID"] = UUID().uuidString
        guard let negotiator = SSMediaStreamNegotiator(values, Self.negotiatorMode), let offer = SSMediaStreamOffer(negotiator) else {
            throw CoreDeviceMediaStreamError("AVConference negotiator unavailable")
        }
        var options: [String: Any] = [:]
        for (key, value) in values {
            if let coded = try CoreDeviceMediaStreamCalls.codableValueJSON(value) { options[key] = coded }
        }
        mark(\.offered)

        let request: [String: Any] = [
            "timeout": 15, "type": "video", "direction": "output",
            "negotiatorOffer": offer.base64EncodedString(), "clientSupportedFeatures": clientFeatures,
            "receiverIP": localAddress, "receiverPort": receiver.reservedPort, "options": options,
        ]
        let response = try CoreDeviceMediaStreamCalls.jsonObject(try await CoreDeviceMediaStreamCalls.startStream(device, request: request))
        guard let answer = response as? [String: Any], let connection = answer["connection"] as? [String: Any],
              let config = connection["streamConfig"] as? [String: Any],
              let streamID = (config["StreamInputID"] as? NSNumber)?.uint32Value else {
            throw CoreDeviceMediaStreamError("start response was not readable")
        }
        self.streamID = streamID
        mark(\.started)

        guard let answerBase64 = answer["negotiatorAnswer"] as? String, let answerData = Data(base64Encoded: answerBase64),
              let negotiated = SSMediaStreamApplyAnswer(negotiator, answerData) as? [String: Any] else {
            throw CoreDeviceMediaStreamError("negotiator refused the answer")
        }
        self.negotiated = negotiated
        guard (negotiated["vcMediaStreamSRTPCipherSuite"] as? NSNumber)?.intValue == 0 else {
            throw CoreDeviceMediaStreamError("stream is encrypted")
        }
        guard let remoteSSRC = (config["RemoteSSRC"] as? NSNumber)?.uint32Value,
              let sender = connection["sender"] as? [String: Any], let receiverInfo = connection["receiver"] as? [String: Any],
              let senderAddress = (sender["ipv6Address"] as? String).flatMap(IPv6Address.init),
              let senderPort = (sender["port"] as? NSNumber)?.uint16Value,
              let receiverPort = (receiverInfo["port"] as? NSNumber)?.uint16Value,
              let local = IPv6Address(localAddress) else {
            throw CoreDeviceMediaStreamError("stream endpoints were not readable")
        }
        receiver.releaseReservedSocket()
        let adopted = try CoreDeviceMediaStreamCalls.sharedSocketDictionary(
            source: local, port: receiverPort, remote: senderAddress, remotePort: senderPort
        ) { [receiver] in receiver.adoptSharedSockets($0) }
        guard adopted else { throw CoreDeviceMediaStreamError("no shared socket for the stream") }
        mark(\.receiving)

        let device = self.device
        let loop = CoreDeviceMediaStreamReceiveLoop(
            receiver: receiver, remoteSSRC: remoteSSRC, onFrame: onFrame, log: log,
            isStopping: { [weak self] in self?.isStopping ?? true },
            isDeviceConnected: { Self.isConnected(device) }
        )
        loop.onDatagram = onDatagram
        lock.withLock { loopRunning = true }
        Thread.detachNewThread { [weak self, loopEnded] in
            let cause = loop.run()
            loopEnded.signal()
            if let cause { self?.end(cause) }
        }
    }

    static func isConnected(_ device: CoreDeviceRemoteDevice) -> Bool {
        guard let info = try? CoreDeviceMediaStreamCalls.jsonObject(try CoreDeviceMediaStreamCalls.deviceInfo(device)),
              let state = deviceInfoValue(info, key: "state") as? String else { return true }
        return state == "connected"
    }

    func stop() async {
        let waitForLoop = lock.withLock {
            stopping = true
            return loopRunning
        }
        if waitForLoop { await waitForLoopEnd() }
        if let streamID {
            do { _ = try await CoreDeviceMediaStreamCalls.stopStream(device, identifiers: [streamID]) }
            catch { log("stop stream \(streamID) failed: \(error)") }
        }
        assertion?.releaseAssertion()
        assertion = nil
        receiver.close()
    }

    private func waitForLoopEnd() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async { [loopEnded] in
                _ = loopEnded.wait(timeout: .now() + 1)
                continuation.resume()
            }
        }
    }

    static func deviceInfoValue(_ deviceInfo: Any, key: String) -> Any? {
        guard let values = (deviceInfo as? [String: Any])?["values"] as? [[String: Any]] else { return nil }
        return values.first { ($0["descriptorIdentifier"] as? [String: Any])?["key"] as? String == key }?["value"]
    }
}

final class CoreDeviceMediaStreamReceiveLoop: @unchecked Sendable {
    static let silenceLimit: TimeInterval = 5
    static let presenceCheckInterval: TimeInterval = 1

    private let receiver: SSMediaStreamReceiver
    private let remoteSSRC: UInt32
    private let onFrame: (CVPixelBuffer) -> Void
    private let log: (String) -> Void
    private let isStopping: () -> Bool
    private let isDeviceConnected: () -> Bool
    private let parser = HEVCRTPReceiver()
    private let decoder = HEVCDecoder()
    private var lastReport = 0.0
    private var lastKeyframeRequest = 0.0
    private var lastDatagram = ProcessInfo.processInfo.systemUptime
    private var lastPresenceCheck = 0.0
    var onDatagram: ((Data) -> Void)?

    init(receiver: SSMediaStreamReceiver, remoteSSRC: UInt32, onFrame: @escaping (CVPixelBuffer) -> Void,
         log: @escaping (String) -> Void, isStopping: @escaping () -> Bool,
         isDeviceConnected: @escaping () -> Bool) {
        self.receiver = receiver
        self.remoteSSRC = remoteSSRC
        self.onFrame = onFrame
        self.log = log
        self.isStopping = isStopping
        self.isDeviceConnected = isDeviceConnected
        parser.onAccessUnit = { [decoder] unit in decoder.decode(unit.nals, timestamp: unit.timestamp) }
        parser.onLoss = { [decoder] in decoder.invalidate() }
        decoder.onFrame = onFrame
        decoder.onFailure = { log("HEVC: \($0)") }
        decoder.onConfiguration = log
    }

    func run() -> String? {
        let cause = receiveUntilEnd()
        if cause == nil { _ = receiver.send(parser.report(receiver: remoteSSRC, bye: true)) }
        return cause
    }

    private func receiveUntilEnd() -> String? {
        while !isStopping() {
            var failed = ObjCBool(false)
            let datagram = receiver.receive(withTimeout: 5, failed: &failed)
            if failed.boolValue { return "the stream socket failed" }
            let now = ProcessInfo.processInfo.systemUptime
            if let datagram {
                lastDatagram = now
                onDatagram?(datagram)
                parser.receive(datagram)
            }
            parser.flushPending()
            if parser.senderEnded { return "the phone ended the stream" }
            if let cause = silenceCause(now: now) { return cause }
            guard parser.source != nil else { continue }
            let requesting = decoder.needsKeyframe && now - lastKeyframeRequest >= 0.5
            if now - lastReport >= 1 || requesting, receiver.send(parser.report(receiver: remoteSSRC, requestKeyframe: requesting)) {
                lastReport = now
                if requesting { lastKeyframeRequest = now }
            }
        }
        return nil
    }

    // @ref LLP 0026#ending-device-disconnected — the phone streams continuously, so silence means it went away.
    private func silenceCause(now: TimeInterval) -> String? {
        let silence = now - lastDatagram
        if silence >= Self.silenceLimit { return String(format: "no packets for %.1f s", silence) }
        guard silence >= Self.presenceCheckInterval, now - lastPresenceCheck >= Self.presenceCheckInterval else { return nil }
        lastPresenceCheck = now
        return isDeviceConnected() ? nil : "the phone is no longer connected"
    }
}
