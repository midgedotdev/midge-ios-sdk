import Foundation
import MidgeCore
import Testing
@testable import MidgeSDK

/// Answers every request with the body and status set for its path, recording what was sent.
final class FakeServer: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var routes: [String: (Int, [String: String], Data)] = [:]
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var bodies: [String: Data] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.seen.append(request)
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; body.append(buffer, count: n) }
            stream.close()
        }
        Self.bodies[request.url!.path(), default: Data()].append(body)
        let (status, headers, data) = Self.routes[request.url!.path()] ?? (404, [:], Data("{}".utf8))
        var all = headers
        if request.httpMethod == "PATCH" {
            all["Upload-Offset"] = String(Int(request.value(forHTTPHeaderField: "Upload-Offset") ?? "0")! + body.count)
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: all)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Suite(.serialized) struct MidgeSDKTests {
    func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeServer.self]
        return URLSession(configuration: config)
    }

    @Test func sendsVideoAndRedactedLogsWithTheAppsBundleId() async throws {
        FakeServer.seen = []
        FakeServer.bodies = [:]
        let up = #"{"url":"https://midge.test/api/uploads/v/","chunk_bytes":1000}"#
        let logs = #"{"url":"https://midge.test/api/uploads/l/","chunk_bytes":1000}"#
        FakeServer.routes = [
            "/api/record/rl_1/submit/": (201, [:], Data(#"{"id":"r1","upload":\#(up),"uploads":{"video":\#(up),"logs":\#(logs)},"finish":"claim"}"#.utf8)),
            "/api/uploads/v/": (204, [:], Data()),
            "/api/uploads/l/": (204, [:], Data()),
            "/api/record/rl_1/finish/": (200, [:], Data(#"{"status":"sent"}"#.utf8)),
        ]
        let start = Date().addingTimeInterval(-5)
        EventLog.shared.clear()
        EventLog.shared.add(["kind": "network", "at": EventLog.now() - 1000, "method": "POST", "url": "https://api.example.com/login?token=abc",
                             "status": 500, "type": "fetch", "durationMs": 12, "requestBody": #"{"password":"hunter2","plan":"pro"}"#,
                             "requestHeaders": [["content-type", "application/json"], ["x-session", "s3cret"]]])
        Midge.log("checkout failed", level: .error)
        let video = FileManager.default.temporaryDirectory.appending(path: "sdk-test.mp4")
        try Data(repeating: 7, count: 2500).write(to: video)

        let client = RecordingLinkClient(origin: URL(string: "https://midge.test")!, token: "rl_1", app: "com.example.shop", session: session())
        let id = try await Sender(client: client, includeLogs: false).send(
            .init(video: video, startedAt: start, endedAt: Date(), name: "Ada", email: "", description: "Pay button spins"),
            redaction: RedactionRules(fields: ["plan"], headers: ["x-session"]), context: ["userId": "u42"]) { _ in }

        #expect(id == "r1")
        #expect(FakeServer.seen.allSatisfy { $0.url!.path().hasPrefix("/api/uploads/") || $0.value(forHTTPHeaderField: "X-Midge-App") == "com.example.shop" })
        let submit = try JSONSerialization.jsonObject(with: FakeServer.bodies["/api/record/rl_1/submit/"]!) as! [String: Any]
        #expect(submit["size"] as? Int == 2500)
        #expect(submit["description"] as? String == "Pay button spins")
        #expect(FakeServer.bodies["/api/uploads/v/"]?.count == 2500)  // three chunks

        let bundle = try JSONSerialization.jsonObject(with: Gzip.decode(FakeServer.bodies["/api/uploads/l/"]!)!) as! [String: Any]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: bundle), as: UTF8.self)
        #expect(!text.contains("hunter2"))
        #expect(!text.contains("s3cret"))
        #expect(!text.contains("\"pro\""))
        #expect(!text.contains("token=abc"))
        #expect(text.contains("checkout failed"))
        #expect((bundle["metadata"] as? [String: Any])?["userId"] as? String == "u42")
        #expect((bundle["device"] as? [String: Any])?["model"] != nil)
        #expect(FakeServer.seen.last?.url?.path() == "/api/record/rl_1/finish/")
    }

    @Test func aRefusalSaysWhy() async throws {
        FakeServer.routes = ["/api/record/rl_1/submit/": (403, [:], Data(#"{"detail":"This app isn’t registered with Acme."}"#.utf8))]
        let video = FileManager.default.temporaryDirectory.appending(path: "sdk-test2.mp4")
        try Data(repeating: 1, count: 10).write(to: video)
        let client = RecordingLinkClient(origin: URL(string: "https://midge.test")!, token: "rl_1", app: "com.other", session: session())
        await #expect(throws: RecordingLinkClient.Failure.self) {
            try await Sender(client: client, includeLogs: false).send(
                .init(video: video, startedAt: Date(), endedAt: Date(), name: "", email: "", description: ""),
                redaction: nil, context: [:]) { _ in }
        }
    }

    @Test func networkCaptureRecordsRequestsAndPassesThemOn() async throws {
        EventLog.shared.clear()
        FakeServer.routes = ["/items": (200, ["Content-Type": "application/json"], Data(#"{"ok":true}"#.utf8))]
        // The capture forwards through its own session; point that at the fake server for the test.
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NetworkCapture.self, FakeServer.self]
        NetworkCapture.forwardingClasses = [FakeServer.self]
        defer { NetworkCapture.forwardingClasses = [] }
        let (data, _) = try await URLSession(configuration: config).data(from: URL(string: "https://api.example.com/items")!)
        #expect(String(decoding: data, as: UTF8.self) == #"{"ok":true}"#)
        try await Task.sleep(for: .milliseconds(100))
        let events = EventLog.shared.between(0, EventLog.now() + 1)
        #expect(events.count == 1)
        #expect(events.first?["status"] as? Int == 200)
        #expect(events.first?["responseBody"] as? String == #"{"ok":true}"#)
    }

    @Test func onlyTheAppsOwnLogMessagesAreKept() {
        #expect(AppLogs.isApps(subsystem: "dev.acme.shop", sender: "Foundation", executable: "Shop"))
        #expect(AppLogs.isApps(subsystem: "", sender: "Shop", executable: "Shop"))  // NSLog from the app
        #expect(AppLogs.isApps(subsystem: "", sender: "Shop.debug.dylib", executable: "Shop"))
        #expect(!AppLogs.isApps(subsystem: "com.apple.network", sender: "Network", executable: "Shop"))
        #expect(!AppLogs.isApps(subsystem: "com.apple.UIKit", sender: "UIKitCore", executable: "Shop"))
        #expect(!AppLogs.isApps(subsystem: "", sender: "CFNetwork", executable: "Shop"))
        #expect(AppLogs.level(.notice) == "info" && AppLogs.level(.fault) == "error")
    }

    @Test func oldEventsAreDropped() {
        EventLog.shared.clear()
        EventLog.shared.add(["kind": "console", "at": EventLog.now() - 6 * 60 * 1000, "text": "old"])
        EventLog.shared.add(["kind": "console", "at": EventLog.now(), "text": "new"])
        #expect(EventLog.shared.between(0, EventLog.now() + 1).map { $0["text"] as? String } == ["new"])
    }
}
