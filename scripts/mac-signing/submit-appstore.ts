/**
 * Promote an already-uploaded build to a public App Store release — fully automatically.
 *
 * make-ios.sh archives + uploads the build to App Store Connect (where it also lands in TestFlight).
 * This script then, via the App Store Connect API (same ES256-JWT auth as gen-ios-profile.ts):
 *   1. waits for the uploaded build to finish processing (processingState VALID),
 *   2. creates (or reuses) the App Store version record for the tag's marketing version and
 *      attaches the build, with releaseType=AFTER_APPROVAL so it ships the moment review passes,
 *   3. turns on a phased (gradual) release,
 *   4. submits it for review using the current reviewSubmissions flow.
 *
 * "Fully automatic" is still bounded by Apple review: this submits and arms auto-release; the public
 * release happens by itself once the build is approved (hours–days later), not instantly.
 *
 * Requires env (source ~/.config/oxos-signing/env.sh after provision.sh, or the release workflow):
 *   APPLE_API_KEY_PATH     path to the App Store Connect AuthKey_*.p8 (App Manager role)
 *   APPLE_API_KEY          its Key ID
 *   APPLE_API_ISSUER       the Issuer ID
 *   ANVIL_MARKETING_VERSION  the public version string, e.g. 2.1.0 (from the release-* tag)
 *   ANVIL_BUILD_NUMBER     the CFBundleVersion that was uploaded (github.run_number)
 * Optional:
 *   APPSTORE_BUNDLE_ID     defaults to com.gte619n.anvil
 *   APPSTORE_PLATFORM      defaults to IOS
 *   BUILD_WAIT_SECONDS     how long to wait for processing (default 1800)
 *
 * Usage:
 *   bun scripts/mac-signing/submit-appstore.ts
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY_PATH = process.env.APPLE_API_KEY_PATH;
const KID = process.env.APPLE_API_KEY;
const ISS = process.env.APPLE_API_ISSUER;
const VERSION = process.env.ANVIL_MARKETING_VERSION;
const BUILD_NUMBER = process.env.ANVIL_BUILD_NUMBER;
if (!KEY_PATH || !KID || !ISS) {
  console.error("set APPLE_API_KEY_PATH / APPLE_API_KEY / APPLE_API_ISSUER (source env.sh)");
  process.exit(2);
}
if (!VERSION || !BUILD_NUMBER) {
  console.error("set ANVIL_MARKETING_VERSION (e.g. 2.1.0) and ANVIL_BUILD_NUMBER (the uploaded CFBundleVersion)");
  process.exit(2);
}
const BUNDLE = process.env.APPSTORE_BUNDLE_ID || "com.gte619n.anvil";
const PLATFORM = process.env.APPSTORE_PLATFORM || "IOS";
const BUILD_WAIT_SECONDS = Number(process.env.BUILD_WAIT_SECONDS || "1800");

// ── App Store Connect API client (ES256 JWT, mirrors gen-ios-profile.ts) ─────
const key = readFileSync(KEY_PATH, "utf8");
const b64u = (s: string): string => Buffer.from(s).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64u(JSON.stringify({ alg: "ES256", kid: KID, typ: "JWT" }));
const payload = b64u(JSON.stringify({ iss: ISS, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }));
const sig = createSign("SHA256").update(`${head}.${payload}`).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
const jwt = `${head}.${payload}.${sig}`;

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = body?.errors?.map((e: any) => `${e.title}: ${e.detail}`).join("; ") || text.slice(0, 600);
    throw new Error(`${init?.method || "GET"} ${path} → ${res.status}: ${detail}`);
  }
  return body;
}
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

// ── 1. resolve the app ───────────────────────────────────────────────────────
const appj = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}&limit=1`);
const app = appj.data?.[0];
if (!app) { console.error(`no App Store Connect app for bundle id ${BUNDLE} — create the listing once before releasing`); process.exit(1); }
const appId: string = app.id;
console.error(`app=${appId} (${app.attributes?.name})`);

// ── 2. wait for the uploaded build to finish processing ──────────────────────
const deadline = Date.now() + BUILD_WAIT_SECONDS * 1000;
let buildId: string | null = null;
while (true) {
  const bj = await api(`/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(BUILD_NUMBER)}&limit=1`);
  const build = bj.data?.[0];
  const state = build?.attributes?.processingState;
  if (build && state === "VALID") { buildId = build.id; console.error(`build ${BUILD_NUMBER} is VALID (${buildId})`); break; }
  if (state === "FAILED" || state === "INVALID") { console.error(`build ${BUILD_NUMBER} processing ${state}`); process.exit(1); }
  if (Date.now() > deadline) { console.error(`timed out after ${BUILD_WAIT_SECONDS}s waiting for build ${BUILD_NUMBER} to process (state=${state ?? "not found yet"})`); process.exit(1); }
  console.error(`build ${BUILD_NUMBER} not ready (state=${state ?? "not found yet"}); waiting…`);
  await sleep(30);
}

// ── 3. create/reuse the App Store version, attach the build ──────────────────
const evj = await api(`/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(VERSION)}&filter[platform]=${PLATFORM}&limit=1`);
let versionId: string | undefined = evj.data?.[0]?.id;
if (versionId) {
  console.error(`reusing existing App Store version ${VERSION} (${versionId})`);
} else {
  const created = await api(`/v1/appStoreVersions`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "appStoreVersions",
        attributes: { platform: PLATFORM, versionString: VERSION, releaseType: "AFTER_APPROVAL" },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    }),
  });
  versionId = created.data.id;
  console.error(`created App Store version ${VERSION} (${versionId})`);
}

// releaseType=AFTER_APPROVAL on an existing record too, so re-runs converge on auto-release.
await api(`/v1/appStoreVersions/${versionId}`, {
  method: "PATCH",
  body: JSON.stringify({
    data: {
      type: "appStoreVersions",
      id: versionId,
      attributes: { releaseType: "AFTER_APPROVAL" },
      relationships: { build: { data: { type: "builds", id: buildId } } },
    },
  }),
});
console.error(`attached build ${buildId}; releaseType=AFTER_APPROVAL`);

// ── 4. enable a phased (gradual) release ─────────────────────────────────────
try {
  await api(`/v1/appStoreVersionPhasedReleases`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "appStoreVersionPhasedReleases",
        attributes: { phasedReleaseState: "ACTIVE" },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
      },
    }),
  });
  console.error("phased release: ACTIVE");
} catch (e) {
  // Already-present phased release (e.g. a re-run) is fine; don't abort the submission.
  console.error(`phased release not (re)created: ${(e as Error).message}`);
}

// ── 5. submit for review (current reviewSubmissions flow) ────────────────────
// Reuse an open submission if one exists for this app+platform, else create one.
const openj = await api(`/v1/reviewSubmissions?filter[app]=${appId}&filter[platform]=${PLATFORM}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=1`);
let submissionId: string | undefined = openj.data?.[0]?.id;
if (!submissionId) {
  const sub = await api(`/v1/reviewSubmissions`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissions",
        attributes: { platform: PLATFORM },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    }),
  });
  submissionId = sub.data.id;
  console.error(`created review submission ${submissionId}`);
} else {
  console.error(`reusing open review submission ${submissionId}`);
}

// Attach this version to the submission (idempotent enough: a duplicate item 409s, which we tolerate).
try {
  await api(`/v1/reviewSubmissionItems`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    }),
  });
  console.error("added version to the review submission");
} catch (e) {
  console.error(`submission item not (re)added: ${(e as Error).message}`);
}

await api(`/v1/reviewSubmissions/${submissionId}`, {
  method: "PATCH",
  body: JSON.stringify({ data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } }),
});
console.error(`✓ submitted ${VERSION} (build ${BUILD_NUMBER}) for App Store review — auto-releases after approval.`);
