import AppKit
import CoreServices
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

extension FileItem {
    var fileExtension: String? {
        guard kind == "file", let suffix = (name as NSString).pathExtension.nonEmpty else { return nil }
        return suffix
    }

    var contentType: UTType {
        if kind == "directory" { return .folder }
        if kind == "symlink" { return .symbolicLink }
        return fileExtension.flatMap { UTType(filenameExtension: $0) } ?? .data
    }

    var lastOpened: Date? {
        guard kind == "file", info.st_nlink == 1 else { return nil }
        #if FILESHARING_TEST
        return nil
        #else
        let url = URL(fileURLWithPath: root.path + "/" + relative)
        guard let item = MDItemCreateWithURL(kCFAllocatorDefault, url as CFURL) else { return nil }
        return MDItemCopyAttribute(item, kMDItemLastUsedDate) as? Date
        #endif
    }

    var thumbnail: String? {
        if kind == "directory" { return "folder" }
        guard kind == "file", info.st_nlink == 1 else { return nil }
        if contentType.conforms(to: .image) { return "image" }
        if contentType.conforms(to: .pdf) { return "pdf" }
        return "file"
    }

    var created: Date? { date(info.st_birthtimespec, optional: true) }
    var modified: Date { date(info.st_mtimespec, optional: false)! }
    var accessed: Date? { date(info.st_atimespec, optional: true) }

    private func date(_ value: timespec, optional: Bool) -> Date? {
        if optional && value.tv_sec <= 0 { return nil }
        return Date(timeIntervalSince1970: Double(value.tv_sec) + Double(value.tv_nsec) / 1_000_000_000)
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

enum FileThumbnail {
    static let sourceLimit = 16 * 1024 * 1024
    private static let maxSize: CGFloat = 160

    static func make(_ kind: String, type: UTType, bytes: Data?) throws -> Data {
        let bitmap: CGImage?
        if kind == "image", let bytes, let source = CGImageSourceCreateWithData(bytes as CFData, nil) {
            bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: Int(maxSize),
                kCGImageSourceShouldCacheImmediately: true
            ] as CFDictionary)
        } else if kind == "pdf", let bytes, let provider = CGDataProvider(data: bytes as CFData),
                  let pdf = CGPDFDocument(provider), let page = pdf.page(at: 1) {
            bitmap = pdfImage(page)
        } else {
            bitmap = nil
        }
        if let bitmap {
            let output = NSMutableData()
            if let encoder = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) {
                CGImageDestinationAddImage(encoder, bitmap, nil)
                if CGImageDestinationFinalize(encoder) { return output as Data }
            }
        }
        let image = NSWorkspace.shared.icon(for: type)
        var preferred = NSRect(x: 0, y: 0, width: 64, height: 64)
        guard let icon = image.cgImage(forProposedRect: &preferred, context: nil, hints: nil),
              let png = NSBitmapImageRep(cgImage: icon).representation(using: .png, properties: [:]) else {
            throw AgentError("thumbnail_unavailable")
        }
        return png
    }

    private static func pdfImage(_ page: CGPDFPage) -> CGImage? {
        let bounds = page.getBoxRect(.cropBox)
        guard bounds.width.isFinite, bounds.height.isFinite, min(bounds.width, bounds.height) > 0 else { return nil }
        let rotated = abs(page.rotationAngle) % 180 == 90
        let size = rotated ? CGSize(width: bounds.height, height: bounds.width) : bounds.size
        let factor = maxSize / max(size.width, size.height)
        let width = max(1, Int((size.width * factor).rounded()))
        let height = max(1, Int((size.height * factor).rounded()))
        let pixels = CGRect(x: 0, y: 0, width: width, height: height)
        guard let drawing = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        drawing.setFillColor(gray: 1, alpha: 1)
        drawing.fill(pixels)
        drawing.concatenate(page.getDrawingTransform(.cropBox, rect: pixels, rotate: 0, preserveAspectRatio: true))
        drawing.drawPDFPage(page)
        return drawing.makeImage()
    }
}
