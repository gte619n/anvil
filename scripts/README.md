# scripts

Build- and release-time utilities. (The old Zellij session-status server that used to live
here was removed when Anvil cut over to the `anvild` daemon — see the
[root README](../README.md). The last commit that still contained it is tagged
`zellij-era-final`.)

| Path | Used by | What it does |
|---|---|---|
| [`gen-release-notes.ts`](gen-release-notes.ts) | CI (the `android` job in [`release.yml`](../.github/workflows/release.yml)) | Generates `app/release-notes.txt` from the commit subjects in a push, for Firebase App Distribution. Run locally: `bun scripts/gen-release-notes.ts`. |
| [`mac-signing/`](mac-signing/) | [`apple/make-app.sh`](../apple/make-app.sh) | Provisions a Mac for Apple **Developer ID** signing + notarization, with the cert + notary key stored in Google Secret Manager. Start with [`mac-signing/SETUP.md`](mac-signing/SETUP.md). |
