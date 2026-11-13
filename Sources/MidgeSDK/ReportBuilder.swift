import Foundation
import MidgeCore

/// Turns what was captured between two moments into a gzip log bundle, redacted by the extension's own code.
enum ReportBuilder {
    static func bundle(from: Date, to: Date, device: [String: String], redaction: RedactionRules?, includeLogs: Bool,
                       context: [String: Any]) -> (gzip: Data, consoleErrors: Int, failedRequests: Int)? {
        let fromMs = from.timeIntervalSince1970 * 1000, toMs = to.timeIntervalSince1970 * 1000
        var events = EventLog.shared.between(fromMs, toMs)
        if includeLogs { events += AppLogs.events(from: from, to: to) }
        if !context.isEmpty { events.append(["kind": "metadata", "at": fromMs, "data": context]) }
        guard let json = try? JSONSerialization.data(withJSONObject: events), let bundler = JSBundler(),
              let result = bundler.build(eventsJSON: json, startedAt: Int64(fromMs), endedAt: Int64(toMs), device: device,
                                         source: "sdk-ios", redaction: redaction),
              let gzip = Gzip.encode(result.bundle) else { return nil }
        return (gzip, result.consoleErrors, result.failedRequests)
    }
}
