# Phase B0 spike: SolidCraft install, pin, replay

Run 2026-11-19 on the M4 (macOS 26.5.2, Gatekeeper enabled). Scratch: `/tmp/sc-b0` (zips in
`dl/`, extracted binaries in `x/<version>/solidcraft-cli-<version>-macos-universal/`, per-build
plate scripts in `out/<version>/`, error-case scripts in `cases/`, captured eval output in `eval/`).

## Verdicts

- **S5 (script from format N replays under N+1): CONFIRMED, with a tolerance caveat.**
- **S6 (standalone zip runs from any folder and verifies): CONFIRMED for 0.40.1 onward; the
  spec's `spctl` form was wrong for a bare CLI.**

## S5 evidence

Plate script exported by 0.30.1 (`about.format` `solidcraft/48`), replayed with `eval`:

| script from | run under | volume_mm3 | faces | edges |
|---|---|---|---|---|
| 0.30.1 (48) | 0.30.1 | 23335.185042797417 | 22 | 40 |
| 0.30.1 (48) | 0.40.1 | 23335.166952297608 | 22 | 48 |
| 0.30.1 (48) | 0.43.0 | 23335.166952297608 | 22 | 48 |
| 0.30.1 (48) | 0.44.1 | 23335.166952407864 | 22 | 48 |
| 0.43.0 (57) | 0.44.1 | 23335.166952407864 | 22 | 48 |

- Adjacent releases (0.43.0 vs 0.44.1): volume differs 5e-12 relative. 0.30 vs 0.40 (kernel
  change): 7.8e-7 relative, and edge count 40 vs 48 for the same geometry.
- Same build twice: identical JSON apart from `timeline[].ms`.
- **Scripts are not format-gated.** `eval` ignores `about` for script JSON: a format-58 script
  runs under 0.30.1 with exit 0; `about.format: "solidcraft/999"` runs; a missing `about` runs.
  A newer script fails on an older build only when a step uses a feature that build lacks
  (exit 1, `unknown variant`), and unknown extra fields inside a feature are silently ignored.
- The format check exists only for `.sc` files, and changed over time: 0.30.1 refuses a
  format-58 `.sc` (exit 1, `this design was saved by a newer SolidCraft (file format 58; this
  version reads formats up to 48): update SolidCraft to open it`); 0.40.1 and 0.43.0 only warn
  on stderr and exit 0.

## S6 evidence and the verification sequence

All four builds ran from `/tmp` with a foreign cwd and HOME. `codesign -dv` on each:
`Identifier=io.tangencylabs.solidcraft.cli`, `TeamIdentifier=G5QA5U5X2S`, hardened runtime.

- `spctl -a -vv -t execute <bin>` **rejects a correct bare CLI** (`the code is valid but does not
  seem to be an app`, exit 3). Do not use it.
- `spctl -a -vv -t install <bin>` is the working form: `accepted`, `source=Notarized Developer
  ID`, `origin=Developer ID Application: Brennen Herbruck (G5QA5U5X2S)`, exit 0, for 0.40.1,
  0.43.0 and 0.44.1. 0.30.1 is signed but not notarized (`source=Unnotarized Developer ID`,
  exit 3).
- `stapler validate`, `syspolicy_check`, `codesign --check-notarization` and `-R="notarized"`
  alone are unreliable for a bare Mach-O. Do not use them.
- curl-fetched files carry no `com.apple.quarantine`, so Gatekeeper never evaluates them at
  exec. The daemon's checks are the only gate.

**Sequence a daemon must run before first execution:**

1. sha256 of the zip equals the hub-recorded value. When the hub first records a version, the
   release asset `digest` and the `SHA256SUMS.txt` line must agree.
2. Extract into a new empty folder. Reject absolute paths, `..` and symlinks. Strip the single
   top-level folder `solidcraft-cli-<version>-macos-universal/`. Require a regular file
   `solidcraft-cli`. Older zips also ship `solvecraft-cli`; it is never run.
3. `codesign --verify --strict --verbose=2 <bin>` exits 0.
4. Team pin by requirement, exits 0:
   `codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = "G5QA5U5X2S" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' <bin>`
5. `spctl -a -vv -t install <bin>` exits 0 with `source=Notarized Developer ID`. Precondition:
   `spctl --status` prints `assessments enabled`, otherwise report "cannot verify", not pass. The
   first check of a new binary appears to need an online lookup, so a failure is retryable
   before the folder is deleted (offline behaviour not tested).
6. `<bin> --version` prints exactly `solidcraft-cli <version>`.

## Release listing

`GET /repos/tangency-labs/solidcraft/releases?per_page=100` (92 releases; page).

- Fields used: `tag_name`, `prerelease`, `draft`, `published_at`, `assets[].name`,
  `assets[].browser_download_url`, `assets[].digest` (`"sha256:<hex>"`, present back to v0.16.0
  and matched local hashes). `immutable` is false, so the hub-recorded sha256 is the real pin.
- Asset: `solidcraft-cli-<version>-macos-universal.zip`, version = tag without `v`.
- Nightlies and RCs are `prerelease: true`. **Two plain-looking tags (`v0.40.0`, `v0.18.0`) are
  also prereleases**, so require both `^v\d+\.\d+\.\d+$` and `prerelease === false` and
  `draft === false`.
- The array is not strictly ordered by `published_at`. Sort it.
- At run time v0.44.1 was 44.6 h old, so "newest full release at least 48 h old" picks v0.43.0.

| version | format | zip bytes | zip sha256 |
|---|---|---|---|
| 0.44.1 | 58 | 158,754,038 | f324ec49fd50b30d6dc18928d84749b8a72a132e4233daf844e422b3c38bc251 |
| 0.43.0 | 57 | 153,719,917 | 0633d662f3b410da90616d6c7e412f6d799693164541abea82c8d53802ad1d0a |
| 0.40.1 | 54 | 132,266,744 | 271996c9ecc085bb8b0a228adcabf4b387b785dced5ec2d76a5054eb32705e20 |
| 0.30.1 | 48 | 84,730,855 | 1effd9b38bc7f8a67ef7a7c8bec49df6453b307e9f1476b638e2c4f70208dc2f |

Each extracted version is about 0.5 GB. Prune: keep pinned, previous and candidate.

## `solidcraft-cli eval`

`solidcraft-cli eval <script.json|design.sc|part.step> [--json-out FILE]`. JSON on stdout.

Keys (0.44.1): `bodies[]` (`area_mm2`, `bbox{min,max}`, `center_of_mass`, `closed`, `edges`,
`face_types`, `faces`, `kernel{…}`, `name`, `vertices`, `volume_mm3`, …), `body_count`,
`params[]` (`name`, `expression`, `value`, `unit`, `error`), `sketches[]` (`status`, …),
`timeline[]` (`error`, `id`, `ms`, `name`, `suppressed`, `type`, `warning`), `total`
(`volume_mm3`, `faces`, …). Older builds lack some keys. Parse leniently.

| case | exit | notes |
|---|---|---|
| success | 0 | JSON, empty stderr |
| **a timeline feature fails to compute** | **0** | `timeline[i].error` is a string; later features still run; geometry is wrong; stderr empty |
| step with invalid params / unknown feature type / unknown command | 1 | stderr `error: step N (<command>): …` |
| malformed JSON, garbage `.sc`, missing file | 1 | stderr `error: <path>: …` |

So a replay has failed when exit != 0, **or any `timeline[].error` != null, or any
`params[].error` != null**. Feature error text varies by build; test for presence, not text.
`solidcraft-cli run <script>` does exit 1 on a failed feature.

Compare across builds: `body_count`, per-body `faces`, `volume_mm3`, sorted bbox, within
tolerance. Do not compare `edges`, `kernel.*`, `ms` or exact `area_mm2`.

Script export: `solidcraft-cli script design.sc --out x.json`; top-level `about` (`design`,
`format: "solidcraft/<N>"`, `replay`, `version`) and `commands` (`parameters.add`, then
`timeline.add` with a `feature` object).
