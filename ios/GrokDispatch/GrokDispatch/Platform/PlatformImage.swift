import Foundation
import SwiftUI

#if canImport(UIKit)
import UIKit
public typealias PlatformImage = UIImage
#elseif canImport(AppKit)
import AppKit
public typealias PlatformImage = NSImage
#endif

extension PlatformImage {
    /// JPEG bytes for upload to the host follow-up API.
    func cs_jpegData(compressionQuality: CGFloat = 0.72) -> Data? {
        #if canImport(UIKit)
        return jpegData(compressionQuality: compressionQuality)
        #elseif canImport(AppKit)
        guard let tiff = tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff)
        else { return nil }
        return rep.representation(using: .jpeg, properties: [.compressionFactor: compressionQuality])
        #endif
    }

    func cs_resized(maxDimension: CGFloat) -> PlatformImage {
        #if canImport(UIKit)
        let w = size.width
        let h = size.height
        let longest = max(w, h)
        guard longest > maxDimension, longest > 0 else { return self }
        let scale = maxDimension / longest
        let newSize = CGSize(width: floor(w * scale), height: floor(h * scale))
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: newSize))
        }
        #elseif canImport(AppKit)
        let w = size.width
        let h = size.height
        let longest = max(w, h)
        guard longest > maxDimension, longest > 0 else { return self }
        let scale = maxDimension / longest
        let newSize = NSSize(width: floor(w * scale), height: floor(h * scale))
        let img = NSImage(size: newSize)
        img.lockFocus()
        defer { img.unlockFocus() }
        draw(
            in: NSRect(origin: .zero, size: newSize),
            from: NSRect(origin: .zero, size: size),
            operation: .copy,
            fraction: 1.0
        )
        return img
        #endif
    }

    static func cs_fromData(_ data: Data) -> PlatformImage? {
        #if canImport(UIKit)
        return UIImage(data: data)
        #elseif canImport(AppKit)
        return NSImage(data: data)
        #endif
    }
}

extension Image {
    init(platformImage: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: platformImage)
        #elseif canImport(AppKit)
        self.init(nsImage: platformImage)
        #endif
    }
}
