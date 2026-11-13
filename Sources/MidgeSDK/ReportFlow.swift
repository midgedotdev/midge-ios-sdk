#if os(iOS)
import AVKit
import MidgeCore
import ReplayKit
import SwiftUI
import UIKit

/// The report: a sheet to start, the app's screen recorded with ReplayKit (in-app only: no Control Center, no
/// broadcast picker), a small Stop pill while it records, then the person's words and Send.
@MainActor @Observable
final class ReportFlow {
    static let shared = ReportFlow()

    enum Phase: Equatable {
        case idle
        case intro
        case recording
        case form
        case sending(Double)
        case sent
        case failed(String)
    }

    var phase: Phase = .idle
    var workspace = ""
    var problem: String?
    var elapsed: TimeInterval = 0
    var video: URL?
    var name = ""
    var email = ""
    var details = ""
    private var startedAt = Date()
    private var endedAt = Date()
    private var info: RecordingLinkClient.Info?
    private var window: PassthroughWindow?
    private var timer: Timer?

    private var client: RecordingLinkClient? {
        guard let config = Midge.snapshot.config else { return nil }
        return RecordingLinkClient(origin: config.options.origin, token: config.token, app: Bundle.main.bundleIdentifier ?? "")
    }

    func begin() {
        guard phase == .idle else { return }
        guard let client else { return print("MidgeSDK: call Midge.start(link:) before Midge.report().") }
        let person = Midge.snapshot.person
        name = person.name
        email = person.email
        details = ""
        problem = nil
        phase = .intro
        show()
        Task {
            do {
                let info = try await client.info()
                self.info = info
                workspace = info.workspace
                if info.siteVerified == false {
                    problem = "This app isn’t registered with \(info.workspace) yet. An admin adds \(client.app) under Settings › Workspace › Recording links on midge.dev."
                }
            } catch {
                problem = "Midge can’t be reached. Check your connection."
            }
        }
    }

    func record() {
        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable else { return problem = "Screen recording isn’t available right now." }
        recorder.isMicrophoneEnabled = false
        recorder.startRecording { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.problem = (error as NSError).code == RPRecordingErrorCode.userDeclined.rawValue
                        ? "Recording needs your OK. Try again and tap Record Screen." : error.localizedDescription
                    return
                }
                self.startedAt = Date()
                self.elapsed = 0
                self.phase = .recording
                let limit = Double(self.info?.maxDurationMs ?? 900_000) / 1000
                self.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                    Task { @MainActor in
                        guard let self else { return }
                        self.elapsed += 1
                        if self.elapsed >= limit { self.stop() }
                    }
                }
            }
        }
    }

    func stop() {
        timer?.invalidate()
        endedAt = Date()
        let url = FileManager.default.temporaryDirectory.appending(path: "midge-report-\(UUID().uuidString).mp4")
        RPScreenRecorder.shared().stopRecording(withOutput: url) { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.phase = .failed(error.localizedDescription)
                } else {
                    self.video = url
                    self.phase = .form
                }
            }
        }
    }

    func send() {
        guard let client, let video, let config = Midge.snapshot.config else { return }
        let report = Sender.Report(video: video, startedAt: startedAt, endedAt: endedAt, name: name, email: email, description: details)
        let sender = Sender(client: client, includeLogs: config.options.captureLogs)
        let redaction = info?.redaction
        let context = Midge.snapshot.context
        phase = .sending(0)
        nonisolated(unsafe) let unsafeContext = context
        Task {
            do {
                _ = try await sender.send(report, redaction: redaction, context: unsafeContext) { value in
                    Task { @MainActor in if case .sending = ReportFlow.shared.phase { ReportFlow.shared.phase = .sending(value) } }
                }
                try? FileManager.default.removeItem(at: video)
                self.phase = .sent
                try? await Task.sleep(for: .seconds(1.6))
                self.close()
            } catch {
                self.phase = .failed(error.localizedDescription)
            }
        }
    }

    func close() {
        timer?.invalidate()
        if RPScreenRecorder.shared().isRecording { RPScreenRecorder.shared().stopRecording { _, _ in } }
        if let video { try? FileManager.default.removeItem(at: video) }
        video = nil
        phase = .idle
        window?.isHidden = true
        window = nil
    }

    private func show() {
        guard window == nil, let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }
        let window = PassthroughWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        let host = UIHostingController(rootView: ReportOverlay(flow: self))
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.isHidden = false
        self.window = window
    }
}

/// Touches go through to the app except where Midge's own views are.
final class PassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit == rootViewController?.view ? nil : hit
    }
}

struct ReportOverlay: View {
    @Bindable var flow: ReportFlow

    private var sheetShown: Binding<Bool> {
        Binding(get: { flow.phase != .idle && flow.phase != .recording }, set: { if !$0 && flow.phase != .recording { flow.close() } })
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            if flow.phase == .recording {
                Button { flow.stop() } label: {
                    HStack(spacing: 8) {
                        Circle().fill(.white).frame(width: 8, height: 8)
                        Text(String(format: "%d:%02d", Int(flow.elapsed) / 60, Int(flow.elapsed) % 60)).monospacedDigit()
                        Text("Stop").fontWeight(.semibold)
                    }
                    .font(.subheadline)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.red, in: Capsule())
                    .foregroundStyle(.white)
                }
                .padding(.top, 6)
                .accessibilityLabel("Stop recording the bug report")
            }
        }
        .sheet(isPresented: sheetShown) {
            ReportSheet(flow: flow)
                .presentationDetents(flow.phase == .intro ? [.medium] : [.large])
                .interactiveDismissDisabled({ if case .sending = flow.phase { return true }; return false }())
        }
    }
}

struct ReportSheet: View {
    @Bindable var flow: ReportFlow

    var body: some View {
        NavigationStack {
            Group {
                switch flow.phase {
                case .intro: intro
                case .form: form
                case .sending(let value):
                    VStack(spacing: 14) {
                        ProgressView(value: value).frame(maxWidth: 240)
                        Text("Sending… \(Int(value * 100))%").foregroundStyle(.secondary).monospacedDigit()
                    }
                case .sent:
                    VStack(spacing: 12) {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 48)).foregroundStyle(.green)
                        Text("Sent. Thank you!").font(.headline)
                    }
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Not sent", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        if flow.video != nil { Button("Try again") { flow.send() }.buttonStyle(.borderedProminent) }
                    }
                default: EmptyView()
                }
            }
            .navigationTitle("Report a bug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { flow.close() } }
            }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Show what went wrong: Midge records this app’s screen until you tap Stop, then you add a few words.")
                .foregroundStyle(.secondary)
            Label("The app’s network requests and logs are attached, with passwords and tokens hidden.", systemImage: "lock.shield")
                .font(.footnote).foregroundStyle(.secondary)
            if let problem = flow.problem {
                Text(problem).font(.footnote).foregroundStyle(.red)
            }
            Spacer()
            Button { flow.record() } label: {
                Label("Record the screen", systemImage: "record.circle").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(flow.problem?.contains("isn’t registered") == true)
        }
        .padding()
    }

    private var form: some View {
        Form {
            if let video = flow.video {
                Section {
                    VideoPlayer(player: AVPlayer(url: video)).frame(height: 260).listRowInsets(EdgeInsets())
                }
            }
            Section("What happened?") {
                TextField("What did you expect, and what happened instead?", text: $flow.details, axis: .vertical)
                    .lineLimit(3...8)
            }
            Section {
                TextField("Name (optional)", text: $flow.name).textContentType(.name)
                TextField("Email (optional)", text: $flow.email).textContentType(.emailAddress)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never)
            } footer: {
                Text(flow.workspace.isEmpty ? "" : "Sent to \(flow.workspace) on Midge, with this app’s logs.")
            }
            Section {
                Button { flow.send() } label: { Text("Send").frame(maxWidth: .infinity).fontWeight(.semibold) }
            }
        }
    }
}
#endif
