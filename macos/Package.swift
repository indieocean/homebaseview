// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "HomeView",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "HomeView", path: "Sources/HomeView")
    ]
)
