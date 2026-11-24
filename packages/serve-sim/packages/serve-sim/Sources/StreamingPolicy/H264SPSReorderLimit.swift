import Foundation

/// Adds `max_num_reorder_frames = 0` to an H.264 SPS that has no VUI.
///
/// VideoToolbox's default-rate-control SPS omits the optional VUI. Without it, Chromium infers a
/// reorder window from the DPB size and holds about 14 frames before output, roughly 3 s on a
/// still screen. The caller must only use this when the encoder disabled frame reordering.
///
/// Only Baseline, Main, Extended, and 8-bit 4:2:0 High SPSs without scaling lists are rewritten.
/// An SPS that already has a VUI, an unknown layout, or a malformed NAL is returned unchanged.
/// The added VUI matches WebRTC's `SpsVuiRewriter`: no optional sections, then a bitstream
/// restriction with default limits, no reordering, and `max_dec_frame_buffering` equal to
/// `max_num_ref_frames`.
public enum H264SPSReorderLimit {
    static let maxSPSBytes = 4096

    public static func addingZeroReorder(to sps: Data) -> Data {
        guard let rewritten = rewrite([UInt8](sps)) else { return sps }
        return Data(rewritten)
    }

    private static func rewrite(_ nal: [UInt8]) -> [UInt8]? {
        guard nal.count >= 4, nal.count <= maxSPSBytes, nal[0] & 0x9f == 7,
              let rbsp = unescape(nal[1...]) else { return nil }
        var reader = BitReader(rbsp)
        guard let (vuiPosition, maxReferenceFrames) = try? parse(&reader),
              (try? reader.bit()) == 0,
              reader.isAtTrailingBits else { return nil }

        var writer = BitWriter()
        writer.copy(rbsp, bits: vuiPosition)
        writer.write(1) // vui_parameters_present_flag
        for _ in 0..<8 { writer.write(0) } // aspect ratio ... pic_struct_present_flag
        writer.write(1) // bitstream_restriction_flag
        writer.write(1) // motion_vectors_over_pic_boundaries_flag
        for value in [2, 1, 16, 16, 0, maxReferenceFrames] { writer.writeUE(value) }
        writer.write(1) // rbsp_stop_one_bit
        return [nal[0]] + escape(writer.bytes)
    }

    /// Reads up to `vui_parameters_present_flag` and returns its bit position.
    private static func parse(_ reader: inout BitReader) throws -> (Int, Int) {
        let profile = try reader.bits(8)
        _ = try reader.bits(16) // constraint flags, reserved bits, level_idc
        guard try reader.ue() <= 31 else { throw BitReader.Invalid() }
        switch profile {
        case 66, 77, 88:
            break
        case 100:
            guard try reader.ue() == 1, // chroma_format_idc 4:2:0
                  try reader.ue() == 0, try reader.ue() == 0 else { throw BitReader.Invalid() }
            _ = try reader.bit() // qpprime_y_zero_transform_bypass_flag
            guard try reader.bit() == 0 else { throw BitReader.Invalid() } // scaling matrix
        default:
            throw BitReader.Invalid()
        }
        guard try reader.ue() <= 12 else { throw BitReader.Invalid() } // log2_max_frame_num_minus4
        switch try reader.ue() { // pic_order_cnt_type
        case 0:
            guard try reader.ue() <= 12 else { throw BitReader.Invalid() }
        case 1:
            _ = try reader.bit()
            _ = try reader.ue()
            _ = try reader.ue()
            let cycle = try reader.ue()
            guard cycle <= 255 else { throw BitReader.Invalid() }
            for _ in 0..<cycle { _ = try reader.ue() }
        case 2:
            break
        default:
            throw BitReader.Invalid()
        }
        let maxReferenceFrames = try reader.ue()
        guard maxReferenceFrames <= 16 else { throw BitReader.Invalid() }
        _ = try reader.bit() // gaps_in_frame_num_value_allowed_flag
        _ = try reader.ue()
        _ = try reader.ue()
        if try reader.bit() == 0 { _ = try reader.bit() } // frame_mbs_only, mb_adaptive
        _ = try reader.bit() // direct_8x8_inference_flag
        if try reader.bit() == 1 { for _ in 0..<4 { _ = try reader.ue() } } // frame cropping
        return (reader.position, maxReferenceFrames)
    }

    /// Removes emulation-prevention bytes; rejects a 0x000003 that is not followed by 0-3.
    private static func unescape(_ bytes: ArraySlice<UInt8>) -> [UInt8]? {
        var output: [UInt8] = []
        var zeros = 0
        var index = bytes.startIndex
        while index < bytes.endIndex {
            let byte = bytes[index]
            if zeros >= 2 && byte == 3 {
                guard index + 1 < bytes.endIndex, bytes[index + 1] <= 3 else { return nil }
                zeros = 0
                index += 1
                continue
            }
            output.append(byte)
            zeros = byte == 0 ? zeros + 1 : 0
            index += 1
        }
        return output
    }

    private static func escape(_ rbsp: [UInt8]) -> [UInt8] {
        var output: [UInt8] = []
        var zeros = 0
        for byte in rbsp {
            if zeros >= 2 && byte <= 3 {
                output.append(3)
                zeros = 0
            }
            output.append(byte)
            zeros = byte == 0 ? zeros + 1 : 0
        }
        return output
    }
}

private struct BitReader {
    struct Invalid: Error {}

    private let bytes: [UInt8]
    private(set) var position = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    mutating func bit() throws -> Int {
        guard position < bytes.count * 8 else { throw Invalid() }
        let value = Int(bytes[position / 8] >> (7 - position % 8)) & 1
        position += 1
        return value
    }

    mutating func bits(_ count: Int) throws -> Int {
        var value = 0
        for _ in 0..<count { value = value << 1 | (try bit()) }
        return value
    }

    /// Unsigned Exp-Golomb. Signed values have the same length, so callers that skip them use this.
    mutating func ue() throws -> Int {
        var leadingZeros = 0
        while try bit() == 0 {
            leadingZeros += 1
            guard leadingZeros <= 31 else { throw Invalid() }
        }
        return (1 << leadingZeros) - 1 + (try bits(leadingZeros))
    }

    /// True when only `rbsp_stop_one_bit` and zero padding remain.
    var isAtTrailingBits: Bool {
        var probe = self
        guard (try? probe.bit()) == 1 else { return false }
        while probe.position < bytes.count * 8 {
            guard (try? probe.bit()) == 0 else { return false }
        }
        return bytes.count * 8 - position <= 8
    }
}

private struct BitWriter {
    private(set) var bytes: [UInt8] = []
    private var count = 0

    mutating func write(_ bit: Int) {
        if count % 8 == 0 { bytes.append(0) }
        if bit != 0 { bytes[bytes.count - 1] |= 0x80 >> UInt8(count % 8) }
        count += 1
    }

    mutating func copy(_ source: [UInt8], bits: Int) {
        for index in 0..<bits { write(Int(source[index / 8] >> (7 - index % 8)) & 1) }
    }

    mutating func writeUE(_ value: Int) {
        let code = value + 1
        let length = Int.bitWidth - code.leadingZeroBitCount
        for _ in 1..<length { write(0) }
        for shift in stride(from: length - 1, through: 0, by: -1) { write(code >> shift & 1) }
    }
}
