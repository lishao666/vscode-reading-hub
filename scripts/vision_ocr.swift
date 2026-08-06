import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count > 1 else { exit(2) }
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let files = (try? FileManager.default.contentsOfDirectory(at: input, includingPropertiesForKeys: nil)) ?? [input]
let images = files.filter { $0.pathExtension == "png" }
let queue = OperationQueue()
queue.maxConcurrentOperationCount = min(4, max(1, ProcessInfo.processInfo.activeProcessorCount / 2))
let lock = NSLock()
var recognized: [String: String] = [:]
for url in images {
  queue.addOperation {
    autoreleasepool {
    guard let image = NSImage(contentsOf: url),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans"]
    request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: cgImage).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined()
    if !text.isEmpty {
      lock.lock()
      recognized[url.deletingPathExtension().lastPathComponent] = text.replacingOccurrences(of: "\n", with: " ")
      lock.unlock()
    }
    }
  }
}
queue.waitUntilAllOperationsAreFinished()
for key in recognized.keys.sorted() {
  print("\(key)\t\(recognized[key]!)")
}
