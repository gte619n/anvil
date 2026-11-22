/**
 * Reading one SolidCraft release from GitHub (agent-cad-and-browser spec §4.14 item 16, B0 evidence
 * "Release listing"). Used when a person sets the pin by version: the hub looks up the zip's sha256
 * once and records it, and every machine then installs that exact pair.
 *
 * The sha256 comes from the asset's `digest` field and MUST equal the line for the same file in the
 * release's `SHA256SUMS.txt`. Releases are not immutable upstream, so the recorded value is the pin.
 *
 * Phase B2's candidate search lists and filters releases; it reuses the types and helpers here.
 */
import { isSha256, isSolidcraftVersion, releaseAssetName, type SolidcraftRef } from "./install";

export const SOLIDCRAFT_REPO = "tangency-labs/solidcraft";
export const SOLIDCRAFT_RELEASES_API = `https://api.github.com/repos/${SOLIDCRAFT_REPO}/releases`;
export const SHA256SUMS_ASSET = "SHA256SUMS.txt";

export interface GithubAsset {
  name: string;
  browser_download_url: string;
  /** `"sha256:<hex>"`. Present on every release back to v0.16.0. */
  digest?: string | null;
}
export interface GithubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string | null;
  assets: GithubAsset[];
}

const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "anvild" };

/** `SHA256SUMS.txt` → file name → lowercase hex. Lines that are not `<64 hex>  <name>` are ignored. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}

/** The CLI zip's sha256 from a release's asset `digest`, or a thrown explanation. */
export function assetDigest(release: GithubRelease, version: string): { asset: GithubAsset; sha256: string } {
  const name = releaseAssetName(version);
  const asset = release.assets?.find((a) => a.name === name);
  if (!asset) throw new Error(`release ${release.tag_name} has no asset ${name}`);
  const sha256 = (asset.digest ?? "").replace(/^sha256:/, "").toLowerCase();
  if (!isSha256(sha256)) throw new Error(`asset ${name} carries no sha256 digest`);
  return { asset, sha256 };
}

/**
 * Check a release's zip digest against its `SHA256SUMS.txt` and return the agreed value. Throws when
 * either is missing or they differ — the hub then records nothing.
 */
export async function verifiedReleaseSha(release: GithubRelease, version: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { asset, sha256 } = assetDigest(release, version);
  const sums = release.assets.find((a) => a.name === SHA256SUMS_ASSET);
  if (!sums) throw new Error(`release ${release.tag_name} has no ${SHA256SUMS_ASSET}`);
  const res = await fetchImpl(sums.browser_download_url, { headers: { "User-Agent": GITHUB_HEADERS["User-Agent"] }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`could not read ${SHA256SUMS_ASSET} (${res.status})`);
  const listed = parseSha256Sums(await res.text()).get(asset.name);
  if (!listed) throw new Error(`${SHA256SUMS_ASSET} has no line for ${asset.name}`);
  if (listed !== sha256) throw new Error(`the asset digest (${sha256}) and ${SHA256SUMS_ASSET} (${listed}) disagree for ${asset.name}`);
  return sha256;
}

/** Look up ONE version on GitHub and return the `{ version, sha256 }` pair to pin. Throws on any doubt. */
export async function resolveReleaseRef(version: string, fetchImpl: typeof fetch = fetch): Promise<SolidcraftRef> {
  if (!isSolidcraftVersion(version)) throw new Error(`not a SolidCraft version: ${JSON.stringify(version)} (expected e.g. 0.44.1)`);
  const res = await fetchImpl(`${SOLIDCRAFT_RELEASES_API}/tags/v${version}`, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) throw new Error(`SolidCraft has no release v${version}`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for release v${version}`);
  const release = (await res.json()) as GithubRelease;
  if (release.tag_name !== `v${version}`) throw new Error(`GitHub returned ${release.tag_name} for v${version}`);
  if (release.draft) throw new Error(`release v${version} is a draft`);
  return { version, sha256: await verifiedReleaseSha(release, version, fetchImpl) };
}
