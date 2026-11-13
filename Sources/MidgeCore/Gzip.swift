import Foundation

/// Gzip (RFC 1952) around the system's raw DEFLATE.
public enum Gzip {
    public static func encode(_ data: Data) -> Data? {
        guard let deflated = try? (data as NSData).compressed(using: .zlib) as Data else { return nil }
        var out = Data([0x1F, 0x8B, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03])
        out.append(deflated)
        out.append(littleEndian: crc32(data))
        out.append(littleEndian: UInt32(truncatingIfNeeded: data.count))
        return out
    }

    public static func decode(_ data: Data) -> Data? {
        let bytes = [UInt8](data)
        guard bytes.count >= 18, bytes[0] == 0x1F, bytes[1] == 0x8B, bytes[2] == 0x08 else { return nil }
        let flags = bytes[3]
        var index = 10
        if flags & 0x04 != 0 {  // extra field
            guard index + 2 <= bytes.count else { return nil }
            index += 2 + Int(bytes[index]) + Int(bytes[index + 1]) << 8
        }
        for flag: UInt8 in [0x08, 0x10] where flags & flag != 0 {  // file name, comment: zero-terminated
            while index < bytes.count, bytes[index] != 0 { index += 1 }
            index += 1
        }
        if flags & 0x02 != 0 { index += 2 }  // header CRC
        guard index < bytes.count - 8 else { return nil }
        let body = Data(bytes[index..<(bytes.count - 8)])
        guard let inflated = try? (body as NSData).decompressed(using: .zlib) as Data else { return nil }
        let crc = UInt32(bytes[bytes.count - 8]) | UInt32(bytes[bytes.count - 7]) << 8 | UInt32(bytes[bytes.count - 6]) << 16
            | UInt32(bytes[bytes.count - 5]) << 24
        return crc == crc32(inflated) ? inflated : nil
    }

    private static let table: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for byte in data { c = table[Int((c ^ UInt32(byte)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }
}

private extension Data {
    mutating func append(littleEndian value: UInt32) {
        var v = value.littleEndian
        append(Data(bytes: &v, count: 4))
    }
}
