# Anvil — marketing site

A single-page, dependency-free marketing site for Anvil. Pure static HTML/CSS/JS — no build
step, no framework. Open `index.html` in a browser, or serve the folder:

```sh
cd website
python3 -m http.server 8080   # → http://localhost:8080
```

## What's here

| File | What it is |
|------|------------|
| `index.html` | The whole page — hero, features, autopilot, the adversarial pipeline, architecture, security, platforms, and a get-started section. |
| `styles.css` | The design system. Brand palette (copper `#D39450` / ink `#2F2739`) with an app-mockup theme that mirrors the real web client's dark tokens. |
| `app.js` | Progressive enhancements only: reveal-on-scroll, hero parallax, mobile nav. The page is fully readable with JS disabled. |
| `assets/` | Brand mark + banners, copied from [`docs/assets/`](../docs/assets/). |

## About the product "screenshots"

The device frames in the hero and the Autopilot section are **high-fidelity HTML/CSS
mockups**, styled with the real web client's own dark-theme tokens and component structure
(sidebar, message bubbles, tool cards, permission cards, the plan grid). They render crisp at
any resolution and stay truthful to the shipping UI — but they are reproductions, not literal
screen captures.

To drop in **real** captures instead: run the daemon (`cd anvild && bun run start`), open a
session at `http://localhost:7701`, capture the views, and replace the `.browser` / `.phone` /
`.ap-frame` mock blocks in `index.html` with `<img>` tags. The surrounding layout, framing, and
shadows will carry over unchanged.

## Deploying

The site is hosted on **Firebase Hosting** at **[anvild.sh](https://anvild.sh)** (default URL
`anvild.web.app`), in the `gte619n-anvil` GCP project. Config lives at the repo root
([`firebase.json`](../firebase.json) + [`.firebaserc`](../.firebaserc)). To publish changes:

```bash
firebase deploy --only hosting:anvild --project gte619n-anvil
```

`anvild.sh` is registered at **Porkbun** with DNS delegated to a **Cloud DNS** zone (`anvild-sh`,
same project); the apex `A → 199.36.158.100` + `TXT hosting-site=anvild` records connect it to
Firebase. Full pipeline context: [`../docs/CI-CD.md`](../docs/CI-CD.md#the-marketing-site-website).

> **Not on GitHub Pages.** Pages (`gte619n.github.io/anvil`) serves only the Sparkle appcasts —
> the site stays on Firebase so a custom domain never redirects the app auto-update URLs.

Being static, it runs anywhere else too — Netlify, Vercel, Cloudflare Pages, or `tailscale serve`
for an internal preview. The page uses **relative** asset paths, so it also works unchanged under
a subpath. All internal doc links point at `github.com/gte619n/anvil`; update them if needed.
