# Brand assets

| File | Use |
|---|---|
| `anvil-mark.svg` | The anvil mark on its own (favicon, app-icon source, square contexts). Copied from [`anvild/web/assets/anvil.svg`](../../anvild/web/assets/anvil.svg). |
| `anvil-banner-light.svg` | README banner for **light** backgrounds (dark ink). |
| `anvil-banner-dark.svg` | README banner for **dark** backgrounds (light ink). |
| `gen-banner.ts` | Regenerates both banners from `anvil-mark.svg`. |

## Light / dark on GitHub

The banners are used with a `<picture>` element so GitHub serves the right one per theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/anvil-banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/anvil-banner-light.svg">
  <img alt="Anvil" src="docs/assets/anvil-banner-light.svg" width="560">
</picture>
```

The anvil mark itself is a colored illustration that reads on both themes; only the wordmark
and tagline ink change between variants.

## Regenerating the banners

Edit the wordmark/tagline or colors in `gen-banner.ts`, then:

```sh
bun docs/assets/gen-banner.ts
```

It reads `anvil-mark.svg`, scales it onto a 760×200 canvas, and writes both banner variants.
If the mark changes, re-copy it first:

```sh
cp anvild/web/assets/anvil.svg docs/assets/anvil-mark.svg
```
