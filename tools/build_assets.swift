import AppKit
import Foundation

// Deterministic vector artwork and PNG exports; no third-party dependencies.
// Run from the repository root: swift tools/build_assets.swift
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let slate = NSColor(srgbRed: 25/255, green: 35/255, blue: 43/255, alpha: 1)
let mint = NSColor(srgbRed: 164/255, green: 232/255, blue: 194/255, alpha: 1)
let white = NSColor(srgbRed: 244/255, green: 248/255, blue: 246/255, alpha: 1)
let muted = NSColor(srgbRed: 171/255, green: 190/255, blue: 192/255, alpha: 1)

func png(_ path: String, width: Int, height: Int, draw: (CGFloat, CGFloat) -> Void) throws {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current!.imageInterpolation = .high
    draw(CGFloat(width), CGFloat(height))
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent(path))
}

func rounded(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, _ radius: CGFloat, _ color: NSColor) {
    color.setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: width, height: height), xRadius: radius, yRadius: radius).fill()
}

// The same geometry as icons/siteclock.svg, drawn in bottom-left coordinates.
func icon(_ x: CGFloat, _ y: CGFloat, _ size: CGFloat) {
    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.translateX(by: x, yBy: y)
    transform.scale(by: size / 128)
    transform.concat()
    rounded(16, 16, 96, 96, 23, slate)
    mint.setStroke()
    let frame = NSBezierPath(roundedRect: NSRect(x: 34, y: 35, width: 60, height: 58), xRadius: 10, yRadius: 10)
    frame.lineWidth = 5
    frame.lineCapStyle = .round
    frame.lineJoinStyle = .round
    frame.stroke()
    let strokes = NSBezierPath()
    strokes.lineWidth = 5
    strokes.lineCapStyle = .round
    strokes.lineJoinStyle = .round
    strokes.move(to: NSPoint(x: 35, y: 78)); strokes.line(to: NSPoint(x: 93, y: 78))
    strokes.move(to: NSPoint(x: 64, y: 67)); strokes.line(to: NSPoint(x: 64, y: 54)); strokes.line(to: NSPoint(x: 76, y: 47))
    strokes.stroke()
    NSGraphicsContext.restoreGraphicsState()
}

func text(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular) {
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: attrs)
}

try FileManager.default.createDirectory(at: root.appendingPathComponent("icons"), withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: root.appendingPathComponent("store/assets"), withIntermediateDirectories: true)
for size in [16, 32, 48, 128] {
    try png("icons/icon-\(size).png", width: size, height: size) { width, _ in icon(0, 0, width) }
}
try png("store/assets/icon-preview.png", width: 768, height: 384) { width, height in
    white.setFill(); NSRect(x: 0, y: 0, width: width / 2, height: height).fill()
    slate.setFill(); NSRect(x: width / 2, y: 0, width: width / 2, height: height).fill()
    icon(64, 64, 256); icon(448, 64, 256)
}
try png("store/assets/promo-small-440x280.png", width: 440, height: 280) { width, height in
    slate.setFill(); NSRect(x: 0, y: 0, width: width, height: height).fill()
    icon(156, 129, 128)
    text("SiteClock", x: 119, y: 85, size: 42, color: white, weight: .semibold)
    text("Time spent on each website.", x: 102, y: 49, size: 18, color: mint)
}
try png("store/assets/promo-marquee-1400x560.png", width: 1400, height: 560) { width, height in
    slate.setFill(); NSRect(x: 0, y: 0, width: width, height: height).fill()
    icon(104, 112, 336)
    text("SiteClock", x: 490, y: 299, size: 82, color: white, weight: .semibold)
    text("Time spent on each website.", x: 493, y: 237, size: 32, color: mint)
    text("A small timer. A running total. Stored locally.", x: 493, y: 178, size: 23, color: muted)
}
print("Built 4 icon sizes, icon preview, small promo, and optional marquee.")
