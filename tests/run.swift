import Foundation
import JavaScriptCore

// A dependency-free macOS test runner. Node can run the same suite instead.
let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let context = JSContext()!
var failed = false
context.exceptionHandler = { _, value in
    fputs("JavaScript error: \(value?.toString() ?? "unknown")\n", stderr)
    failed = true
}
let printLine: @convention(block) (String) -> Void = { print($0) }
context.setObject(printLine, forKeyedSubscript: "printLine" as NSString)
// JSCore is an ECMAScript engine without browser URL parsing. Bridge Foundation
// for URL-based tests; production code uses Chrome's native URL implementation.
let parseURL: @convention(block) (String) -> String = { raw in
    guard let parts = URLComponents(string: raw), let scheme = parts.scheme else { return "null" }
    let values = ["protocol": scheme.lowercased() + ":", "hostname": parts.host ?? ""]
    let bytes = try! JSONSerialization.data(withJSONObject: values)
    return String(data: bytes, encoding: .utf8)!
}
context.setObject(parseURL, forKeyedSubscript: "parseNativeURL" as NSString)
context.evaluateScript("""
globalThis.console = { log: (...args) => printLine(args.join(' ')), error: (...args) => printLine(args.join(' ')) };
globalThis.URL = class URL {
  constructor(raw) {
    const parsed = JSON.parse(parseNativeURL(String(raw)));
    if (!parsed) throw new Error('Invalid URL');
    Object.assign(this, parsed);
  }
};
""")
func source(_ path: String) throws -> String {
    try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
}
do {
    let manifestData = try Data(contentsOf: root.appendingPathComponent("manifest.json"))
    let manifest = try JSONSerialization.jsonObject(with: manifestData) as! [String: Any]
    guard manifest["manifest_version"] as? Int == 3 else { fatalError("Expected Manifest V3") }
    for file in ["content.js", "popup.js"] {
        context.setObject(try source(file), forKeyedSubscript: "syntaxSource" as NSString)
        context.evaluateScript("new Function(syntaxSource)")
    }
    context.setObject(try source("background.js"), forKeyedSubscript: "backgroundSource" as NSString)
    context.evaluateScript(try source("core.js"), withSourceURL: root.appendingPathComponent("core.js"))
    context.evaluateScript(try source("tests/suite.js"), withSourceURL: root.appendingPathComponent("tests/suite.js"))
    if context.objectForKeyedSubscript("testDone")?.toBool() != true {
        fputs("Test suite did not complete\n", stderr)
        failed = true
    }
    if context.objectForKeyedSubscript("testFailures")?.toInt32() ?? 1 > 0 { failed = true }
} catch {
    fputs("\(error)\n", stderr)
    failed = true
}
exit(failed ? 1 : 0)
