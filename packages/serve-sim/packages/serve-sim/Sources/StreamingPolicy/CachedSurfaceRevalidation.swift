public enum CachedSurfaceRevalidation: Equatable, Sendable {
    case keep
    case replace
    case drop

    public static func decide(cachedID: UInt32?, liveID: UInt32?) -> CachedSurfaceRevalidation {
        switch (cachedID, liveID) {
        case (nil, nil): return .keep
        case (_, nil): return .drop
        case let (cached?, live?) where cached == live: return .keep
        default: return .replace
        }
    }
}
