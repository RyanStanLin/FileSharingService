import AppKit
import CryptoKit
import Foundation

/// Shared by application inventory and icon requests. Called on the application work queue.
final class ApplicationIcons: @unchecked Sendable {
    struct Rendition {
        let png: Data
        let hash: String
    }

    private struct Key: Hashable {
        let path: String
        let version: String?
        let build: String?
    }

    private var images = [Key: Rendition]()

    func rendition(for application: JSON) -> Rendition? {
        guard let path = application["installPath"].string else { return nil }
        let key = Key(path: path, version: application["version"].string, build: application["build"].string)
        if let cached = images[key] { return cached }
        return autoreleasepool {
            let icon = NSWorkspace.shared.icon(forFile: path)
            let image = NSImage(size: NSSize(width: 64, height: 64), flipped: false) { rect in
                icon.draw(in: rect)
                return true
            }
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]), png.count <= 131_072 else { return nil }
            let hash = SHA256.hash(data: png).map { String(format: "%02X", $0) }.joined()
            let result = Rendition(png: png, hash: hash)
            if images.count >= 256 { images.removeAll(keepingCapacity: true) }
            images[key] = result
            return result
        }
    }

    func invalidate() { images.removeAll(keepingCapacity: true) }
}
