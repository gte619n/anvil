/**
 * Generate (or rotate) the iOS App Store provisioning profile via the App Store Connect API and
 * print its base64 .mobileprovision to stdout — no Apple Developer portal trip needed.
 *
 * CI uses MANUAL signing (automatic signing can't run headless with only a distribution cert — it
 * tries to mint an iOS *Development* profile, which needs registered devices). This mints the right
 * App Store (IOS_APP_STORE) profile, which is device-independent.
 *
 * Requires env (source ~/.config/oxos-signing/env.sh after provision.sh):
 *   APPLE_API_KEY_PATH  path to the App Store Connect AuthKey_*.p8 (App Manager role)
 *   APPLE_API_KEY       its Key ID
 *   APPLE_API_ISSUER    the Issuer ID
 *
 * Usage:
 *   source ~/.config/oxos-signing/env.sh
 *   bun scripts/mac-signing/gen-ios-profile.ts > profile.b64
 *   # then store it:
 *   gcloud secrets versions add ios-provisioning-profile --data-file=profile.b64 --project=gte619n-anvil
 *   ./sync-github-secrets.sh
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY_PATH = process.env.APPLE_API_KEY_PATH;
const KID = process.env.APPLE_API_KEY;
const ISS = process.env.APPLE_API_ISSUER;
if (!KEY_PATH || !KID || !ISS) {
  console.error("set APPLE_API_KEY_PATH / APPLE_API_KEY / APPLE_API_ISSUER (source env.sh)");
  process.exit(2);
}
const BUNDLE = process.env.APNS_BUNDLE_ID || "com.gte619n.anvil";
const NAME = process.env.IOS_PROFILE_NAME || "Anvil iOS App Store CI";

const key = readFileSync(KEY_PATH, "utf8");
const b64u = (s: string | Buffer): string => Buffer.from(s).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const h = b64u(JSON.stringify({ alg: "ES256", kid: KID, typ: "JWT" }));
const p = b64u(JSON.stringify({ iss: ISS, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }));
const sig = createSign("SHA256").update(`${h}.${p}`).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
const jwt = `${h}.${p}.${sig}`;
const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", ...(init?.headers || {}) },
  });

// Resolve the registered bundle id + a distribution certificate.
const bj = (await (await api(`/v1/bundleIds?filter[identifier]=${BUNDLE}&limit=200`)).json()) as any;
const bundle = bj.data?.find((d: any) => d.attributes.identifier === BUNDLE);
if (!bundle) { console.error("bundleId not registered:", BUNDLE); process.exit(1); }
const cj = (await (await api(`/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=200`)).json()) as any;
const cert = cj.data?.[0];
if (!cert) { console.error("no DISTRIBUTION certificate found in the account"); process.exit(1); }
console.error(`bundleId=${bundle.id} cert=${cert.id} (${cert.attributes?.name})`);

// Replace any existing same-named profile (profileContent isn't refetchable, so recreate fresh).
const ej = (await (await api(`/v1/profiles?filter[name]=${encodeURIComponent(NAME)}&limit=200`)).json()) as any;
for (const ex of ej.data ?? []) { await api(`/v1/profiles/${ex.id}`, { method: "DELETE" }); console.error("deleted old profile", ex.id); }

const res = await api(`/v1/profiles`, {
  method: "POST",
  body: JSON.stringify({
    data: {
      type: "profiles",
      attributes: { name: NAME, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundle.id } },
        certificates: { data: [{ type: "certificates", id: cert.id }] },
      },
    },
  }),
});
const pj = (await res.json()) as any;
if (!res.ok) { console.error("profile create failed", res.status, JSON.stringify(pj).slice(0, 600)); process.exit(1); }
console.error(`created profile "${pj.data.attributes.name}" uuid=${pj.data.attributes.uuid}`);
process.stdout.write(pj.data.attributes.profileContent); // base64 .mobileprovision
