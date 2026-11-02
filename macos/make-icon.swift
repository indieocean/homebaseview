// Renders the HomeBaseView app icon (same artwork as web/logo.svg).
// Usage: swift macos/make-icon.swift macos/AppIcon.iconset && iconutil -c icns macos/AppIcon.iconset -o macos/AppIcon.icns
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    // macOS icon grid: artwork is ~80% of the canvas, with a soft drop shadow.
    let inset = s * 0.1, side = s * 0.8
    let t = NSAffineTransform()
    t.translateX(by: inset, yBy: inset + side)
    t.scaleX(by: side / 64, yBy: -side / 64) // draw in the SVG's 64-unit, top-left coordinates
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.shadowBlurRadius = s * 0.025
    shadow.shadowOffset = NSSize(width: 0, height: -s * 0.012)
    shadow.set()

    let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 64, height: 64), xRadius: 14.5, yRadius: 14.5)
    bg.transform(using: t as AffineTransform)
    NSGradient(starting: NSColor(srgbRed: 0.416, green: 0.490, blue: 1, alpha: 1),
               ending: NSColor(srgbRed: 0.122, green: 0.784, blue: 0.910, alpha: 1))!.draw(in: bg, angle: -45)
    NSShadow().set()

    NSColor.white.set()
    let house = NSBezierPath()
    house.move(to: NSPoint(x: 14.5, y: 29.5))
    house.line(to: NSPoint(x: 32, y: 15.5))
    house.line(to: NSPoint(x: 49.5, y: 29.5))
    house.line(to: NSPoint(x: 49.5, y: 47))
    house.curve(to: NSPoint(x: 46, y: 50.5), controlPoint1: NSPoint(x: 49.5, y: 48.9), controlPoint2: NSPoint(x: 47.9, y: 50.5))
    house.line(to: NSPoint(x: 18, y: 50.5))
    house.curve(to: NSPoint(x: 14.5, y: 47), controlPoint1: NSPoint(x: 16.1, y: 50.5), controlPoint2: NSPoint(x: 14.5, y: 48.9))
    house.close()
    house.lineJoinStyle = .round
    house.transform(using: t as AffineTransform)
    house.lineWidth = 4 * side / 64
    house.stroke()
    let lens = NSBezierPath(ovalIn: NSRect(x: 24.5, y: 28.5, width: 15, height: 15))
    lens.transform(using: t as AffineTransform)
    lens.lineWidth = 3.6 * side / 64
    lens.stroke()
    let dot = NSBezierPath(ovalIn: NSRect(x: 29.4, y: 33.4, width: 5.2, height: 5.2))
    dot.transform(using: t as AffineTransform)
    dot.fill()

    ctx.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for pt in [16, 32, 128, 256, 512] {
    try render(pt).write(to: out.appendingPathComponent("icon_\(pt)x\(pt).png"))
    try render(pt * 2).write(to: out.appendingPathComponent("icon_\(pt)x\(pt)@2x.png"))
}
