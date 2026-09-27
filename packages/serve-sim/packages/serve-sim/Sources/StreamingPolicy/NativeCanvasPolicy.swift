public struct NativeCanvasSize: Equatable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

public enum NativeCanvasPolicy {
    public static func canvas(for panels: [NativeCanvasSize]) -> NativeCanvasSize? {
        let valid = panels.filter { $0.width > 0 && $0.height > 0 }
        guard let first = valid.first else { return nil }
        let bounds = valid.dropFirst().reduce(first) { canvas, panel in
            NativeCanvasSize(width: max(canvas.width, panel.width),
                             height: max(canvas.height, panel.height))
        }
        return NativeCanvasSize(width: bounds.width + bounds.width % 2,
                                height: bounds.height + bounds.height % 2)
    }
}
