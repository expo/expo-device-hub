import CryptoKit
import Foundation
import Network

/// One WebSocket connection. All state is confined to the server's queue.
final class StreamClient {
    let id = UUID()
    let connection: NWConnection

    fileprivate var buffer = Data()
    fileprivate var isWebSocket = false
    fileprivate var fragments = Data()

    init(connection: NWConnection) {
        self.connection = connection
    }
}

/// Serves the web client and the stream from a single port: plain HTTP for files, and a
/// WebSocket upgrade on `/stream`. One origin keeps it working behind TLS terminators such as
/// `tailscale serve`, which WebCodecs needs anywhere but localhost (secure contexts only).
///
/// Transport only: what to send each viewer, and at what bitrate, is decided per viewer (`Viewer`).
final class StreamServer {
    let queue = DispatchQueue(label: "simstream.server", qos: .userInteractive)
    var onConnect: ((StreamClient) -> Void)?
    var onDisconnect: ((StreamClient) -> Void)?
    var onMessage: ((StreamClient, [String: Any]) -> Void)?

    private let listener: NWListener
    private let webRoot: URL
    private var clients: [UUID: StreamClient] = [:]
    private let maxMessageSize = 1 << 20

    init(port: UInt16, webRoot: URL) throws {
        self.webRoot = webRoot
        let params = NWParameters.tcp
        (params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options)?.noDelay = true
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] in self?.accept($0) }
        listener.startOrExit(queue: queue, port: port)
    }

    private func accept(_ connection: NWConnection) {
        let client = StreamClient(connection: connection)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                if self?.clients.removeValue(forKey: client.id) != nil {
                    self?.onDisconnect?(client)
                }
            default:
                break
            }
        }
        connection.start(queue: queue)
        read(client)
    }

    private func read(_ client: StreamClient) {
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data { client.buffer.append(data) }
            if client.isWebSocket { parseFrames(client) } else { parseRequest(client) }
            if error != nil || isComplete {
                client.connection.cancel()
            } else {
                read(client)
            }
        }
    }

    // MARK: HTTP

    private func parseRequest(_ client: StreamClient) {
        guard let end = client.buffer.range(of: Data("\r\n\r\n".utf8)) else {
            if client.buffer.count > 64 * 1024 { client.connection.cancel() }
            return
        }
        let head = String(decoding: client.buffer[..<end.lowerBound], as: UTF8.self)
        client.buffer.removeSubrange(..<end.upperBound)

        let lines = head.components(separatedBy: "\r\n")
        let target = lines.first?.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        let path = String(target.split(separator: "?").first ?? "/")
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }

        if path == "/stream", headers["upgrade"]?.lowercased() == "websocket", let key = headers["sec-websocket-key"] {
            upgrade(client, key: key)
        } else {
            serveFile(path, to: client)
        }
    }

    private func serveFile(_ path: String, to client: StreamClient) {
        let path = path == "/" ? "/index.html" : path
        let file = webRoot.appendingPathComponent(path)
        let body = path.contains("..") ? nil : try? Data(contentsOf: file)
        let status = body == nil ? "404 Not Found" : "200 OK"
        let type = switch file.pathExtension {
        case "html": "text/html; charset=utf-8"
        case "js": "text/javascript"
        case "css": "text/css"
        default: "application/octet-stream"
        }
        let payload = body ?? Data("not found".utf8)
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(payload.count)\r\n" +
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        let connection = client.connection
        connection.send(content: Data(head.utf8) + payload, completion: .contentProcessed { _ in connection.cancel() })
    }

    // MARK: WebSocket (RFC 6455, just what browsers need)

    private func upgrade(_ client: StreamClient, key: String) {
        let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8)))
            .base64EncodedString()
        let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: \(accept)\r\n\r\n"
        client.connection.send(content: Data(response.utf8), completion: .idempotent)
        client.isWebSocket = true
        clients[client.id] = client
        onConnect?(client)
        parseFrames(client)
    }

    private func parseFrames(_ client: StreamClient) {
        while client.buffer.count >= 2 {
            let b = client.buffer
            let s = b.startIndex
            let fin = b[s] & 0x80 != 0
            let opcode = b[s] & 0x0F
            let masked = b[s + 1] & 0x80 != 0
            var length = Int(b[s + 1] & 0x7F)
            var offset = 2
            if length == 126 {
                guard b.count >= 4 else { return }
                length = Int(b[s + 2]) << 8 | Int(b[s + 3])
                offset = 4
            } else if length == 127 {
                guard b.count >= 10 else { return }
                length = (2..<10).reduce(0) { $0 << 8 | Int(b[s + $1]) }
                offset = 10
            }
            guard length <= maxMessageSize else {
                client.connection.cancel()
                return
            }
            let maskStart = s + offset
            if masked { offset += 4 }
            guard b.count >= offset + length else { return }

            var payload = Data(b[(s + offset)..<(s + offset + length)])
            if masked {
                let mask = [b[maskStart], b[maskStart + 1], b[maskStart + 2], b[maskStart + 3]]
                payload.withUnsafeMutableBytes { bytes in
                    for i in 0..<bytes.count { bytes[i] ^= mask[i & 3] }
                }
            }
            client.buffer.removeFirst(offset + length)

            switch opcode {
            case 0x0, 0x1, 0x2:
                client.fragments.append(payload)
                if fin {
                    let message = client.fragments
                    client.fragments = Data()
                    if let json = (try? JSONSerialization.jsonObject(with: message)) as? [String: Any] {
                        onMessage?(client, json)
                    }
                }
            case 0x8:
                client.connection.send(content: Self.frame(0x8, Data()), completion: .contentProcessed { _ in
                    client.connection.cancel()
                })
                return
            case 0x9:
                client.connection.send(content: Self.frame(0xA, payload), completion: .idempotent)
            default:
                break
            }
        }
    }

    private static func frame(_ opcode: UInt8, _ payload: Data, reserving extra: Int = 0) -> Data {
        var frame = Data(capacity: 10 + payload.count + extra)
        frame.append(0x80 | opcode)
        let length = payload.count + extra
        if length < 126 {
            frame.append(UInt8(length))
        } else if length <= 0xFFFF {
            frame.append(126)
            frame.appendBE(UInt16(length))
        } else {
            frame.append(127)
            frame.appendBE(UInt64(length))
        }
        frame.append(payload)
        return frame
    }

    // MARK: Sending

    func sendFrame(_ frame: EncodedFrame, to client: StreamClient) {
        if frame.isKeyframe, let config = frame.config {
            sendJSON([
                "t": "config", "codec": config.codec, "width": config.width, "height": config.height,
                "displayWidth": frame.displaySize?.width ?? config.width,
                "displayHeight": frame.displaySize?.height ?? config.height,
                "description": config.description.base64EncodedString(),
            ], to: client)
        }
        // Header: u8 flags | u32 seq | f64 captureMs | f64 encodedMs | u32 inputSeq  (little endian)
        let headerSize = 25
        var packet = Self.frame(0x2, Data(), reserving: headerSize + frame.data.count)
        packet.append(frame.isKeyframe ? 1 : 0)
        packet.appendLE(frame.seq)
        packet.appendLE(frame.captureMs.bitPattern)
        packet.appendLE(frame.encodedMs.bitPattern)
        packet.appendLE(frame.inputSeq)
        packet.append(frame.data)
        client.connection.send(content: packet, completion: .idempotent)
    }

    func sendJSON(_ object: [String: Any], to client: StreamClient) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        client.connection.send(content: Self.frame(0x1, data), completion: .idempotent)
    }
}

private extension NWListener {
    /// NWListener reports bind failures (e.g. port already in use) asynchronously; without a state
    /// handler they fail silently and clients end up talking to whatever owns the port.
    func startOrExit(queue: DispatchQueue, port: UInt16) {
        stateUpdateHandler = { state in
            guard case .failed(let error) = state else { return }
            log("error: listener on port \(port) failed: \(error)")
            if case .posix(.EADDRINUSE) = error {
                log("port \(port) is in use (`lsof -nP -iTCP:\(port) -sTCP:LISTEN`); pick another with --port")
            }
            exit(1)
        }
        start(queue: queue)
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
    }

    mutating func appendBE<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }
}
