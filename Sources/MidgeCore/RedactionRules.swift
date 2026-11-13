import Foundation

/// Names a workspace hides in reports, on top of Midge's own rules (`/api/me/` and recording links).
public struct RedactionRules: Decodable, Sendable, Equatable {
    public let fields: [String]
    public let headers: [String]

    public init(fields: [String], headers: [String]) {
        self.fields = fields
        self.headers = headers
    }
}
