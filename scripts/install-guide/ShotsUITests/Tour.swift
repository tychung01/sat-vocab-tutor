import XCTest

// Drives Safari and the home screen in the simulator through adding SAT Words
// to the home screen. Each step waits for the button it will tap, saves a
// screenshot into OUT_DIR (TEST_RUNNER_OUT_DIR), notes the button's frame, and taps it.
final class Tour: XCTestCase {
    let out = ProcessInfo.processInfo.environment["OUT_DIR"]!
    let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    var frames: [String: [Double]] = [:]  // shot name → frame of the element tapped on it, in points

    func save(_ name: String, _ app: XCUIApplication) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
        try? app.debugDescription.write(toFile: "\(out)/\(name).txt", atomically: true, encoding: .utf8)
    }

    func find(_ label: String, in app: XCUIApplication, wait: TimeInterval = 20) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(wait)
        while Date() < deadline {
            for el in [app.buttons[label], app.cells[label], app.icons[label]] where el.exists && el.isHittable && el.isEnabled {
                return el
            }
            usleep(300_000)
        }
        return nil
    }

    func step(_ shot: String, tap label: String, in app: XCUIApplication) {
        guard let el = find(label, in: app) else {
            save("fail-\(shot)", app)
            return XCTFail("no \(label) on \(shot)")
        }
        sleep(3)  // let animations and icons finish
        save(shot, app)
        let f = el.frame
        frames[shot] = [f.minX, f.minY, f.width, f.height]
        el.tap()
    }

    func testTour() {
        safari.terminate()
        safari.open(URL(string: "https://sat-word-study-bfabd.firebaseapp.com/")!)
        _ = safari.buttons["Sign in with Google"].waitForExistence(timeout: 30)
        // The first share sheet on a fresh simulator is slow to load; open it once and close it.
        find("Page Menu", in: safari)?.tap()
        find("Share", in: safari)?.tap()
        _ = find("View More", in: safari, wait: 120)
        safari.swipeDown()
        sleep(3)
        if find("View More", in: safari, wait: 1) != nil { safari.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap() }
        sleep(2)
        step("01-site", tap: "Page Menu", in: safari)
        step("02-menu", tap: "Share", in: safari)
        step("03-share", tap: "View More", in: safari)
        step("04-more", tap: "Add to Home Screen", in: safari)
        step("05-add", tap: "Add", in: safari)
        step("06-home", tap: "SAT Words", in: springboard)
        _ = safari.wait(for: .runningForeground, timeout: 5)
        sleep(6)
        save("07-app", springboard)
        try! JSONSerialization.data(withJSONObject: frames).write(to: URL(fileURLWithPath: "\(out)/frames.json"))
    }

    // Opens the installed home-screen app and waits for it to finish loading.
    func testOpen() {
        XCUIDevice.shared.press(.home)
        find("SAT Words", in: springboard)?.tap()
        sleep(25)
        save("07-app", springboard)
    }

    // Leaves the home screen on the page with SAT Words and records the icon's frame.
    // Then uninstall the runner and take 06-home.png with `simctl io screenshot`, so
    // the runner's own icon isn't in the shot.
    func testHome() {
        XCUIDevice.shared.press(.home)
        sleep(2)
        springboard.swipeLeft()
        guard let el = find("SAT Words", in: springboard) else { return XCTFail("no SAT Words icon") }
        let url = URL(fileURLWithPath: "\(out)/frames.json")
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: [Double]] ?? [:]
        let f = el.frame
        all["06-home"] = [f.minX, f.minY, f.width, f.height]
        try! JSONSerialization.data(withJSONObject: all).write(to: url)
    }
}
