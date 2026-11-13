import Foundation
import OSLog

/// The app's own log messages (Logger, os_log, NSLog) from the unified log, read when a report is sent: OSLogStore for
/// the current process needs no permission.
///
/// Apple's frameworks log into the same process (com.apple.network, UIKit, CFNetwork…): hundreds of lines a minute
/// that buried the app's own and counted as its errors. Only the app's messages are kept: a subsystem that isn't
/// Apple's, or none from the app's own binary (NSLog).
enum AppLogs {
    static func events(from: Date, to: Date, limit: Int = 2000) -> [[String: Any]] {
        guard let store = try? OSLogStore(scope: .currentProcessIdentifier) else { return [] }
        let position = store.position(date: from)
        guard let entries = try? store.getEntries(at: position) else { return [] }
        let executable = Bundle.main.object(forInfoDictionaryKey: "CFBundleExecutable") as? String ?? ""
        var out: [[String: Any]] = []
        for case let entry as OSLogEntryLog in entries {
            if entry.date > to { break }
            guard isApps(subsystem: entry.subsystem, sender: entry.sender, executable: executable) else { continue }
            out.append(["kind": "console", "at": entry.date.timeIntervalSince1970 * 1000, "level": level(entry.level),
                        "text": entry.subsystem.isEmpty ? entry.composedMessage : "[\(entry.subsystem)] \(entry.composedMessage)"])
            if out.count >= limit { out.removeFirst() }
        }
        return out
    }

    static func isApps(subsystem: String, sender: String, executable: String) -> Bool {
        if subsystem.hasPrefix("com.apple.") { return false }
        // Debug builds from Xcode run the app's code from <App>.debug.dylib.
        return !subsystem.isEmpty || sender == executable || sender == "\(executable).debug.dylib"
    }

    static func level(_ level: OSLogEntryLog.Level) -> String {
        switch level {
        case .error, .fault: "error"
        case .debug: "debug"
        default: "info"  // notice is Logger's default level, not a warning
        }
    }
}
