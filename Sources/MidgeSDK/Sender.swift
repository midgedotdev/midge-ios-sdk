import Foundation
import MidgeCore
#if canImport(UIKit)
import UIKit
#endif

/// Sends one report: the video, the log bundle for its time, the person's words.
struct Sender: Sendable {
    let client: RecordingLinkClient
    let includeLogs: Bool

    struct Report: Sendable {
        let video: URL
        let startedAt: Date
        let endedAt: Date
        let name: String
        let email: String
        let description: String
    }

    static func device() -> [String: String] {
        let info = Bundle.main.infoDictionary ?? [:]
        var device: [String: String] = [
            "app": info["CFBundleName"] as? String ?? "",
            "appVersion": "\(info["CFBundleShortVersionString"] as? String ?? "") (\(info["CFBundleVersion"] as? String ?? ""))",
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "locale": Locale.current.identifier,
            "timezone": TimeZone.current.identifier,
        ]
        var system = utsname()
        uname(&system)
        device["model"] = withUnsafeBytes(of: system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        #if canImport(UIKit)
        device["os"] = "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)"
        #else
        device["os"] = ProcessInfo.processInfo.operatingSystemVersionString
        #endif
        return device
    }

    func send(_ report: Report, redaction: RedactionRules?, context: [String: Any], progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let videoSize = (try? report.video.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard videoSize > 0 else { throw RecordingLinkClient.Failure(message: "The recording is empty. Record it again.") }
        let bundle = ReportBuilder.bundle(from: report.startedAt, to: report.endedAt, device: Self.device(),
                                          redaction: redaction, includeLogs: includeLogs, context: context)
        var logsFile: URL?
        if let bundle {
            let url = FileManager.default.temporaryDirectory.appending(path: "midge-logs-\(UUID().uuidString).json.gz")
            try bundle.gzip.write(to: url)
            logsFile = url
        }
        defer { if let logsFile { try? FileManager.default.removeItem(at: logsFile) } }
        let appName = Self.device()["app"] ?? ""
        var body: [String: Any] = [
            "name": report.name, "email": report.email, "description": report.description, "content_type": "video/mp4",
            "size": videoSize, "duration_ms": Int(report.endedAt.timeIntervalSince(report.startedAt) * 1000),
            "page_title": String(appName.prefix(300)),
        ]
        if let bundle { body["logs_size"] = bundle.gzip.count }
        let started = try await client.submit(body)
        let total = Double(videoSize + (bundle?.gzip.count ?? 0))
        let logsBytes = Int64(bundle?.gzip.count ?? 0)
        if let logsFile, let target = started.uploads?["logs"] {
            try await client.upload(logsFile, to: target) { progress(Double($0) / total) }
        }
        try await client.upload(report.video, to: started.uploads?["video"] ?? started.upload) {
            progress(Double(logsBytes + $0) / total)
        }
        try await client.finish(started.finish)
        return started.id
    }
}
