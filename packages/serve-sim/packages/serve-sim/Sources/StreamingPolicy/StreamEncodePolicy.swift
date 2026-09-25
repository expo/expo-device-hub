import Foundation

public enum StreamEncodePolicy {
    /// Long edge a session may encode at, 0 to not scale.
    ///
    /// For H.264 the bound is the negotiated level's frame size, past which the encoder
    /// produces nothing at all (see `H264LevelPolicy`). An explicit `--max-dimension` is
    /// clamped to it too: asking for more than the level allows yields no picture rather
    /// than a bigger one. Other codecs have no level to honour.
    public static func encodeMaxLongEdge(
        configuredMaxDimension: Int,
        codecName: String,
        sourceWidth: Int,
        sourceHeight: Int,
        levelIdc: Int
    ) -> Int {
        let configured = max(0, configuredMaxDimension)
        let levelLongEdge = levelMaxLongEdge(
            codecName: codecName,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            levelIdc: levelIdc
        )
        guard configured > 0 else { return levelLongEdge }
        // 0 from the level policy means the surface already fits.
        return levelLongEdge > 0 ? min(configured, levelLongEdge) : configured
    }

    /// The level's bound alone, 0 when no level binds. Reported separately from the applied
    /// ceiling so a smaller picture can be attributed to the level only when it caused it.
    public static func levelMaxLongEdge(
        codecName: String,
        sourceWidth: Int,
        sourceHeight: Int,
        levelIdc: Int
    ) -> Int {
        guard StreamCodecPolicy.isH264(codecName) else { return 0 }
        return H264LevelPolicy.maxLongEdge(
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            levelIdc: levelIdc
        )
    }
}
