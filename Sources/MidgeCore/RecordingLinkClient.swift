import Foundation

/// midge.dev's public recording-link endpoints (`/api/record/<token>/`), as the website SDK uses them, with
/// `X-Midge-App: <bundle id>`: MidgeSDK in a workspace's registered app, or Midge for iPhone answering a link.
public struct RecordingLinkClient: Sendable {
    public let origin: URL
    public let token: String
    public let app: String
    public var session: URLSession
    /// Extra headers on every call (Midge for iPhone's App Attest assertion).
    public var headers: [String: String] = [:]

    public init(origin: URL, token: String, app: String, session: URLSession = .shared) {
        self.origin = origin
        self.token = token
        self.app = app
        self.session = session
    }

    /// A link's token from a link (`https://midge.dev/record/<token>`), or nil.
    public static func token(in url: URL) -> String? {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0] == "record", parts[1].range(of: #"^[A-Za-z0-9_-]{6,40}$"#, options: .regularExpression) != nil
        else { return nil }
        return parts[1]
    }

    public struct Info: Decodable, Sendable {
        public let title: String
        public let message: String?
        public let workspace: String
        public let maxDurationMs: Int
        public let maxBytes: Int
        public let siteVerified: Bool?
        public let redaction: RedactionRules?
    }

    public struct Upload: Decodable, Sendable {
        public let url: URL
        public let chunkBytes: Int
    }

    public struct Started: Decodable, Sendable {
        public let id: String
        public let upload: Upload
        public let uploads: [String: Upload]?
        public let finish: String
    }

    public struct Failure: LocalizedError, Sendable {
        public let message: String
        /// midge.dev's machine-readable reason, when it gives one (e.g. `attest_key_unknown`).
        public var code: String?
        public init(message: String, code: String? = nil) {
            self.message = message
            self.code = code
        }
        public var errorDescription: String? { message }
    }

    private var base: URL { origin.appending(path: "api/record/\(token)/") }

    private static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    private func call<T: Decodable>(_ path: String, body: [String: Any]?) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.setValue(app, forHTTPHeaderField: "X-Midge-App")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            throw Failure(message: body["detail"] as? String ?? "Midge answered \(status).", code: body["code"] as? String)
        }
        return try Self.decoder.decode(T.self, from: data)
    }

    public func info() async throws -> Info { try await call("", body: nil) }

    public func submit(_ body: [String: Any]) async throws -> Started { try await call("submit/", body: body) }

    public func finish(_ claim: String) async throws {
        struct Done: Decodable {}
        let _: Done = try await call("finish/", body: ["finish": claim])
    }

    /// Resumable upload in chunks (PATCH with Upload-Offset), as the extension does.
    public func upload(_ file: URL, to target: Upload, progress: @Sendable (Int64) -> Void) async throws {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let size = Int64(try handle.seekToEnd())
        var offset: Int64 = 0
        while offset < size {
            try handle.seek(toOffset: UInt64(offset))
            let part = handle.readData(ofLength: target.chunkBytes)
            var request = URLRequest(url: target.url)
            request.httpMethod = "PATCH"
            request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
            request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
            let (_, response) = try await session.upload(for: request, from: part)
            let http = response as? HTTPURLResponse
            guard let http, (200..<300).contains(http.statusCode) || http.statusCode == 409 else {
                throw Failure(message: "The upload stopped. Check your connection and try again.")
            }
            offset = http.value(forHTTPHeaderField: "Upload-Offset").flatMap(Int64.init) ?? offset + Int64(part.count)
            progress(offset)
        }
    }
}
