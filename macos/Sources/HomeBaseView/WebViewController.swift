import AppKit
import AVFoundation
import WebKit

/// Hosts the HomeBaseView web UI and bridges the few things a web page can't do on its own.
@MainActor
final class WebViewController: NSViewController, WKScriptMessageHandlerWithReply, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate,
    @preconcurrency NSSharingServicePickerDelegate, NSSharingServiceDelegate {
    private(set) var webView: WKWebView!
    private var loadedToken: String?
    var onOpenWindow: (() -> Void)?
    var onPrefsChanged: (() -> Void)?
    /// Full screen requested (`on` with what's playing) or exit requested.
    var onFullscreen: ((_ on: Bool, _ playback: [String: Any]) -> Void)?
    /// The share menu (and the sheet a service opens) must not lose the popover underneath it.
    var onSharing: ((Bool) -> Void)?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the session cookie between launches
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "homebaseview")

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 640), configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        view = webView
        showMessage("Starting HomeBaseView…")
    }

    func load(token: String) {
        loadViewIfNeeded()
        guard token != loadedToken || webView.url?.host != "127.0.0.1" else { return }
        loadedToken = token
        var comps = URLComponents(url: ServerManager.baseURL, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        webView.load(URLRequest(url: comps.url!))
    }

    func showMessage(_ text: String) {
        loadViewIfNeeded()
        loadedToken = nil
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString("""
        <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0c11;color:#8b94a7;
        font:14px -apple-system,sans-serif;text-align:center;padding:24px;box-sizing:border-box">\(escaped)</body></html>
        """, baseURL: nil)
    }

    func call(_ js: String) {
        guard isViewLoaded else { return }
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Run `js` once the page is signed in and loaded (a freshly opened window needs a moment).
    func callWhenReady(_ js: String, attempt: Int = 0, then done: (() -> Void)? = nil) {
        guard isViewLoaded, attempt < 60 else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            let ready = (try? await self.webView.evaluateJavaScript("!!(window.homebaseview && window.homebaseview.ready)")) as? Bool
            if ready == true {
                _ = try? await self.webView.evaluateJavaScript(js)
                done?()
            } else {
                try? await Task.sleep(for: .milliseconds(250))
                self.callWhenReady(js, attempt: attempt + 1, then: done)
            }
        }
    }

    // MARK: JS -> native

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.securityOrigin.host == "127.0.0.1",
              let body = message.body as? [String: Any], let type = body["type"] as? String else {
            replyHandler(nil, "unsupported"); return
        }
        switch type {
        case "prefs":
            for key in Notifier.prefKeys { if let v = body[key] as? Bool { Notifier.setPref(key, v) } }
            onPrefsChanged?()
            replyHandler(Notifier.allPrefs, nil)
        case "getPrefs":
            replyHandler(Notifier.allPrefs, nil)
        case "fullscreen":
            onFullscreen?(body["on"] as? Bool ?? false, body)
            replyHandler(true, nil)
        case "shareFile":
            guard let path = body["path"] as? String, path.hasPrefix("/api/"),
                  let rect = body["rect"] as? [Double], rect.count == 4 else { replyHandler(nil, "bad request"); return }
            shareServerFile(path: path, from: NSRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3]), reply: replyHandler)
        case "openWindow":
            onOpenWindow?()
            replyHandler(true, nil)
        case "requestMic":
            // The server's FFmpeg captures the mic; macOS attributes it to this app.
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: replyHandler(true, nil)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    Task { @MainActor in replyHandler(granted, nil) }
                }
            default: replyHandler(false, nil)
            }
        default:
            replyHandler(nil, "unknown message")
        }
    }

    // MARK: Sharing (macOS share menu needs a real file, so fetch it from the local server first)

    nonisolated private static let shareDir = FileManager.default.temporaryDirectory.appendingPathComponent("HomeBaseView Share", isDirectory: true)

    private func shareServerFile(path: String, from rect: NSRect, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let token = loadedToken, let url = URL(string: path, relativeTo: ServerManager.baseURL) else {
            reply("Not connected to the server.", nil); return
        }
        var req = URLRequest(url: url, timeoutInterval: 120)
        req.setValue(token, forHTTPHeaderField: "X-HomeBaseView-Token")
        URLSession.shared.downloadTask(with: req) { tmp, response, error in
            let http = response as? HTTPURLResponse
            var file: URL?
            if let tmp, http?.statusCode == 200 {
                let fm = FileManager.default
                try? fm.removeItem(at: Self.shareDir) // only the latest shared clip is kept
                try? fm.createDirectory(at: Self.shareDir, withIntermediateDirectories: true)
                let name = (http?.suggestedFilename).flatMap { $0.isEmpty ? nil : $0 } ?? "Recording.mp4"
                let dest = Self.shareDir.appendingPathComponent(name)
                if (try? fm.moveItem(at: tmp, to: dest)) != nil { file = dest }
            }
            let failure = error?.localizedDescription ?? (http?.statusCode == 404 ? "The recording isn't available yet." : "Could not prepare the video.")
            Task { @MainActor in
                guard let file else { reply(failure, nil); return }
                self.showSharePicker(for: file, from: rect)
                reply(true, nil)
            }
        }.resume()
    }

    private func showSharePicker(for file: URL, from rect: NSRect) {
        onSharing?(true)
        let picker = NSSharingServicePicker(items: [file])
        picker.delegate = self
        // WKWebView is flipped, so page coordinates map straight onto it.
        let anchor = rect.width > 0 ? rect : NSRect(x: webView.bounds.midX, y: 40, width: 1, height: 1)
        picker.show(relativeTo: anchor, of: webView, preferredEdge: .minY)
    }

    func sharingServicePicker(_ picker: NSSharingServicePicker, didChoose service: NSSharingService?) {
        if service == nil { onSharing?(false) } // dismissed without choosing
    }

    func sharingServicePicker(_ picker: NSSharingServicePicker, delegateFor sharingService: NSSharingService) -> (any NSSharingServiceDelegate)? {
        self
    }

    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) { onSharing?(false) }
    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) { onSharing?(false) }

    func sharingService(_ sharingService: NSSharingService, sourceWindowForShareItems items: [Any], sharingContentScope: UnsafeMutablePointer<NSSharingService.SharingContentScope>) -> NSWindow? {
        view.window
    }

    // MARK: alert() / confirm() — WKWebView shows nothing unless we implement these

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    // MARK: Navigation and downloads (the "Still" button saves a JPEG)

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        let url = action.request.url
        let isLocal = url?.host == "127.0.0.1" || url?.scheme == "about" || url?.scheme == "blob" || url?.scheme == "data"
        if !isLocal, action.navigationType == .linkActivated, let url {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let base = (suggestedFilename as NSString).deletingPathExtension
        let ext = (suggestedFilename as NSString).pathExtension
        var dest = downloads.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = downloads.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        downloadDestinations[ObjectIdentifier(download)] = dest
        return dest
    }

    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Tink")?.play()
        // Recordings are big and easy to lose in Downloads; point at them.
        if let dest = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)), dest.pathExtension.lowercased() == "mp4" {
            NSWorkspace.shared.activateFileViewerSelecting([dest])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert()
        alert.messageText = "Couldn't save the file"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showMessage("Can't reach the HomeBaseView server. It will retry automatically.")
    }
}
