import Foundation

/// Launches the bundled Node server, waits until it answers, and restarts it if it crashes.
@MainActor
final class ServerManager {
    static let port = Int(ProcessInfo.processInfo.environment["HOMEBASEVIEW_PORT"] ?? "") ?? 18700
    static let baseURL = URL(string: "http://127.0.0.1:\(port)")!
    static let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".homebaseview")
    static let logURL = dataDir.appendingPathComponent("server.log")

    private var process: Process?
    private var stopping = false
    private var restartTimes: [Date] = []
    private(set) var token: String?

    var onReady: ((String) -> Void)?
    var onFailure: ((String) -> Void)?

    /// Resources/app (the Node project) and Resources/node (the runtime), or a dev checkout.
    private var appDir: URL {
        if let env = ProcessInfo.processInfo.environment["HOMEBASEVIEW_ROOT"] { return URL(fileURLWithPath: env) }
        return Bundle.main.resourceURL!.appendingPathComponent("app")
    }

    private var nodeURL: URL? {
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("node")
        if FileManager.default.isExecutableFile(atPath: bundled.path) { return bundled }
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    func start() {
        stopping = false
        guard let node = nodeURL else { onFailure?("Node.js runtime not found in the app bundle."); return }
        let script = appDir.appendingPathComponent("server/index.js")
        guard FileManager.default.fileExists(atPath: script.path) else { onFailure?("Server files missing at \(script.path)"); return }

        killStaleServer()

        let p = Process()
        p.executableURL = node
        p.arguments = [script.path]
        p.currentDirectoryURL = appDir
        var env = ProcessInfo.processInfo.environment
        env["HOMEBASEVIEW_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        env["HOMEBASEVIEW_PORT"] = String(Self.port)
        p.environment = env
        p.standardOutput = FileHandle.nullDevice // the server writes its own log file
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in self?.handleExit(proc) }
        }
        do {
            try p.run()
            process = p
            NSLog("[HomeBaseView] server started, pid \(p.processIdentifier)")
            waitUntilReady()
        } catch {
            onFailure?("Could not start the server: \(error.localizedDescription)")
        }
    }

    func stop() {
        stopping = true
        guard let p = process, p.isRunning else { return }
        p.terminate()
        // Give it a moment to clean up streams and footage, then make sure it's gone.
        let pid = p.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { kill(pid, SIGKILL) }
        p.waitUntilExit()
    }

    func restart() {
        stop()
        restartTimes.removeAll()
        start()
    }

    private func handleExit(_ proc: Process) {
        guard proc === process else { return }
        process = nil
        token = nil
        if stopping { return }
        NSLog("[HomeBaseView] server exited with code \(proc.terminationStatus)")
        restartTimes = restartTimes.filter { $0.timeIntervalSinceNow > -120 } + [Date()]
        if restartTimes.count > 5 {
            onFailure?("The server keeps crashing. See the log for details.")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(restartTimes.count)) { [weak self] in self?.start() }
    }

    /// A previous instance that outlived a crash would hold the port.
    private func killStaleServer() {
        let pidFile = Self.dataDir.appendingPathComponent("server.pid")
        guard let text = try? String(contentsOf: pidFile, encoding: .utf8),
              let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0,
              kill(pid, 0) == 0 else { return }
        // Only kill it if it's really a node process.
        var name = [CChar](repeating: 0, count: 1024)
        proc_name(pid, &name, UInt32(name.count))
        if String(cString: name).contains("node") {
            NSLog("[HomeBaseView] stopping stale server \(pid)")
            kill(pid, SIGTERM)
            usleep(800_000)
        }
    }

    private func waitUntilReady(attempt: Int = 0) {
        guard process != nil else { return }
        if attempt > 80 { onFailure?("The server did not start in time."); return }
        let tokenURL = Self.dataDir.appendingPathComponent("session-token")
        guard let token = (try? String(contentsOf: tokenURL, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.waitUntilReady(attempt: attempt + 1) }
            return
        }
        var req = URLRequest(url: Self.baseURL.appendingPathComponent("api/health"), timeoutInterval: 2)
        req.setValue(token, forHTTPHeaderField: "X-HomeBaseView-Token")
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            Task { @MainActor in
                guard let self else { return }
                if ok {
                    self.token = token
                    self.onReady?(token)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitUntilReady(attempt: attempt + 1) }
                }
            }
        }.resume()
    }
}
