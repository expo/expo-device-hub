import Foundation
import StreamingPolicy

struct NativeScreenshot: Sendable {
  let data: Data
  let metadata: NativeScreenshotMetadata
}

/// One snapshot from the selected surface and its final encoded PNG, with no additional device reads.
struct NativeScreenshotMetadata: Sendable {
  let width: Int
  let height: Int
  let displayRotation: String?
  let screen: RecordingScreen?

  func json() throws -> String {
    var object: [String: Any] = [
      "width": width, "height": height,
      "displayRotation": displayRotation.map { $0 as Any } ?? NSNull(),
    ]
    if let screen { object["screen"] = screen.rawValue }
    return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }

  static func rotation(_ orientation: String?) -> String? {
    switch orientation {
    case "portrait": return "portrait"
    case "portrait_upside_down": return "portrait-upside-down"
    case "landscape_left": return "landscape-left"
    case "landscape_right": return "landscape-right"
    default: return nil
    }
  }
}
