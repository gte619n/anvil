# Anvil — Apple clients (macOS first)

Hybrid shell: a SwiftUI app hosting the Anvil web client in a `WKWebView` over Tailscale
(same approach as the Android app). Native bits (APNs push, iOS target) layer on later.

## Quick run (compile-checks here, no Xcode.app needed)

```sh
cd apple
swift build          # compiles the macOS shell
swift run            # launches a window (unbundled — for a quick look only)
```

`swift run` launches a bare executable (no app bundle, so localStorage persistence and the
app/dock icon aren't quite right). For the real, daily-driver app use the Xcode build below.

## Build the real app (bundled, with icon, persistent storage)

Needs **Xcode.app** (App Store, ~15GB) and **XcodeGen** (`brew install xcodegen`):

```sh
cd apple
xcodegen            # generates Anvil.xcodeproj from project.yml
open Anvil.xcodeproj # build & run in Xcode (⌘R)
```

It builds **unsigned/ad-hoc** — no Apple Developer account required to run locally.

## Configure the daemon URL

Defaults to the Tailscale URL. Override:

```sh
defaults write com.gte619n.anvil anvil.baseURL "https://your-host.ts.net:7701/"
```

## Roadmap

- [x] macOS WebView shell (window, external-link handling, ⌘R reload, brand icon)
- [ ] macOS: native menu, APNs push (needs Apple Developer account)
- [ ] iOS target (shared `WebView` as `UIViewRepresentable`, APNs, adaptive layout) — needs the
      Apple Developer Program ($99/yr) for device install + push + TestFlight
