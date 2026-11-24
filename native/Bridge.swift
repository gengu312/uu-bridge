import AppKit
import ApplicationServices
import ScreenCaptureKit
import Darwin

struct BridgeFailure: Error {
    let code: String
    let message: String
}

@MainActor
final class NativeBridge: NSObject, NSWindowDelegate {
    private let uuBundle = "com.netease.uuremote"
    private var selectedID: CGWindowID?
    private var selectedPID: pid_t?
    private var selectionVersion = 0
    private var heldButton: CGMouseButton?
    private var lastPoint = CGPoint.zero
    private var testWindow: NSWindow?
    private var testInput: NSTextField?
    private var testCounter: NSTextField?
    private var testClicks = 0

    // WebKit's CoreGraphicsTestSPI.h declares this SPI and the window ID field.
    // https://github.com/WebKit/WebKit/blob/main/Tools/TestRunnerShared/spi/CoreGraphicsTestSPI.h
    private static let windowIDField = CGEventField(rawValue: 51)!
    private static let setWindowLocation: (@convention(c) (CGEvent, CGPoint) -> Void)? = {
        guard let handle = dlopen(nil, RTLD_LAZY) else { return nil }
        defer { dlclose(handle) }
        guard let symbol = dlsym(handle, "CGEventSetWindowLocation") else { return nil }
        return unsafeBitCast(symbol, to: (@convention(c) (CGEvent, CGPoint) -> Void).self)
    }()

    private func failure(_ code: String, _ message: String) -> BridgeFailure {
        BridgeFailure(code: code, message: message)
    }

    private func allowed(_ pid: pid_t) -> Bool {
        if pid == ProcessInfo.processInfo.processIdentifier { return testWindow != nil }
        return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == uuBundle
    }

    private func windowInfo() -> [[String: Any]] {
        let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return info.filter { row in
            guard let pid = row[kCGWindowOwnerPID as String] as? Int32,
                  let layer = row[kCGWindowLayer as String] as? Int, layer == 0,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  rect.width > 80, rect.height > 60 else { return false }
            if pid == ProcessInfo.processInfo.processIdentifier {
                return (row[kCGWindowNumber as String] as? Int) == testWindow?.windowNumber
            }
            return allowed(pid)
        }
    }

    private func window(_ id: CGWindowID) throws -> (pid: pid_t, frame: CGRect) {
        guard let row = windowInfo().first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }),
              let pid = row[kCGWindowOwnerPID as String] as? Int32,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else {
            throw failure("WINDOW_GONE", "窗口已关闭或不可用，请刷新并重新选择。")
        }
        return (pid, rect)
    }

    private func selection(expected request: [String: Any]? = nil) throws -> (id: CGWindowID, pid: pid_t, frame: CGRect) {
        guard let id = selectedID, let pid = selectedPID else {
            throw failure("NO_WINDOW", "请先选择一个 UU 窗口。")
        }
        if let request {
            guard (request["windowId"] as? NSNumber)?.uint32Value == id,
                  (request["selectionVersion"] as? Int) == selectionVersion else {
                throw failure("SELECTION_CHANGED", "目标窗口已改变，请刷新窗口列表并重新开始画面。")
            }
        }
        let current = try window(id)
        guard current.pid == pid else {
            throw failure("WINDOW_GONE", "窗口所属进程已改变，请重新选择。")
        }
        return (id, pid, current.frame)
    }

    func handle(_ request: [String: Any]) async throws -> [String: Any] {
        switch request["command"] as? String ?? "" {
        case "status":
            let applications = NSRunningApplication.runningApplications(withBundleIdentifier: uuBundle)
            return [
                "screenCapture": CGPreflightScreenCaptureAccess(),
                "accessibility": AXIsProcessTrusted(),
                "installed": NSWorkspace.shared.urlForApplication(withBundleIdentifier: uuBundle) != nil,
                "running": !applications.isEmpty,
                "nativeAvailable": true,
                "platform": "darwin",
                "selectionVersion": selectionVersion,
                "selectedId": selectedID.map { Int($0) } as Any? ?? NSNull()
            ]
        case "windows":
            let windows: [[String: Any]] = windowInfo().compactMap { row in
                guard let id = row[kCGWindowNumber as String] as? UInt32,
                      let pid = row[kCGWindowOwnerPID as String] as? Int32,
                      let bounds = row[kCGWindowBounds as String] as? [String: Any],
                      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
                return ["id": id, "pid": pid,
                        "owner": row[kCGWindowOwnerName as String] as? String ?? "UU",
                        "title": row[kCGWindowName as String] as? String ?? "UU 窗口",
                        "width": rect.width, "height": rect.height,
                        "kind": pid == ProcessInfo.processInfo.processIdentifier ? "test" : "uu"]
            }
            return ["windows": windows, "selectedId": selectedID.map { Int($0) } as Any? ?? NSNull(), "selectionVersion": selectionVersion]
        case "select":
            guard let number = request["windowId"] as? NSNumber else { throw failure("BAD_INPUT", "无效的窗口 ID。") }
            let id = number.uint32Value
            let target = try window(id)
            releaseMouse()
            selectedID = id
            selectedPID = target.pid
            selectionVersion += 1
            return ["selectedId": id, "selectionVersion": selectionVersion]
        case "frame":
            let target = try selection(expected: request)
            let capturedVersion = selectionVersion
            if target.pid == ProcessInfo.processInfo.processIdentifier {
                var result = try renderTestWindow()
                result["windowId"] = target.id
                result["selectionVersion"] = capturedVersion
                return result
            }
            guard CGPreflightScreenCaptureAccess() else {
                throw failure("SCREEN_PERMISSION", "请在系统设置中允许 UU Bridge 录制屏幕。")
            }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            guard let source = content.windows.first(where: { $0.windowID == target.id && $0.owningApplication?.processID == target.pid }) else {
                throw failure("WINDOW_GONE", "找不到可采集的窗口，请恢复窗口并刷新。")
            }
            let filter = SCContentFilter(desktopIndependentWindow: source)
            let config = SCStreamConfiguration()
            let scale = min(2.0, 1920.0 / max(source.frame.width, source.frame.height))
            config.width = max(1, Int(source.frame.width * scale))
            config.height = max(1, Int(source.frame.height * scale))
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            config.shouldBeOpaque = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let rep = NSBitmapImageRep(cgImage: image)
            guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
                throw failure("CAPTURE_FAILED", "无法编码窗口画面。")
            }
            return ["jpeg": data.base64EncodedString(), "width": image.width, "height": image.height, "source": "screen-capture-kit",
                    "windowId": target.id, "selectionVersion": capturedVersion]
        case "input":
            guard AXIsProcessTrusted() else {
                throw failure("ACCESSIBILITY_PERMISSION", "请在系统设置中允许 UU Bridge 使用辅助功能。")
            }
            let target = try selection(expected: request)
            guard target.pid == ProcessInfo.processInfo.processIdentifier else {
                throw failure("UU_INPUT_UNSUPPORTED", "当前 UU 客户端不接受后台模拟输入。此桥接入口仅用于查看；请使用本地 UU 网页主控进行操作。")
            }
            try sendInput(request, to: target)
            return ["ok": true, "targetPid": target.pid, "windowId": target.id]
        case "release":
            if request["windowId"] != nil || request["selectionVersion"] != nil {
                guard (request["windowId"] as? NSNumber)?.uint32Value == selectedID,
                      (request["selectionVersion"] as? Int) == selectionVersion else {
                    return ["ok": true, "released": false]
                }
            }
            releaseMouse()
            // Invalidate the selection before any delayed mouse-down can arrive.
            selectionVersion += 1
            return ["ok": true, "released": true, "selectionVersion": selectionVersion]
        case "permissions":
            if request["kind"] as? String == "screen" {
                _ = CGRequestScreenCaptureAccess()
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                    NSWorkspace.shared.open(url)
                }
            } else {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                    NSWorkspace.shared.open(url)
                }
            }
            return ["message": "请在系统设置中授权，然后刷新权限状态。"]
        case "open-uu":
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: uuBundle) else {
                throw failure("UU_NOT_INSTALLED", "未找到 UU 客户端，请先安装官方 macOS 版。")
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            return ["message": "已打开 UU，请在官方客户端完成登录与连接。"]
        case "test-window":
            showTestWindow()
            return ["windowId": testWindow!.windowNumber, "message": "已打开本机验证窗口，不会连接任何远端设备。"]
        case "test-state":
            return ["clicks": testClicks, "text": testInput?.currentEditor()?.string ?? testInput?.stringValue ?? "", "windowId": testWindow?.windowNumber as Any? ?? NSNull(),
                     "active": NSApp.isActive]
        default:
            throw failure("BAD_COMMAND", "不支持的操作。")
        }
    }

    private func flags(_ request: [String: Any]) -> CGEventFlags {
        var result: CGEventFlags = []
        for name in request["modifiers"] as? [String] ?? [] {
            switch name {
            case "meta": result.insert(.maskCommand)
            case "shift": result.insert(.maskShift)
            case "alt": result.insert(.maskAlternate)
            case "ctrl": result.insert(.maskControl)
            default: break
            }
        }
        return result
    }

    private func post(_ event: CGEvent?, target: (id: CGWindowID, pid: pid_t, frame: CGRect)) throws {
        guard let event else { throw failure("INPUT_FAILED", "无法创建输入事件。") }
        event.setIntegerValueField(Self.windowIDField, value: Int64(target.id))
        switch event.type {
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
             .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged,
             .rightMouseDragged, .otherMouseDragged, .scrollWheel:
            guard let setWindowLocation = Self.setWindowLocation else {
                throw failure("BACKGROUND_INPUT_UNAVAILABLE", "当前系统缺少后台鼠标投递所需的窗口坐标接口。")
            }
            // Setting the global location invalidates the separate window location.
            // Restore it last, in Quartz coordinates relative to the window's top left.
            let point = event.location
            setWindowLocation(event, CGPoint(x: point.x - target.frame.minX,
                                             y: point.y - target.frame.minY))
        default: break
        }
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.id))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.id))
        event.postToPid(target.pid)
    }

    private func sendInput(_ request: [String: Any], to target: (id: CGWindowID, pid: pid_t, frame: CGRect)) throws {
        let type = request["type"] as? String ?? ""
        let source = CGEventSource(stateID: .privateState)
        let eventFlags = flags(request)
        if ["click", "pointerdown", "pointerup", "move", "scroll"].contains(type) {
            guard let x = request["x"] as? Double, let y = request["y"] as? Double,
                  x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else {
                throw failure("BAD_INPUT", "鼠标坐标必须在画面范围内。")
            }
            let point = CGPoint(x: target.frame.minX + x * (target.frame.width - 1),
                                y: target.frame.minY + y * (target.frame.height - 1))
            lastPoint = point
            let button: CGMouseButton = request["button"] as? String == "right" ? .right : (request["button"] as? String == "middle" ? .center : .left)
            func mouse(_ type: CGEventType, _ button: CGMouseButton) throws {
                let event = CGEvent(mouseEventSource: source, mouseType: type,
                                    mouseCursorPosition: point, mouseButton: button)
                event?.flags = eventFlags
                event?.setIntegerValueField(.mouseEventClickState, value: Int64(request["clickCount"] as? Int ?? 1))
                try post(event, target: target)
            }
            let down: CGEventType = button == .right ? .rightMouseDown : (button == .center ? .otherMouseDown : .leftMouseDown)
            let up: CGEventType = button == .right ? .rightMouseUp : (button == .center ? .otherMouseUp : .leftMouseUp)
            switch type {
            case "click":
                try mouse(down, button)
                try mouse(up, button)
            case "pointerdown":
                try mouse(down, button)
                heldButton = button
            case "pointerup":
                try mouse(up, button)
                heldButton = nil
            case "move":
                let move: CGEventType = heldButton == .left ? .leftMouseDragged : (heldButton == .right ? .rightMouseDragged : (heldButton == .center ? .otherMouseDragged : .mouseMoved))
                try mouse(move, heldButton ?? button)
            case "scroll":
                let dy = max(-2000, min(2000, request["deltaY"] as? Double ?? 0))
                let dx = max(-2000, min(2000, request["deltaX"] as? Double ?? 0))
                let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -Int32(dy), wheel2: -Int32(dx), wheel3: 0)
                event?.location = point
                event?.flags = eventFlags
                try post(event, target: target)
            default: break
            }
            return
        }
        if type == "text" {
            let text = request["text"] as? String ?? ""
            guard !text.isEmpty, text.utf16.count <= 4096 else { throw failure("BAD_INPUT", "请输入 1–4096 个字符。") }
            // UTF-16 chunks avoid exceeding Core Graphics' per-event string capacity.
            for character in text {
                let units = Array(String(character).utf16)
                for isDown in [true, false] {
                    let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
                    units.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                    try post(event, target: target)
                }
            }
            return
        }
        if type == "key" {
            let key = request["key"] as? String ?? ""
            guard let keyCode = Self.keyCodes[key] ?? Self.keyCodes[key.lowercased()] else {
                if key.count == 1 && eventFlags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty {
                    try sendInput(["type": "text", "text": key], to: target)
                    return
                }
                throw failure("UNSUPPORTED_KEY", "暂不支持这个按键：\(key)")
            }
            for isDown in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: isDown)
                event?.flags = eventFlags
                try post(event, target: target)
            }
            return
        }
        throw failure("BAD_INPUT", "不支持的输入类型。")
    }

    private func releaseMouse() {
        guard let button = heldButton, let target = try? selection() else { heldButton = nil; return }
        let type: CGEventType = button == .right ? .rightMouseUp : (button == .center ? .otherMouseUp : .leftMouseUp)
        let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: lastPoint, mouseButton: button)
        try? post(event, target: target)
        heldButton = nil
    }

    private static let keyCodes: [String: CGKeyCode] = [
        "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,
        "q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,
        "=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
        "]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"Enter":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,
        "Tab":48," ":49,"Backspace":51,"Escape":53,"Delete":117,
        "Home":115,"End":119,"PageUp":116,"PageDown":121,
        "ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,
        "F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111
    ]

    private func renderTestWindow() throws -> [String: Any] {
        guard let window = testWindow, let view = window.contentView,
              let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            throw failure("CAPTURE_FAILED", "无法绘制本机验证窗口。")
        }
        // Render only our own view hierarchy. This never reads another app or the screen.
        view.displayIfNeeded()
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let canvas = NSImage(size: window.frame.size)
        canvas.lockFocus()
        NSColor.windowBackgroundColor.setFill()
        NSRect(origin: .zero, size: window.frame.size).fill()
        bitmap.draw(in: NSRect(origin: .zero, size: view.bounds.size))
        ("UU Bridge · 本机验证（应用自身绘制）" as NSString).draw(
            at: NSPoint(x: 20, y: view.bounds.height + 8),
            withAttributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor])
        canvas.unlockFocus()
        guard let tiff = canvas.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            throw failure("CAPTURE_FAILED", "无法编码验证窗口画面。")
        }
        return ["jpeg": data.base64EncodedString(), "width": rep.pixelsWide, "height": rep.pixelsHigh, "source": "app-rendered-test"]
    }

    private func showTestWindow() {
        if let testWindow { testWindow.makeKeyAndOrderFront(nil); return }
        let window = NSWindow(contentRect: NSRect(x: 150, y: 180, width: 640, height: 360),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "UU Bridge · 输入验证"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
        window.contentView = view
        let heading = NSTextField(labelWithString: "本地桥接验证")
        heading.font = .boldSystemFont(ofSize: 26)
        heading.frame = NSRect(x: 40, y: 280, width: 550, height: 36)
        view.addSubview(heading)
        let subtitle = NSTextField(labelWithString: "这里的点击和输入不会影响任何远端电脑。")
        subtitle.frame = NSRect(x: 40, y: 245, width: 550, height: 25)
        view.addSubview(subtitle)
        let input = NSTextField(frame: NSRect(x: 40, y: 175, width: 550, height: 36))
        input.placeholderString = "在浏览器里点击这里，再发送文字"
        input.font = .systemFont(ofSize: 17)
        view.addSubview(input)
        let button = NSButton(title: "点击验证 +1", target: self, action: #selector(increment))
        button.bezelStyle = .rounded
        button.frame = NSRect(x: 40, y: 95, width: 180, height: 45)
        view.addSubview(button)
        let counter = NSTextField(labelWithString: "收到点击：0")
        counter.frame = NSRect(x: 250, y: 104, width: 300, height: 26)
        counter.font = .monospacedDigitSystemFont(ofSize: 20, weight: .medium)
        view.addSubview(counter)
        testInput = input
        testCounter = counter
        testWindow = window
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func increment() {
        testClicks += 1
        testCounter?.stringValue = "收到点击：\(testClicks)"
    }

    func windowWillClose(_ notification: Notification) {
        if let id = selectedID, id == testWindow.map({ CGWindowID($0.windowNumber) }) {
            releaseMouse()
            selectedID = nil
            selectedPID = nil
            selectionVersion += 1
        }
    }
}

@main
struct BridgeMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let bridge = NativeBridge()
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                Task { @MainActor in
                    var response: [String: Any] = [:]
                    do {
                        guard let bytes = line.data(using: .utf8),
                              let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                            throw BridgeFailure(code: "BAD_JSON", message: "无效的 JSON 请求。")
                        }
                        response["id"] = request["id"]
                        response["result"] = try await bridge.handle(request)
                    } catch let error as BridgeFailure {
                        response["error"] = ["code": error.code, "message": error.message]
                    } catch {
                        response["error"] = ["code": "NATIVE_ERROR", "message": error.localizedDescription]
                    }
                    if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
                       let encoded = String(data: data, encoding: .utf8) {
                        print(encoded)
                        fflush(stdout)
                    }
                }
            }
            Task { @MainActor in
                _ = try? await bridge.handle(["command": "release"])
                app.terminate(nil)
            }
        }
        app.run()
    }
}
