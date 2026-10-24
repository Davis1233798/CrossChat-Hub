// Disposable macOS CI only. Launch the packaged bundle via Launch Services,
// verify a real on-screen window, and request normal application termination.
import AppKit
import CoreGraphics
import Foundation

enum SmokeFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String { switch self { case .failed(let message): return message } }
}
func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw SmokeFailure.failed(message) }
}
func waitUntil(seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        if condition() { return true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    } while Date() < deadline
    return condition()
}
func hasVisibleWindow(pid: pid_t) -> Bool {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
    return windows.contains { item in
        guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = item[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? NSNumber,
              let height = bounds["Height"] as? NSNumber else { return false }
        return width.doubleValue >= 600 && height.doubleValue >= 400
    }
}
func hasBundleProcesses(_ bundle: URL) throws -> Bool {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-axo", "pid=,command="]
    process.standardOutput = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    try check(process.terminationStatus == 0, "Could not inspect packaged application processes")
    // Do not log the process inventory or unrelated window titles.
    return String(decoding: data, as: UTF8.self).contains(bundle.path + "/Contents/")
}

var ownedApplication: NSRunningApplication?
do {
    try check(CommandLine.arguments.count == 4, "Expected installed bundle, temporary profile and version")
    let bundleURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    let profileURL = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
    let expectedVersion = CommandLine.arguments[3]
    guard let bundle = Bundle(url: bundleURL) else { throw SmokeFailure.failed("Invalid installed app bundle") }
    try check(bundle.bundleIdentifier == "dev.crosschat.hub", "Unexpected bundle identifier")
    try check(bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == expectedVersion, "Installed bundle version mismatch")
    try FileManager.default.createDirectory(at: profileURL, withIntermediateDirectories: true)
    for iteration in 1...2 {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = true
        configuration.arguments = ["--user-data-dir=" + profileURL.path]
        var completed = false
        var launchError: Error?
        NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { application, error in
            DispatchQueue.main.async {
                ownedApplication = application
                launchError = error
                completed = true
            }
        }
        try check(waitUntil(seconds: 20) { completed }, "Launch Services did not complete")
        if let error = launchError { throw error }
        guard let application = ownedApplication else { throw SmokeFailure.failed("No running packaged application") }
        try check(application.bundleURL?.standardizedFileURL == bundleURL, "Launch Services opened a different bundle")
        try check(waitUntil(seconds: 20) { !application.isTerminated && hasVisibleWindow(pid: application.processIdentifier) }, "Packaged application did not create an on-screen native window")
        try check(application.terminate(), "Packaged application rejected normal quit")
        try check(waitUntil(seconds: 12) { application.isTerminated }, "Packaged application did not exit normally")
        var processInspectionFailed = false
        let noResidualProcesses = waitUntil(seconds: 10) {
            do { return try !hasBundleProcesses(bundleURL) }
            catch { processInspectionFailed = true; return false }
        }
        try check(!processInspectionFailed && noResidualProcesses, "Packaged application left background processes")
        ownedApplication = nil
        print("PASS: packaged macOS launch \(iteration), on-screen native window, normal quit and no residual bundle processes")
    }
} catch {
    // Failure cleanup is scoped to the exact application instance this test owns.
    if let application = ownedApplication, !application.isTerminated { application.forceTerminate() }
    fputs("macOS installed smoke failed: \(error)\n", stderr)
    exit(1)
}
