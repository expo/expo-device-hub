#!/usr/bin/env swift
import AppKit

// Regenerate from SimPasteboard: swift Icons/generate.swift Icons
// The transfer arrow overlays a closed clipboard outline, without gaps around its edges.
let directory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
let sizes = ["AppIcon60x60@2x": 120, "AppIcon60x60@3x": 180,
             "AppIcon76x76@2x": 152, "AppIcon83.5x83.5@2x": 167]
for (name, size) in sizes {
    let space = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                            bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: CGFloat(size) / 1024, y: -CGFloat(size) / 1024)
    let colors = [CGColor(red: 0.24, green: 0.25, blue: 0.26, alpha: 1),
                  CGColor(red: 0.09, green: 0.10, blue: 0.11, alpha: 1)] as CFArray
    context.drawLinearGradient(CGGradient(colorsSpace: space, colors: colors, locations: [0, 1])!,
                               start: CGPoint(x: 0, y: 0), end: CGPoint(x: 1024, y: 1024), options: [])
    context.setStrokeColor(CGColor(gray: 1, alpha: 1))
    context.setLineWidth(52)
    context.addPath(CGPath(roundedRect: CGRect(x: 303, y: 270, width: 418, height: 528),
                           cornerWidth: 55, cornerHeight: 55, transform: nil))
    context.strokePath()
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.addPath(CGPath(roundedRect: CGRect(x: 388, y: 211, width: 248, height: 116),
                           cornerWidth: 28, cornerHeight: 28, transform: nil))
    context.fillPath()
    context.fillEllipse(in: CGRect(x: 449, y: 151, width: 126, height: 126))
    context.setFillColor(CGColor(red: 0.17, green: 0.18, blue: 0.19, alpha: 1))
    context.fillEllipse(in: CGRect(x: 488, y: 185, width: 48, height: 48))
    context.move(to: CGPoint(x: 191, y: 452))
    for point in [CGPoint(x: 424, y: 452), CGPoint(x: 424, y: 377), CGPoint(x: 570, y: 518),
                  CGPoint(x: 424, y: 659), CGPoint(x: 424, y: 584), CGPoint(x: 191, y: 584)] {
        context.addLine(to: point)
    }
    context.closePath()
    context.setFillColor(CGColor(red: 1, green: 0.49, blue: 0.08, alpha: 1))
    context.fillPath()
    let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
    try bitmap.representation(using: .png, properties: [:])!
        .write(to: directory.appendingPathComponent(name + ".png"))
}
