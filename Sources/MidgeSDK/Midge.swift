import Foundation
import MidgeCore

/// MidgeSDK's whole public surface.
///
/// ```swift
/// Midge.start(link: "rl_…")                 // in application(_:didFinishLaunchingWithOptions:) or your App's init
/// Midge.metadata(["plan": "pro", "userId": user.id])
/// Midge.user(name: user.name, email: user.email)
/// Midge.report()                            // from your own "Report a bug" button; shaking the phone also opens it
/// ```
public enum Midge {
    public struct Options: Sendable {
        /// Shaking the device opens the report sheet.
        public var shakeToReport = true
        /// Records the app's HTTP requests (URLSession.shared, and sessions passed to `instrument`).
        public var captureNetwork = true
        /// Adds the app's own log messages (os_log / Logger / print through `Midge.log`) to the report.
        public var captureLogs = true
        /// midge.dev, or your own Midge server.
        public var origin = URL(string: "https://midge.dev")!

        public init() {}
    }

    struct Config: Sendable {
        let token: String
        let options: Options
        let startedAt: Date
    }

    nonisolated(unsafe) static var config: Config?
    nonisolated(unsafe) static var context: [String: Any] = [:]
    nonisolated(unsafe) static var person: (name: String, email: String) = ("", "")
    private static let lock = NSLock()

    /// Starts Midge with a recording link's token (Settings › Workspace › Recording links on midge.dev; the part after
    /// `/r/`). Reports go to that link's workspace, once an admin registers this app's bundle id there.
    public static func start(link token: String, options: Options = Options()) {
        lock.withLock { config = Config(token: token, options: options, startedAt: Date()) }
        if options.captureNetwork { URLProtocol.registerClass(NetworkCapture.self) }
        #if os(iOS)
        if options.shakeToReport { Task { @MainActor in Shake.install() } }
        #endif
    }

    /// Adds Midge's request capture to a session configuration of your own: call it before creating the URLSession.
    public static func instrument(_ configuration: URLSessionConfiguration) {
        configuration.protocolClasses = [NetworkCapture.self] + (configuration.protocolClasses ?? [])
    }

    /// Context that's useful in every report (user id, plan, feature flags); the latest value is sent. Hidden fields
    /// (tokens, passwords, your workspace's rules) are redacted like the rest of the logs.
    public static func metadata(_ values: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(values) else { return }
        lock.withLock { context = values }
    }

    /// Who's reporting: fills the report sheet's name and email so they don't type them.
    public static func user(name: String = "", email: String = "") {
        lock.withLock { person = (name, email) }
    }

    /// A line in the report's console tab, for messages that don't go through os_log.
    public static func log(_ message: String, level: Level = .info) {
        EventLog.shared.add(["kind": "console", "at": EventLog.now(), "level": level.rawValue, "text": message])
    }

    public enum Level: String, Sendable { case debug, info, warn, error }

    /// Opens the report sheet: the person records the screen, says what happened and sends.
    @MainActor public static func report() {
        #if os(iOS)
        ReportFlow.shared.begin()
        #endif
    }

    static func isMidge(_ url: URL?) -> Bool {
        guard let url, let host = url.host(), let origin = config?.options.origin.host() else { return false }
        return host == origin && url.path().hasPrefix("/api/record/")
    }

    static var snapshot: (config: Config?, context: [String: Any], person: (name: String, email: String)) {
        lock.withLock { (config, context, person) }
    }
}
