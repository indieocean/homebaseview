import AppKit
import AVFoundation
import WebKit

/// Hosts the HomeView web UI and bridges the few things a web page can't do on its own.
@MainActor
final class WebViewController: NSViewController, WKScriptMessageHandlerWithReply, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    private(set) var webView: WKWebView!
    private var loadedToken: String?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the session cookie between launches
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "homeview")

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 640), configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        view = webView
        showMessage("Starting HomeView…")
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
        <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#8b93a3;
        font:14px -apple-system,sans-serif;text-align:center;padding:24px;box-sizing:border-box">\(escaped)</body></html>
        """, baseURL: nil)
    }

    func call(_ js: String) {
        guard isViewLoaded else { return }
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: JS -> native

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.securityOrigin.host == "127.0.0.1",
              let body = message.body as? [String: Any], let type = body["type"] as? String else {
            replyHandler(nil, "unsupported"); return
        }
        switch type {
        case "prefs":
            if let v = body["notify"] as? Bool { UserDefaults.standard.set(v, forKey: "notify") }
            if let v = body["notifyMotion"] as? Bool { UserDefaults.standard.set(v, forKey: "notifyMotion") }
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
        var dest = downloads.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = downloads.appendingPathComponent("\((suggestedFilename as NSString).deletingPathExtension) \(n).jpg")
            n += 1
        }
        return dest
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Tink")?.play()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showMessage("Can't reach the HomeView server. It will retry automatically.")
    }
}
