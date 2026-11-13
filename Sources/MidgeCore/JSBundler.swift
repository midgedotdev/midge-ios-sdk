import Foundation
import JavaScriptCore

/// Electron apps' logs become a log bundle with the extension's own code, run in JavaScriptCore (spec §9.3):
/// `@midge/redaction` and `buildBundle`, built into `Resources/midge-bundle.js`. The rules stay in one place; nothing
/// is translated to Swift.
public final class JSBundler: @unchecked Sendable {
    private let context: JSContext
    private let function: JSValue
    private let lock = NSLock()

    public init?() {
        guard let url = Bundle.module.url(forResource: "midge-bundle", withExtension: "js", subdirectory: "Scripts"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else { return nil }
        context.evaluateScript(source)
        guard let function = context.objectForKeyedSubscript("midgeBuildBundle"), !function.isUndefined else { return nil }
        self.context = context
        self.function = function
    }

    /// The page script injected into Electron windows (`Resources/midge-page.js`).
    public static var pageScript: String? {
        Bundle.module.url(forResource: "midge-page", withExtension: "js", subdirectory: "Scripts")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }

    public struct Result: Sendable {
        /// The bundle, as JSON (gzip it to upload).
        public let bundle: Data
        public let consoleErrors: Int
        public let failedRequests: Int
    }

    /// `events`: what the page script emitted, as JSON objects with epoch-ms `at`. Times in epoch ms; `pauses` are
    /// wall-clock [from, to) pairs.
    /// `redaction`: the workspaces' extra names to hide (`Me.redaction`), on top of Midge's own rules.
    public func build(eventsJSON: Data, startedAt: Int64, endedAt: Int64, pauses: [[Int64]] = [], device: [String: String] = [:],
                      source: String?, redaction: RedactionRules? = nil) -> Result? {
        var options: [String: Any] = ["startedAt": startedAt, "endedAt": endedAt, "pauses": pauses, "device": device]
        if let redaction { options["redaction"] = ["fields": redaction.fields, "headers": redaction.headers] }
        if let source { options["source"] = source }
        guard let optionsJSON = try? JSONSerialization.data(withJSONObject: options) else { return nil }
        let output: String? = lock.withLock {
            function.call(withArguments: [String(decoding: eventsJSON, as: UTF8.self), String(decoding: optionsJSON, as: UTF8.self)])?
                .toString()
        }
        guard let output, let data = output.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let bundle = object["bundle"], let bundleJSON = try? JSONSerialization.data(withJSONObject: bundle)
        else { return nil }
        let summary = object["summary"] as? [String: Any] ?? [:]
        return Result(bundle: bundleJSON, consoleErrors: summary["consoleErrors"] as? Int ?? 0,
                      failedRequests: summary["failedRequests"] as? Int ?? 0)
    }
}
