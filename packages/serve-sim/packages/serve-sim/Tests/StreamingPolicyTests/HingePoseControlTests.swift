import Testing

@testable import StreamingPolicy

@Suite("HingePoseControl")
struct HingePoseControlTests {
    @Test("an unavailable table sensor refuses Tent without moving the device")
    func unavailableTent() async {
        var angle = 180.0
        var events: [String] = []
        let ok = await HingePoseControl.apply(
            "tent", tableModeAvailable: { false },
            setAngle: { angle = $0; return true },
            setTableMode: { events.append("table:\($0)"); return true },
            setOrientation: { events.append($0); return true },
            waitForLandscapeCover: { events.append("wait"); return true }
        )
        #expect(!ok)
        #expect(angle == 180)
        #expect(events.isEmpty)
    }

    @Test("ordinary poses still work without a table sensor", arguments: ["closed", "open", "laptop", "book"])
    func ordinaryPose(pose: String) async {
        var events: [String] = []
        let ok = await HingePoseControl.apply(
            pose, tableModeAvailable: { false },
            setAngle: { events.append("angle:\($0)"); return true },
            setTableMode: { events.append("table:\($0)"); return !$0 },
            setOrientation: { events.append($0); return true },
            waitForLandscapeCover: { Issue.record("Unexpected Tent wait"); return false }
        )
        #expect(ok)
        #expect(events.first == "table:false")
        #expect(events.count == 3)
    }

    @Test("Tent waits for its landscape cover before going face down")
    func tentSequence() async {
        var events: [String] = []
        let ok = await HingePoseControl.apply(
            "tent", tableModeAvailable: { events.append("available"); return true },
            setAngle: { events.append("angle:\($0)"); return true },
            setTableMode: { events.append("table:\($0)"); return true },
            setOrientation: { events.append($0); return true },
            waitForLandscapeCover: { events.append("wait"); return true }
        )
        #expect(ok)
        #expect(events == ["available", "angle:80.0", "landscape-left", "table:true", "wait", "facedown"])
    }

    @Test("a real table sensor send failure still fails the pose")
    func failedSend() async {
        var orientations: [String] = []
        let ok = await HingePoseControl.apply(
            "tent", tableModeAvailable: { true },
            setAngle: { _ in true }, setTableMode: { _ in false },
            setOrientation: { orientations.append($0); return true },
            waitForLandscapeCover: { Issue.record("Wait after failed send"); return true }
        )
        #expect(!ok)
        #expect(orientations == ["landscape-left"])
    }
}
