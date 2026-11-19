import Foundation

enum JSON: Codable, Equatable, Sendable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    case object([String: JSON])
    case array([JSON])
    case string(String)
    case integer(Int64)
    case decimal(Double)
    case boolean(Bool)
    case null

    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int64) { self = .integer(value) }
    init(booleanLiteral value: Bool) { self = .boolean(value) }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSON)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let raw = try? value.decode(Bool.self) { self = .boolean(raw) }
        else if let raw = try? value.decode(Int64.self) { self = .integer(raw) }
        else if let raw = try? value.decode(Double.self) { self = .decimal(raw) }
        else if let raw = try? value.decode(String.self) { self = .string(raw) }
        else if let raw = try? value.decode([JSON].self) { self = .array(raw) }
        else { self = .object(try value.decode([String: JSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var output = encoder.singleValueContainer()
        switch self {
        case .object(let value): try output.encode(value)
        case .array(let value): try output.encode(value)
        case .string(let value): try output.encode(value)
        case .integer(let value): try output.encode(value)
        case .decimal(let value): try output.encode(value)
        case .boolean(let value): try output.encode(value)
        case .null: try output.encodeNil()
        }
    }

    subscript(_ key: String) -> JSON {
        if case .object(let value) = self { return value[key] ?? .null }
        return .null
    }

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var int: Int64? {
        if case .integer(let value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case .boolean(let value) = self { return value }
        return nil
    }

    var array: [JSON]? {
        if case .array(let value) = self { return value }
        return nil
    }

    func requireString(_ key: String) throws -> String {
        guard let value = self[key].string else { throw AgentError("invalid_request") }
        return value
    }

    func requireInt(_ key: String) throws -> Int64 {
        guard let value = self[key].int else { throw AgentError("invalid_request") }
        return value
    }

    static func text(_ value: String?) -> JSON { value.map(JSON.string) ?? .null }
    static func number(_ value: Int?) -> JSON { value.map { .integer(Int64($0)) } ?? .null }

    static func date(_ value: Date) -> JSON {
        .string(value.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true).timeZone(separator: .colon)))
    }

    func encoded() throws -> Data { try JSONEncoder().encode(self) }
    static func decode(_ bytes: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: bytes) }
    static func id() -> String { UUID().uuidString.lowercased() }
}

struct AgentError: Error {
    let code: String
    init(_ code: String) { self.code = code }
}

extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
