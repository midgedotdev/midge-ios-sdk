import Foundation

/// What the app did, kept in memory for the last 5 minutes (at most 2 000 events), in the extension's event format
/// (`kind`, epoch-ms `at`), so MidgeKit's bundler can redact and package it like any Midge report.
final class EventLog: @unchecked Sendable {
    static let shared = EventLog()
    private let lock = NSLock()
    private var events: [[String: Any]] = []
    private let keepMs: Double = 5 * 60 * 1000
    private let maxEvents = 2000

    static func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    func add(_ event: [String: Any]) {
        lock.withLock {
            events.append(event)
            let oldest = Self.now() - keepMs
            events.removeAll { ($0["at"] as? Double ?? 0) < oldest }
            if events.count > maxEvents { events.removeFirst(events.count - maxEvents) }
        }
    }

    func between(_ from: Double, _ to: Double) -> [[String: Any]] {
        lock.withLock { events.filter { let at = $0["at"] as? Double ?? 0; return at >= from && at <= to } }
    }

    func clear() {
        lock.withLock { events = [] }
    }
}
