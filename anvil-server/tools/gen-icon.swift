import AppKit

// Render a 1024×1024 app-icon PNG: a forge-orange rounded tile with a white hammer glyph.
// Usage: swift tools/gen-icon.swift <out.png>
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let S = 1024.0
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// Rounded-square gradient background (macOS-style inset).
let inset = S * 0.10
let rect = NSRect(x: inset, y: inset, width: S - 2 * inset, height: S - 2 * inset)
let path = NSBezierPath(roundedRect: rect, xRadius: S * 0.18, yRadius: S * 0.18)
let grad = NSGradient(colors: [NSColor(red: 0.96, green: 0.55, blue: 0.18, alpha: 1),
                               NSColor(red: 0.82, green: 0.36, blue: 0.08, alpha: 1)])!
grad.draw(in: path, angle: -90)

// White hammer symbol, centered.
if let sym = NSImage(systemSymbolName: "hammer.fill", accessibilityDescription: nil) {
  let cfg = NSImage.SymbolConfiguration(pointSize: S * 0.42, weight: .bold)
    .applying(.init(paletteColors: [.white]))
  let img = sym.withSymbolConfiguration(cfg) ?? sym
  let isz = img.size
  let scale = (S * 0.46) / max(isz.width, isz.height)
  let w = isz.width * scale, h = isz.height * scale
  img.draw(in: NSRect(x: (S - w) / 2, y: (S - h) / 2, width: w, height: h),
           from: .zero, operation: .sourceOver, fraction: 1.0)
}

NSGraphicsContext.restoreGraphicsState()
guard let data = rep.representation(using: .png, properties: [:]) else { fputs("png encode failed\n", stderr); exit(1) }
try! data.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
