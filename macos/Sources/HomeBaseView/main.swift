import AppKit
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let web = WebViewController()
    private let server = ServerManager()
    private var notifier: Notifier!
    private var alertResetTimer: Timer?
    private var window: NSWindow?
    private var windowWeb: WebViewController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = Self.icon(alert: false)
            button.toolTip = "HomeBaseView"
            button.action = #selector(statusClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        web.loadViewIfNeeded() // the page loads in the background so it opens instantly
        popover.contentViewController = web
        popover.contentSize = NSSize(width: 460, height: 720)
        web.onOpenWindow = { [weak self] in self?.openWindow() }
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        notifier = Notifier()
        notifier.onEvent = { [weak self] _, _ in self?.flashIcon() }
        notifier.onOpen = { [weak self] cameraId in
            guard let self else { return }
            if let window = self.window, window.isVisible {
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                self.windowWeb?.call("window.homebaseview && window.homebaseview.openCamera(\(cameraId))")
            } else {
                self.showPopover()
                self.web.call("window.homebaseview && window.homebaseview.openCamera(\(cameraId))")
            }
        }

        server.onReady = { [weak self] token in
            self?.web.load(token: token)
            self?.windowWeb?.load(token: token)
            self?.notifier.start(token: token)
        }
        server.onFailure = { [weak self] message in
            self?.notifier.stop()
            self?.web.showMessage(message)
        }
        server.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    // MARK: Status item

    /// Menu bar glyph: the logo's house with a camera lens, drawn as a template image.
    private static func icon(alert: Bool) -> NSImage? {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            NSColor.black.set()
            let house = NSBezierPath()
            house.lineWidth = 1.6
            house.lineJoinStyle = .round
            house.lineCapStyle = .round
            house.move(to: NSPoint(x: 2.8, y: 8.2))
            house.line(to: NSPoint(x: 9, y: 3))
            house.line(to: NSPoint(x: 15.2, y: 8.2))
            house.line(to: NSPoint(x: 15.2, y: 14))
            house.curve(to: NSPoint(x: 13.9, y: 15.3), controlPoint1: NSPoint(x: 15.2, y: 14.7), controlPoint2: NSPoint(x: 14.6, y: 15.3))
            house.line(to: NSPoint(x: 4.1, y: 15.3))
            house.curve(to: NSPoint(x: 2.8, y: 14), controlPoint1: NSPoint(x: 3.4, y: 15.3), controlPoint2: NSPoint(x: 2.8, y: 14.7))
            house.close()
            house.stroke()
            let lens = NSBezierPath(ovalIn: NSRect(x: 6.3, y: 8, width: 5.4, height: 5.4))
            lens.lineWidth = 1.5
            if alert { lens.fill() } else { lens.stroke() }
            if !alert { NSBezierPath(ovalIn: NSRect(x: 8.1, y: 9.8, width: 1.8, height: 1.8)).fill() }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "HomeBaseView"
        return image
    }

    private func setIcon(alert: Bool) {
        statusItem.button?.image = Self.icon(alert: alert)
        statusItem.button?.contentTintColor = alert ? .systemRed : nil
    }

    private func flashIcon() {
        setIcon(alert: true)
        alertResetTimer?.invalidate()
        alertResetTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.setIcon(alert: false) }
        }
    }

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else if popover.isShown {
            popover.performClose(nil)
        } else {
            showPopover()
        }
    }

    private func showPopover() {
        guard let button = statusItem.button else { return }
        setIcon(alert: false)
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
    }

    func popoverDidShow(_ notification: Notification) {
        web.call("window.homebaseview && window.homebaseview.shown()")
    }

    func popoverDidClose(_ notification: Notification) {
        // Stop any live view so the camera isn't streaming to a hidden window.
        web.call("window.homebaseview && window.homebaseview.hidden()")
    }

    /// Drag the popover away from the menu bar to keep it open as a floating window.
    func popoverShouldDetach(_ popover: NSPopover) -> Bool { true }

    // MARK: Menu

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open HomeBaseView", action: #selector(openPopover), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open in Window", action: #selector(openWindowAction), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "").target = self
        menu.addItem(.separator())
        let login = menu.addItem(withTitle: "Launch at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(withTitle: "Show Server Log", action: #selector(showLog), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Restart Server", action: #selector(restartServer), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit HomeBaseView", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil // keep left-click for the popover
    }

    @objc private func openPopover() { showPopover() }
    @objc private func openWindowAction() { openWindow() }

    /// A resizable window with the same UI — better for watching a live feed for a while.
    func openWindow() {
        popover.performClose(nil)
        if window == nil {
            let controller = WebViewController()
            controller.loadViewIfNeeded()
            let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                               styleMask: [.titled, .closable, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
            win.title = "HomeBaseView"
            win.contentViewController = controller
            win.setContentSize(NSSize(width: 1100, height: 760))
            win.contentMinSize = NSSize(width: 420, height: 560)
            win.isReleasedWhenClosed = false
            win.delegate = self
            win.setFrameAutosaveName("HomeBaseViewMain")
            if win.frame.origin == .zero { win.center() }
            window = win
            windowWeb = controller
            if let token = server.token { controller.load(token: token) }
        }
        NSApp.setActivationPolicy(.regular) // show in the Dock and Cmd-Tab while the window is open
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        windowWeb?.call("window.homebaseview && window.homebaseview.hidden()")
        NSApp.setActivationPolicy(.accessory)
    }

    @objc private func openInBrowser() {
        guard let token = server.token,
              var comps = URLComponents(url: ServerManager.baseURL, resolvingAgainstBaseURL: false) else { return }
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        if let url = comps.url { NSWorkspace.shared.open(url) }
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Launch at Login"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    @objc private func showLog() {
        NSWorkspace.shared.open(ServerManager.logURL)
    }

    @objc private func restartServer() {
        notifier.stop()
        web.showMessage("Restarting server…")
        windowWeb?.showMessage("Restarting server…")
        server.restart()
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
