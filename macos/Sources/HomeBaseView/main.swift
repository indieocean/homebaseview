import AppKit
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let web = WebViewController()
    private let server = ServerManager()
    private var notifier: Notifier!
    private var alertResetTimer: Timer?

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
        popover.contentSize = NSSize(width: 420, height: 640)
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        notifier = Notifier()
        notifier.onEvent = { [weak self] _, _ in self?.flashIcon() }
        notifier.onOpen = { [weak self] cameraId in
            self?.showPopover()
            self?.web.call("window.homebaseview && window.homebaseview.openCamera(\(cameraId))")
        }

        server.onReady = { [weak self] token in
            self?.web.load(token: token)
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

    private static func icon(alert: Bool) -> NSImage? {
        let name = alert ? "video.doorbell.fill" : "video.doorbell"
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "HomeBaseView")
            ?? NSImage(systemSymbolName: alert ? "video.fill" : "video", accessibilityDescription: "HomeBaseView")
        image?.isTemplate = !alert
        return alert ? image?.tinted(.systemRed) : image
    }

    private func flashIcon() {
        statusItem.button?.image = Self.icon(alert: true)
        alertResetTimer?.invalidate()
        alertResetTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.statusItem.button?.image = Self.icon(alert: false) }
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
        statusItem.button?.image = Self.icon(alert: false)
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
        server.restart()
    }
}

extension NSImage {
    func tinted(_ color: NSColor) -> NSImage {
        let image = self.copy() as! NSImage
        image.lockFocus()
        color.set()
        NSRect(origin: .zero, size: image.size).fill(using: .sourceAtop)
        image.unlockFocus()
        image.isTemplate = false
        return image
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
