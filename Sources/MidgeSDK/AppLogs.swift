import Foundation
import OSLog

/// The app's own log messages (Logger, os_log, NSLog) from the unified log, read when a report is sent: OSLogStore
/// for the current process needs no permission.
enum AppLogs {
    static func events(from: Date, to: Date, limit: Int = 2000) -> [[String: Any]] {
        guard let store = try? OSLogStore(scope: .currentProcessIdentifier) else { return [] }
        let position = store.position(date: from)
        guard let entries = try? store.getEntries(at: position) else { return [] }
        var out: [[String: Any]] = []
        for case let entry as OSLogEntryLog in entries {
            if entry.date > to { break }
            out.append(["kind": "console", "at": entry.date.timeIntervalSince1970 * 1000, "level": level(entry.level),
                        "text": entry.subsystem.isEmpty ? entry.composedMessage : "[\(entry.subsystem)] \(entry.composedMessage)"])
            if out.count >= limit { out.removeFirst() }
        }
        return out
    }

    static func level(_ level: OSLogEntryLog.Level) -> String {
        switch level {
        case .error, .fault: "error"
        case .debug: "debug"
        case .notice: "warn"
        default: "info"
        }
    }
}
