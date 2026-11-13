// swift-tools-version: 6.0
// MidgeSDK: "Report a bug" for your iPhone and iPad app, sent to your Midge workspace (https://midge.dev).
// Generated from github.com/midgedotdev/midge (sdk-ios/ and mac/MidgeKit/Sources/MidgeCore) by sdk-ios/scripts/publish.sh.
import PackageDescription

let package = Package(
    name: "MidgeSDK",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "MidgeSDK", targets: ["MidgeSDK"])],
    targets: [
        .target(name: "MidgeCore", resources: [.copy("Scripts")]),
        .target(name: "MidgeSDK", dependencies: ["MidgeCore"]),
        .testTarget(name: "MidgeSDKTests", dependencies: ["MidgeSDK"]),
    ]
)
