import Foundation

public enum H264AnnexB {
    public static func convert(avcc: Data, parameterSets: [Data], keyframe: Bool) -> Data? {
        var output = Data()
        if keyframe {
            for parameterSet in parameterSets {
                output.append(contentsOf: [0, 0, 0, 1])
                output.append(parameterSet)
            }
        }
        var index = avcc.startIndex
        while index + 4 <= avcc.endIndex {
            let length = avcc[index..<index + 4].reduce(0) { ($0 << 8) | Int($1) }
            index += 4
            guard length > 0, index + length <= avcc.endIndex else { return nil }
            output.append(contentsOf: [0, 0, 0, 1])
            output.append(avcc[index..<index + length])
            index += length
        }
        return index == avcc.endIndex ? output : nil
    }
}
