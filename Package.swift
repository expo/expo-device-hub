// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "simstream",
    platforms: [.macOS(.v14)],
    targets: [
        // Thin Objective-C wrapper over the private CoreSimulator / SimulatorKit APIs
        // (framebuffer IOSurface + Indigo HID injection). Loaded with dlopen at runtime.
        .target(
            name: "SimBridge",
            linkerSettings: [.linkedFramework("IOSurface"), .linkedFramework("CoreGraphics")]
        ),
        .executableTarget(
            name: "simstream",
            dependencies: ["SimBridge"],
            resources: [.copy("Web")]
        ),
    ]
)
