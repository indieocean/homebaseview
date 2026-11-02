import AppKit
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let web = WebViewController()
    private let server = ServerManager()
    private var notifier: Notifier!
    private let alertDot = NSView()
    private var popoverPins = Set<String>()
    /// Set while the window is in our own full screen (used when macOS refuses native full screen).
    private var savedWindowState: (frame: NSRect, style: NSWindow.StyleMask)?
    /// The window's normal frame, recorded before any full screen attempt changes it.
    private var normalWindowFrame: NSRect?
    private var escMonitor: Any?
    private static let windowStyle: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
    private var hasUnread = false
    private var window: NSWindow?
    private var windowWeb: WebViewController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = Self.icon()
            button.toolTip = "HomeBaseView"
            button.action = #selector(statusClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])

            // Unread badge: a red dot over the icon's top-right corner. A separate view so the
            // icon itself stays a template image that adapts to light/dark menu bars.
            alertDot.wantsLayer = true
            alertDot.layer?.backgroundColor = NSColor.systemRed.cgColor
            alertDot.layer?.cornerRadius = 3.5
            alertDot.isHidden = true
            alertDot.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(alertDot)
            NSLayoutConstraint.activate([
                alertDot.widthAnchor.constraint(equalToConstant: 7),
                alertDot.heightAnchor.constraint(equalToConstant: 7),
                alertDot.centerXAnchor.constraint(equalTo: button.centerXAnchor, constant: 6),
                alertDot.centerYAnchor.constraint(equalTo: button.centerYAnchor, constant: -6),
            ])
        }

        web.loadViewIfNeeded() // the page loads in the background so it opens instantly
        popover.contentViewController = web
        popover.contentSize = NSSize(width: 460, height: 720)
        web.onOpenWindow = { [weak self] in self?.openWindow() }
        web.onPrefsChanged = { [weak self] in self?.prefsChanged() }
        // A transient popover closes when another window takes focus, and closing stops the video,
        // so pin it open while its video is full screen.
        web.onFullscreen = { [weak self] on, playback in self?.fullscreenRequested(on, playback) }
        web.onSharing = { [weak self] on in self?.keepPopoverOpen("sharing", on) }
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        notifier = Notifier()
        notifier.onEvent = { [weak self] _, kind in self?.eventArrived(kind: kind) }
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
    private static func icon() -> NSImage? {
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
            lens.stroke()
            NSBezierPath(ovalIn: NSRect(x: 8.1, y: 9.8, width: 1.8, height: 1.8)).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "HomeBaseView"
        return image
    }

    /// Whether the UI is on screen right now (then new activity is already visible, no dot needed).
    private var isUIVisible: Bool {
        popover.isShown || (window?.isVisible == true && window?.isKeyWindow == true)
    }

    private func eventArrived(kind: String) {
        guard Notifier.isAlert(kind: kind), !isUIVisible else { return }
        hasUnread = true
        updateDot()
    }

    private func clearUnread() {
        hasUnread = false
        updateDot()
    }

    private func updateDot() {
        let show = hasUnread && Notifier.dotEnabled
        alertDot.isHidden = !show
        statusItem.button?.toolTip = show ? "HomeBaseView — new activity" : "HomeBaseView"
        statusItem.button?.setAccessibilityLabel(show ? "HomeBaseView, new activity" : "HomeBaseView")
    }

    // MARK: Full screen video

    /// Video full screen happens in the app window, never the popover: a popover floats above the
    /// full screen space and closes when it loses focus. The window's page plays the same thing
    /// with only the video showing, and the window goes full screen.
    private func fullscreenRequested(_ on: Bool, _ playback: [String: Any]) {
        guard on else {
            if savedWindowState != nil { exitFallbackFullScreen() }
            else if let window, window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
            else { windowWeb?.call("window.homebaseview && window.homebaseview.fullscreenEnded()") }
            return
        }
        let args: [String: Any] = [
            "mode": playback["mode"] as? String ?? "live",
            "cameraId": playback["cameraId"] as? Int ?? 0,
            "eventId": playback["eventId"] as? String ?? NSNull(),
            "time": playback["time"] as? Double ?? 0,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: args),
              let json = String(data: data, encoding: .utf8) else { return }
        openWindow() // closes the popover, which stops its copy of the video
        windowWeb?.callWhenReady("window.homebaseview.playFullscreen(\(json))") { [weak self] in
            guard let self, let window = self.window,
                  !window.styleMask.contains(.fullScreen), self.savedWindowState == nil else { return }
            self.normalWindowFrame = window.frame
            window.toggleFullScreen(nil) // falls back below if macOS refuses
        }
    }

    var isWindowFullScreen: Bool {
        savedWindowState != nil || window?.styleMask.contains(.fullScreen) == true
    }

    func exitWindowFullScreen() {
        if savedWindowState != nil { exitFallbackFullScreen() }
        else if let window, window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
    }

    func windowWillEnterFullScreen(_ notification: Notification) {
        // Covers the green button too. Only record a real windowed frame.
        if let window, savedWindowState == nil, let screen = window.screen,
           window.frame.width < screen.frame.width - 1 || window.frame.height < screen.frame.height - 1 {
            normalWindowFrame = window.frame
        }
        installEscMonitor()
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        installEscMonitor()
    }

    /// Esc leaves full screen even when the web page doesn't have keyboard focus.
    private func installEscMonitor() {
        guard escMonitor == nil else { return }
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.keyCode == 53, self.isWindowFullScreen, event.window === self.window else { return event }
            self.exitWindowFullScreen()
            return nil
        }
    }

    private func removeEscMonitor() {
        if let escMonitor { NSEvent.removeMonitor(escMonitor) }
        escMonitor = nil
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        removeEscMonitor()
        normalWindowFrame = nil
        windowWeb?.call("window.homebaseview && window.homebaseview.fullscreenEnded()")
    }

    /// macOS sometimes refuses native full screen for this window (it beeps). Then cover the screen
    /// ourselves: no title bar, window sized to the display, menu bar and Dock hidden.
    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        NSLog("[HomeBaseView] native full screen refused; using window full screen")
        enterFallbackFullScreen()
    }

    private func enterFallbackFullScreen() {
        guard let window, savedWindowState == nil, let screen = window.screen ?? NSScreen.main else { return }
        // The failed native attempt can leave the window mid-transition (screen sized, .fullScreen
        // set), so restore to the frame from before it and the plain window style.
        var frame = normalWindowFrame ?? window.frame
        if frame.width >= screen.frame.width - 1 || frame.height >= screen.frame.height - 1 {
            frame = NSRect(x: screen.visibleFrame.midX - 550, y: screen.visibleFrame.midY - 380, width: 1100, height: 760)
        }
        savedWindowState = (frame, Self.windowStyle)
        // Auto-hide (not hide) so moving to the top edge still reveals the menu bar and its icon.
        NSApp.presentationOptions = [.autoHideDock, .autoHideMenuBar]
        window.styleMask = [.borderless, .resizable]
        window.setFrame(screen.frame, display: true, animate: false)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(windowWeb?.webView)
        NSApp.activate(ignoringOtherApps: true)
        installEscMonitor()
        // The page may not be in video-only mode yet if the green button started this.
        windowWeb?.call("window.homebaseview && window.homebaseview.enterVideoOnly && window.homebaseview.enterVideoOnly()")
    }

    private func exitFallbackFullScreen() {
        guard let window, let saved = savedWindowState else { return }
        savedWindowState = nil
        normalWindowFrame = nil
        removeEscMonitor()
        NSApp.presentationOptions = []
        window.styleMask = saved.style
        window.setFrame(saved.frame, display: true, animate: false)
        window.makeKeyAndOrderFront(nil)
        windowWeb?.call("window.homebaseview && window.homebaseview.fullscreenEnded()")
    }

    /// While anything needs it (the share menu), stop the popover closing on outside clicks.
    private func keepPopoverOpen(_ reason: String, _ on: Bool) {
        if on { popoverPins.insert(reason) } else { popoverPins.remove(reason) }
        popover.behavior = popoverPins.isEmpty ? .transient : .applicationDefined
    }

    private func prefsChanged() {
        updateDot()
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
        let jumpToActivity = hasUnread
        clearUnread()
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        if jumpToActivity { web.call("window.homebaseview && window.homebaseview.showActivity()") }
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
        if isWindowFullScreen {
            menu.addItem(withTitle: "Exit Full Screen", action: #selector(exitFullScreenAction), keyEquivalent: "").target = self
            menu.addItem(.separator())
        }
        menu.addItem(withTitle: "Open HomeBaseView", action: #selector(openPopover), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open in Window", action: #selector(openWindowAction), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(notificationsMenuItem())
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

    private func notificationsMenuItem() -> NSMenuItem {
        notifier.refreshAuthorization() // for next time; the cached value is at most one menu-open old
        let sub = NSMenu()
        if notifier.systemAuthorization == .denied {
            let off = sub.addItem(withTitle: "Turned off in System Settings", action: nil, keyEquivalent: "")
            off.isEnabled = false
        }
        let rows: [(String, String)] = [
            ("Show Notifications", "notify"),
            ("Alert on Motion", "notifyMotion"),
            ("Red Dot on Menu Bar Icon", "menuBarDot"),
        ]
        for (title, key) in rows {
            let item = sub.addItem(withTitle: title, action: #selector(togglePref(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            item.state = Notifier.pref(key) ? .on : .off
        }
        if let note = sub.items.first(where: { ($0.representedObject as? String) == "notifyMotion" }) {
            note.toolTip = "Doorbell presses always alert. Turn off to ignore motion for banners and the red dot."
        }
        sub.addItem(.separator())
        sub.addItem(withTitle: "macOS Notification Settings…", action: #selector(openSystemNotificationSettings), keyEquivalent: "").target = self

        let item = NSMenuItem(title: "Notifications", action: nil, keyEquivalent: "")
        item.submenu = sub
        return item
    }

    @objc private func togglePref(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Notifier.setPref(key, !Notifier.pref(key))
        prefsChanged()
        let js = "window.homebaseview && window.homebaseview.prefsChanged && window.homebaseview.prefsChanged()"
        web.call(js)
        windowWeb?.call(js)
    }

    @objc private func openSystemNotificationSettings() {
        let id = Bundle.main.bundleIdentifier ?? "com.TheRanchSteamLab.homebaseview"
        let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")
            ?? URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
        NSWorkspace.shared.open(url)
    }

    @objc private func openPopover() { showPopover() }
    @objc private func exitFullScreenAction() { exitWindowFullScreen() }
    @objc private func openWindowAction() { openWindow() }

    /// A resizable window with the same UI — better for watching a live feed for a while.
    func openWindow() {
        popover.performClose(nil)
        if window == nil {
            let controller = WebViewController()
            controller.loadViewIfNeeded()
            let win = KeyableWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                               styleMask: Self.windowStyle,
                               backing: .buffered, defer: false)
            win.title = "HomeBaseView"
            win.contentViewController = controller
            win.setContentSize(NSSize(width: 1100, height: 760))
            win.contentMinSize = NSSize(width: 420, height: 560)
            win.isReleasedWhenClosed = false
            win.delegate = self
            win.setFrameAutosaveName("HomeBaseViewMain")
            win.collectionBehavior.insert(.fullScreenPrimary)
            if win.frame.origin == .zero { win.center() }
            window = win
            windowWeb = controller
            if let token = server.token { controller.load(token: token) }
        }
        NSApp.setActivationPolicy(.regular) // show in the Dock and Cmd-Tab while the window is open
        if hasUnread { windowWeb?.call("window.homebaseview && window.homebaseview.showActivity()") }
        clearUnread()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowDidBecomeKey(_ notification: Notification) {
        clearUnread()
    }

    func windowWillClose(_ notification: Notification) {
        if savedWindowState != nil { exitFallbackFullScreen() }
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

/// A window that can stay key after losing its title bar (borderless windows can't by default).
final class KeyableWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
