// Renders AppIcon.icns from an SF Symbol. Run: swift macos/make-icon.swift (from repo root or macos/)
import AppKit
let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let s = CGFloat(size)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    let rect = NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
    let path = NSBezierPath(roundedRect: rect, xRadius: s * 0.18, yRadius: s * 0.18)
    NSGradient(starting: NSColor(red: 0.24, green: 0.55, blue: 0.99, alpha: 1), ending: NSColor(red: 0.10, green: 0.25, blue: 0.62, alpha: 1))!.draw(in: path, angle: -90)
    let cfg = NSImage.SymbolConfiguration(pointSize: s * 0.42, weight: .semibold).applying(.init(paletteColors: [.white]))
    if let sym = NSImage(systemSymbolName: "video.doorbell.fill", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
        let r = NSRect(x: (s - sym.size.width) / 2, y: (s - sym.size.height) / 2, width: sym.size.width, height: sym.size.height)
        sym.draw(in: r)
    }
    img.unlockFocus()
    let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
    let png = rep.representation(using: .png, properties: [:])!
    for (scale, name) in [(1, "icon_\(size)x\(size).png"), (2, "icon_\(size/2)x\(size/2)@2x.png")] where size / scale >= 16 && (scale == 1 ? size <= 512 : true) {
        try png.write(to: out.appendingPathComponent(name))
    }
}
