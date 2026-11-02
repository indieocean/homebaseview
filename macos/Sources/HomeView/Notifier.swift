import Foundation
import UserNotifications

/// Polls the server for new motion / doorbell events and shows native notifications.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private var token: String?
    private var lastSeq = -1 // -1 = not primed yet; never notify for the backlog
    private var timer: Timer?
    var onEvent: ((_ cameraId: Int, _ kind: String) -> Void)?
    var onOpen: ((_ cameraId: Int) -> Void)?

    static var enabled: Bool { UserDefaults.standard.object(forKey: "notify") as? Bool ?? true }
    static var motionEnabled: Bool { UserDefaults.standard.object(forKey: "notifyMotion") as? Bool ?? true }

    override init() {
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error { NSLog("[HomeView] notification permission error: \(error.localizedDescription)") }
            NSLog("[HomeView] notifications \(granted ? "allowed" : "denied")")
        }
    }

    func start(token: String) {
        self.token = token
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        poll()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private struct RingEvent: Decodable {
        let seq: Int
        let id: String
        let cameraId: Int
        let cameraName: String
        let kind: String
        let detection: String?
    }

    private var polling = false
    private func poll() {
        guard let token, !polling else { return }
        polling = true
        var comps = URLComponents(url: ServerManager.baseURL.appendingPathComponent("api/events"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "after", value: String(max(lastSeq, 0)))]
        var req = URLRequest(url: comps.url!, timeoutInterval: 5)
        req.setValue(token, forHTTPHeaderField: "X-HomeView-Token")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            let events = data.flatMap { try? JSONDecoder().decode([RingEvent].self, from: $0) } ?? []
            Task { @MainActor in
                guard let self else { return }
                self.polling = false
                let maxSeq = events.map(\.seq).max() ?? max(self.lastSeq, 0)
                if self.lastSeq >= 0 {
                    for e in events.sorted(by: { $0.seq < $1.seq }) where e.seq > self.lastSeq {
                        self.onEvent?(e.cameraId, e.kind)
                        self.post(e)
                    }
                }
                self.lastSeq = max(self.lastSeq, maxSeq)
            }
        }.resume()
    }

    private func label(_ e: RingEvent) -> String {
        if e.kind == "ding" { return "Someone is at the door" }
        let d = (e.detection ?? "").lowercased()
        if d.contains("human") || d.contains("person") { return "Person detected" }
        if d.contains("package") { return "Package activity" }
        if d.contains("vehicle") { return "Vehicle detected" }
        if d.contains("animal") { return "Animal detected" }
        return "Motion detected"
    }

    private func post(_ e: RingEvent) {
        guard Self.enabled, e.kind == "ding" || Self.motionEnabled else { return }
        let content = UNMutableNotificationContent()
        content.title = e.cameraName
        content.body = label(e)
        content.sound = e.kind == "ding" ? .defaultCritical : .default
        content.userInfo = ["cameraId": e.cameraId]
        content.threadIdentifier = "camera-\(e.cameraId)"

        // Attach the latest still so you can see what's there without opening anything.
        fetchSnapshot(cameraId: e.cameraId) { file in
            if let file, let att = try? UNNotificationAttachment(identifier: "snapshot", url: file, options: [UNNotificationAttachmentOptionsTypeHintKey: "public.jpeg"]) {
                content.attachments = [att]
            }
            let request = UNNotificationRequest(identifier: e.id, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request)
        }
    }

    private func fetchSnapshot(cameraId: Int, done: @escaping @Sendable (URL?) -> Void) {
        guard let token else { done(nil); return }
        var req = URLRequest(url: ServerManager.baseURL.appendingPathComponent("api/cameras/\(cameraId)/snapshot"), timeoutInterval: 6)
        req.setValue(token, forHTTPHeaderField: "X-HomeView-Token")
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200 else { done(nil); return }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("homeview-\(UUID().uuidString).jpg")
            do { try data.write(to: file, options: .completeFileProtection); done(file) } catch { done(nil) }
        }.resume()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let id = response.notification.request.content.userInfo["cameraId"] as? Int else { return }
        await MainActor.run { self.onOpen?(id) }
    }
}
