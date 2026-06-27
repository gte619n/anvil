/**
 * Insert (or replace) one <item> in a Sparkle appcast (RSS) and write it back, preserving prior
 * releases so the feed accumulates history. Used by .github/workflows/release.yml after a macOS app
 * is built, notarized, and signed with the Sparkle EdDSA key (sign_update gives the signature+length).
 *
 * We splice rather than run `generate_appcast` because CI only has the *current* release's zip on
 * disk; regenerating would drop every earlier item. Items are keyed by sparkle:version (the
 * CFBundleVersion), newest first, capped to keep the feed small.
 *
 * Env:
 *   APPCAST_FILE      path to read+write (may not exist yet → starts a fresh feed)
 *   APP_TITLE         channel title, e.g. "Anvil" / "Anvil Server"
 *   SHORT_VERSION     marketing version (CFBundleShortVersionString), e.g. 2.1.0
 *   BUILD_VERSION     CFBundleVersion — what Sparkle compares to decide "newer"
 *   ENCLOSURE_URL     download URL of the .zip (a GitHub Release asset)
 *   ED_SIGNATURE      base64 EdDSA signature from `sign_update`
 *   LENGTH            byte length from `sign_update`
 *   MIN_SYSTEM        minimum macOS version, e.g. 13.0
 *   RELEASE_NOTES_URL (optional) link shown as the item's release notes
 *
 * Usage: bun scripts/mac-signing/update-appcast.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (required && !v) { console.error(`missing required env: ${k}`); process.exit(2); }
  return v ?? "";
};

const FILE = env("APPCAST_FILE");
const TITLE = env("APP_TITLE");
const SHORT_VERSION = env("SHORT_VERSION");
const BUILD_VERSION = env("BUILD_VERSION");
const ENCLOSURE_URL = env("ENCLOSURE_URL");
const ED_SIGNATURE = env("ED_SIGNATURE");
const LENGTH = env("LENGTH");
const MIN_SYSTEM = env("MIN_SYSTEM");
const RELEASE_NOTES_URL = env("RELEASE_NOTES_URL", false);
const MAX_ITEMS = Number(process.env.MAX_ITEMS || "20");

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pubDate = new Date().toUTCString(); // RFC-822, what Sparkle expects

const newItem =
`    <item>
      <title>${xmlEscape(SHORT_VERSION)}</title>
      <pubDate>${pubDate}</pubDate>
      <sparkle:version>${xmlEscape(BUILD_VERSION)}</sparkle:version>
      <sparkle:shortVersionString>${xmlEscape(SHORT_VERSION)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${xmlEscape(MIN_SYSTEM)}</sparkle:minimumSystemVersion>${
        RELEASE_NOTES_URL ? `\n      <sparkle:releaseNotesLink>${xmlEscape(RELEASE_NOTES_URL)}</sparkle:releaseNotesLink>` : ""}
      <enclosure url="${xmlEscape(ENCLOSURE_URL)}" sparkle:edSignature="${xmlEscape(ED_SIGNATURE)}" length="${xmlEscape(LENGTH)}" type="application/octet-stream"/>
    </item>`;

// Pull any existing <item>…</item> blocks, drop one with the same sparkle:version (re-run / overwrite).
let existingItems: string[] = [];
if (existsSync(FILE)) {
  const prev = readFileSync(FILE, "utf8");
  existingItems = (prev.match(/<item>[\s\S]*?<\/item>/g) ?? []).filter(
    (it) => !new RegExp(`<sparkle:version>\\s*${BUILD_VERSION}\\s*</sparkle:version>`).test(it),
  );
}

const items = [newItem, ...existingItems].slice(0, MAX_ITEMS).join("\n");
const doc =
`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xmlEscape(TITLE)}</title>
${items}
  </channel>
</rss>
`;

writeFileSync(FILE, doc);
console.error(`✓ ${FILE}: set ${SHORT_VERSION} (build ${BUILD_VERSION}); ${existingItems.length} prior item(s) kept`);
