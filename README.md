# MidgeSDK for iOS

Let people report a bug from inside your iPhone or iPad app. A shake, or your own button, records the app's screen;
the report reaches your [Midge](https://midge.dev) workspace with the app's network requests, its log messages, device
details and the context you set. Passwords, tokens, cookies, card numbers and your workspace's own hidden names are
removed **on the device**, before anything is sent.

Full guide: [midge.dev/docs/share/ios-sdk](https://midge.dev/docs/share/ios-sdk)

## Requirements

iOS 17 or later, Xcode 16 or later.

## Install

In Xcode, **File › Add Package Dependencies…** and enter:

```
https://github.com/midgedotdev/midge-ios-sdk
```

Or in `Package.swift`:

```swift
.package(url: "https://github.com/midgedotdev/midge-ios-sdk", from: "0.1.0")
```

## Set up

1. On midge.dev, make a recording link (**Settings › Workspace › Recording links**).
2. In the **iPhone app SDK** card there, add your app's bundle id. Reports are only accepted from registered apps.
3. Start Midge at launch with the link's token:

```swift
import MidgeSDK

@main
struct ShopApp: App {
    init() {
        Midge.start(link: "YOUR_LINK_TOKEN")
    }
    var body: some Scene { WindowGroup { ContentView() } }
}
```

Shaking the device now opens the report sheet. From your own button:

```swift
Button("Report a bug") { Midge.report() }
```

## Context

```swift
Midge.metadata(["userId": user.id, "plan": "pro"])
Midge.user(name: user.name, email: user.email)   // fills the sheet
Midge.log("Payment sheet failed to load", level: .error)
```

Requests made with `URLSession.shared` are captured automatically. For your own sessions, call
`Midge.instrument(configuration)` before creating them.

## Options

```swift
var options = Midge.Options()
options.shakeToReport = false
options.captureNetwork = false
options.captureLogs = false
Midge.start(link: "YOUR_LINK_TOKEN", options: options)
```

## What it collects

Only while your app runs, kept in memory for the last five minutes, and sent only when the person taps **Send**:
HTTP requests and responses (bodies up to 64 KB), your app's unified-log messages from the recording, app name and
version, device model, iOS version, language and time zone, and the metadata you set. The screen recording covers
your app only. Redaction runs the same rules as Midge's browser extension.

## Contributing

This repository is generated from Midge's main repository on each release. Issues are welcome here; pull requests
are read and applied upstream.

## License

MIT
