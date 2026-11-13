import Foundation

/// Sees the app's HTTP requests: a URLProtocol that records each request and passes it on unchanged. URLSession.shared
/// is covered once `Midge.start` runs; for your own sessions, `Midge.instrument(configuration)`.
final class NetworkCapture: URLProtocol, @unchecked Sendable {
    private static let handled = "dev.midge.sdk.handled"
    static let bodyLimit = 65_536
    private var forward: URLSessionDataTask?
    private var started: Double = 0
    private var received = Data()
    private var response: HTTPURLResponse?

    /// Extra protocol classes for the forwarding session (tests).
    nonisolated(unsafe) static var forwardingClasses: [AnyClass] = [] { didSet { _forwarding = nil } }
    nonisolated(unsafe) private static var _forwarding: URLSession?
    private static var forwarding: URLSession {
        if let session = _forwarding { return session }
        let config = URLSessionConfiguration.default
        config.protocolClasses = forwardingClasses + (config.protocolClasses ?? []).filter { $0 != NetworkCapture.self }
        let session = URLSession(configuration: config)
        _forwarding = session
        return session
    }

    override class func canInit(with request: URLRequest) -> Bool {
        guard let scheme = request.url?.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return URLProtocol.property(forKey: handled, in: request) == nil && !Midge.isMidge(request.url)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let copy = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else { return }
        URLProtocol.setProperty(true, forKey: Self.handled, in: copy)
        started = EventLog.now()
        forward = Self.forwarding.dataTask(with: copy as URLRequest) { [weak self] data, response, error in
            guard let self else { return }
            if let response { self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
            if let data { self.client?.urlProtocol(self, didLoad: data) }
            if let error { self.client?.urlProtocol(self, didFailWithError: error) } else { self.client?.urlProtocolDidFinishLoading(self) }
            self.record(data: data, response: response as? HTTPURLResponse, error: error)
        }
        forward?.resume()
    }

    override func stopLoading() {
        forward?.cancel()
    }

    private func record(data: Data?, response: HTTPURLResponse?, error: Error?) {
        let headers = { (pairs: [AnyHashable: Any]?) in (pairs ?? [:]).map { [String(describing: $0.key).lowercased(), String(describing: $0.value)] } }
        var event: [String: Any] = [
            "kind": "network", "at": started, "method": request.httpMethod ?? "GET", "url": request.url?.absoluteString ?? "",
            "status": response?.statusCode ?? 0, "type": "fetch", "durationMs": Int(EventLog.now() - started),
            "requestHeaders": headers(request.allHTTPHeaderFields), "responseHeaders": headers(response?.allHeaderFields),
        ]
        if let body = request.httpBody ?? request.httpBodyStream.flatMap(Self.read), let text = Self.text(body) { event["requestBody"] = text }
        if let data, let text = Self.text(data) { event["responseBody"] = text }
        if (data?.count ?? 0) > Self.bodyLimit { event["truncated"] = true }
        if let error { event["error"] = error.localizedDescription }
        EventLog.shared.add(event)
    }

    private static func text(_ data: Data) -> String? {
        String(data: data.prefix(bodyLimit), encoding: .utf8)
    }

    private static func read(_ stream: InputStream) -> Data? {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable, data.count < bodyLimit {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}
