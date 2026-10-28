# Releasing

This is the maintainer flow for official builds: it needs the Komla Apple signing identity, notarization credentials, the utility token and write access to the R2 bucket, and runs on macOS. To build Komla from source, `npm install && npm run build` needs none of these; see the README.

## Quick Start

```bash
npm run release -- patch   # Bump + build, then stop before upload
npm run release -- minor   # Minor version bump
npm run release -- 1.2.0   # Explicit version
```

Production releases always pause after the build phase so you can sanity-check the artifacts in `dist/`. Resume with `--resume-from=upload` to push to R2. Staging releases (`--staging`) skip the pause and upload automatically.

## Subcommands

| Subcommand | Description                                                           |
| ---------- | --------------------------------------------------------------------- |
| `full`     | Build, pause for verification, then upload + push on resume (default) |
| `build`    | Build only, no commit/tag/upload                                      |
| `upload`   | Upload only (requires x.y.z version)                                  |

```bash
npm run release -- build patch           # Build only
npm run release -- upload 0.5.1          # Upload existing build
npm run release -- full patch            # Bump + build, then pause (default subcommand)
```

## Options

| Flag                  | Description                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--platforms=X,Y`     | Platforms to build: mac, windows, linux (default: all)                                                                                 |
| `--archs=X,Y`         | Architectures to build: arm64, x64 (default: all). Note: has no effect on Windows — both archs are always built in a single invocation |
| `--skip-notarization` | Skip macOS notarization (testing only)                                                                                                 |
| `--skip-e2e`          | Skip Playwright e2e tests (escape hatch for hotfixes)                                                                                  |
| `--skip-vm-security`  | Skip the Docker SSH integration tests (requires Docker otherwise)                                                                      |
| `--dry-run`           | Validate setup without building                                                                                                        |
| `--force`             | Force rebuild even if artifacts exist                                                                                                  |
| `--skip-verify`       | Skip upload verification (on by default)                                                                                               |
| `--no-parallel`       | Disable parallel builds (run platforms sequentially)                                                                                   |
| `--resume-from=PHASE` | Resume from a specific phase                                                                                                           |
| `--no-rollback`       | Disable automatic rollback on failure                                                                                                  |
| `--no-cleanup`        | Skip automatic removal of old release artifacts from R2                                                                                |

## Examples

```bash
# Platform/arch filtering
npm run release -- patch --platforms=mac              # macOS only
npm run release -- patch --platforms=mac,windows      # Skip Linux
npm run release -- patch --archs=arm64                # arm64 only (all platforms)
npm run release -- patch --platforms=mac --archs=arm64  # macOS arm64 only

# Build workflow
npm run release -- build patch                        # Build without releasing
npm run release -- upload 0.5.1                       # Upload existing build

# Recovery
npm run release -- patch --resume-from=upload         # Resume failed upload
npm run release -- patch --resume-from=notarize       # Retry failed notarization
npm run release -- patch --force                      # Force rebuild all

# Staging
npm run release -- 2.0.0-staging.1 --staging          # First staging build
npm run release -- 2.0.0-staging.2 --staging          # Iterate after fixes
npm run release -- 2.0.0                               # Promote to production
```

On Windows, staging installs into `%LOCALAPPDATA%\Programs\komla-staging`, next to production's `Programs\komla`. Older staging builds shared production's folder, and updates keep that folder. To move one: uninstall Komla Staging, which also deletes production's files, uninstall Komla if it is still listed, then install production and the new staging build.

## Resume Capability

If a release fails mid-way, resume from a specific phase:

```bash
npm run release -- patch --resume-from=upload
npm run release -- patch --resume-from=notarize   # Retry notarization without rebuilding
```

**Phases**: `preflight`, `version`, `test`, `e2e`, `vm-security`, `audit`, `build`, `notarize`, `package`, `smoke-test`, `upload`, `upload-manifests`, `verify`, `publish`, `cleanup`

State is tracked in `.release-state.json` (gitignored).

## Automatic Rollback

On failure, the script automatically:

- Deletes the version tag
- Reverts the version commit

Use `--no-rollback` to disable for manual recovery.

## What the Script Does

1. **Preflight** — Validates prerequisites: wrangler and the ripgrep binary always; cargo-xwin when building; notarization creds when notarizing; docker whenever building (the bundled Linux companions build in Docker for every platform; colima is started if Docker isn't running); wine when Windows is targeted, plus jsign and osslsigncode when [Windows signing](#windows-code-signing) is configured (a warning when it is not); a running Docker when running the integration tests
2. **Version** — Bumps version, commits, and tags `v{version}`
3. **Test** — Runs `npm test`
4. **E2E** — Runs `npm run test:e2e` (Playwright) with `KOMLA_E2E_HIDE_WINDOWS=1`, so the app's windows open transparent, click-through and unfocusable (on Linux only unfocused and click-through). Skip with `--skip-e2e`.
5. **Integration** — Runs `npm run test:integration`, the SSH remote-workspace suite in a disposable Debian 13 container. Requires Docker. Skip with `--skip-vm-security`.
6. **Audit** — Fails on high/critical vulnerabilities in shipped packages, including the renderer libraries Vite bundles (`scripts/audit-shipped-deps.mjs`)
7. **Build** — Builds all platforms in parallel (macOS + Windows + Linux x64 concurrently, Linux arm64 after):
   - macOS (arm64 + x64) — native, code-signed
   - Windows (x64 + arm64) — via Wine, code-signed when configured
   - Linux (x64 + arm64) — via Docker
8. **Notarize** — Submits macOS apps to Apple via `xcrun notarytool`, staples tickets, regenerates ZIPs/blockmaps from stapled apps, patches manifest hashes. Skipped for staging builds.
9. **Package** — Verifies Windows signatures (when signing is configured), creates Windows ZIP wrappers and SHA256 checksums
10. **Smoke test** — Loads every native module from the macOS arm64 build and starts a terminal with it (`scripts/check-packaged-native-modules.cjs`), then launches the app briefly to verify startup
    - **Production releases pause here.** The script prints a resume command and exits cleanly so you can manually verify the build before publishing. Staging releases skip the pause.
11. **Upload** — Uploads artifacts to Cloudflare R2 with retry
12. **Upload manifests** — Patches and uploads auto-updater manifests
13. **Verify** — Downloads artifacts from CDN and validates SHA256 checksums
14. **Publish** — Pushes the release commit and its `v{version}` tag
15. **Cleanup** — Removes old R2 artifacts (keeps newest 20)

## Prerequisites

- **macOS** — the script uses `ditto`, `xcrun`, `codesign` and other macOS tools
- **Rust** — `rustup` with the companion targets (`scripts/build-native-matrix.sh`), plus python3 and xxd
- **Wine** — `brew install --cask wine-stable`
- **Docker Desktop** — for the bundled Linux companion artifacts included in every package
- **cargo-xwin** — `cargo install cargo-xwin --version 0.19.2 --locked` for the bundled Windows Komla CLI
- **jsign + osslsigncode** — `brew install jsign osslsigncode`, only for signed Windows releases
- **wrangler** — `npm i -g wrangler` + `wrangler login`
- **Apple signing identity** — in keychain
- **Apple notarization credentials** — in `.env`
- **Utility token** — `KOMLA_UTILITY_TOKEN` in `.env`, the token the managed AI helpers send to `utility.komla.dev` (the worker's `KOMLA_APP_TOKEN` secret). It is not in the source tree, so official builds get it at build time
- **jq** — for state tracking (pre-installed on macOS)

## Apple Notarization Setup

Create `.env` with:

```bash
APPLE_ID=your-apple-id@email.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=XXXXXXXXXX
```

Get app-specific password from [appleid.apple.com](https://appleid.apple.com/account/manage).
Get Team ID from [developer.apple.com/account](https://developer.apple.com/account).

Verify setup: `npm run release -- patch --dry-run`

## Windows Code Signing

Optional. Without `WIN_SIGN_STORETYPE`, Windows builds are unsigned and preflight prints a warning. With it, electron-builder's sign hook (`scripts/windows-sign.cjs`, set in `electron-builder.yml`) signs each Windows binary with [jsign](https://ebourg.github.io/jsign/) as it packages it, before it builds the installer and hashes it for the blockmap and `latest.yml`. jsign takes the certificate from a file, a token or a cloud signing service, so any provider jsign supports works.

**What gets signed:** every PE file in the package that has no signature yet: `Komla.exe`, both bundled `komla.exe` CLIs (copied to `~/.komla/bin/komla.exe` at launch), Electron's DLLs, the node-pty, @parcel/watcher and ripgrep binaries, `elevate.exe`, the uninstaller and the setup `.exe`. Third-party binaries are signed too because Smart App Control checks every executable and DLL it loads. Files that already carry a vendor signature (Microsoft's `d3dcompiler_47.dll`, `dxil.dll`, and ConPTY's `OpenConsole.exe` and `conpty.dll`) keep it. The NSIS plugin DLLs inside the installer stay unsigned, because electron-builder does not pass them to the hook. A release signs a few dozen files, which matters for providers that meter signatures.

| Variable             | Purpose                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `WIN_SIGN_STORETYPE` | jsign `--storetype`, which turns signing on: `PKCS12`, `PKCS11`, `ESIGNER`, `DIGICERTONE`, ...                     |
| `WIN_SIGN_KEYSTORE`  | jsign `--keystore`: keystore file, PKCS#11 config or service endpoint, depending on the store type                 |
| `WIN_SIGN_STOREPASS` | jsign `--storepass` (secret). Passed as `env:WIN_SIGN_STOREPASS`, so it never appears on a command line            |
| `WIN_SIGN_KEYPASS`   | jsign `--keypass` (secret), e.g. the eSigner TOTP secret. Passed the same way                                      |
| `WIN_SIGN_ALIAS`     | jsign `--alias`                                                                                                    |
| `WIN_SIGN_CERTFILE`  | jsign `--certfile`, for stores that hold only the key                                                              |
| `WIN_SIGN_TSA_URL`   | RFC 3161 timestamp servers, comma separated (default `http://timestamp.digicert.com,http://timestamp.sectigo.com`) |
| `JSIGN`              | jsign executable (default `jsign` on `PATH`)                                                                       |

jsign's documentation lists what each store type expects. For example, SSL.com eSigner in `.env`:

```bash
WIN_SIGN_STORETYPE=ESIGNER
WIN_SIGN_STOREPASS='<username>|<password>'
WIN_SIGN_KEYPASS=<base64 TOTP secret>
WIN_SIGN_ALIAS=<credential ID>
```

The package phase checks each target architecture's setup `.exe`, `Komla.exe` in `dist/win-unpacked` (`win-arm64-unpacked`) and both `komla.exe` with `osslsigncode verify`. A missing signature or one that no longer matches the file fails the release. A certificate chain osslsigncode cannot build from its CA bundle only warns, so confirm on Windows:

```powershell
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\komla\Komla.exe", "$HOME\.komla\bin\komla.exe" |
  Format-List Path, Status, SignerCertificate
```

`Status` should be `Valid`. electron-updater does not check update signatures yet: setting `win.signtoolOptions.publisherName` to the certificate's subject would make it, but would also make every later unsigned release fail to auto-update, so set it only once signing is permanent.

## Build Times

| Platform | Architecture | Time              |
| -------- | ------------ | ----------------- |
| macOS    | arm64 + x64  | ~5 min            |
| Windows  | x64 + arm64  | ~6 min            |
| Linux    | x64          | ~5 min            |
| Linux    | arm64        | ~10-30 min (QEMU) |

Parallel is the default — macOS, Windows, and Linux x64 build concurrently. Linux arm64 runs after x64.

## Environment Variables

| Variable                      | Default          | Purpose                   |
| ----------------------------- | ---------------- | ------------------------- |
| `APPLE_ID`                    | —                | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | —                | App-specific password     |
| `APPLE_TEAM_ID`               | —                | Apple Developer Team ID   |
| `KOMLA_R2_BUCKET`             | `komla-releases` | R2 bucket name            |
| `KOMLA_UTILITY_TOKEN`         | —                | Managed AI helper token   |
| `WIN_SIGN_*`, `JSIGN`         | —                | Windows code signing      |

## Manual Platform Builds

These count as builds from source: telemetry reports them as `distribution: source` and they don't update themselves. Export `KOMLA_DISTRIBUTION=official` (with `KOMLA_UTILITY_TOKEN` set) to build an official app by hand.

```bash
# macOS
npm run build:native:matrix
npm run build && npx electron-builder --mac --arm64 --x64

# Linux (single-arch per invocation via Docker)
npm run build:native:matrix
bash scripts/build-linux.sh x64
bash scripts/build-linux.sh arm64

# Windows (always builds both x64 + arm64 in one invocation)
npm run build:native:matrix
bash scripts/build-windows.sh
```

## R2 Artifact Layout

All artifacts are uploaded under the `latest/` prefix with versioned filenames. The auto-updater manifests reference these versioned names. The cleanup phase keeps the newest 20 versions (binaries are served with immutable cache headers).

| Platform            | R2 key                               |
| ------------------- | ------------------------------------ |
| macOS arm64         | `latest/komla-{ver}-arm64.zip`       |
| macOS x64           | `latest/komla-{ver}-x64.zip`         |
| macOS arm64 DMG     | `latest/komla-{ver}-arm64.dmg`       |
| macOS x64 DMG       | `latest/komla-{ver}-x64.dmg`         |
| Windows x64         | `latest/komla-{ver}-x64-setup.exe`   |
| Windows arm64       | `latest/komla-{ver}-arm64-setup.exe` |
| Windows x64 (ZIP)   | `latest/komla-{ver}-x64-setup.zip`   |
| Windows arm64 (ZIP) | `latest/komla-{ver}-arm64-setup.zip` |
| Linux x64           | `latest/komla-{ver}-x86_64.AppImage` |
| Linux arm64         | `latest/komla-{ver}-arm64.AppImage`  |

Blockmaps (`.blockmap`) are also uploaded for delta updates. Manifests: `latest-mac.yml` (macOS), `latest.yml` (Windows), `latest-arm64.yml` (Windows arm64), `latest-linux.yml` (Linux x64), `latest-linux-arm64.yml` (Linux arm64), plus `SHA256SUMS`.

All uploads include `Content-Disposition: attachment` headers to force downloads rather than inline viewing.

## Download Verification

Auto-updater uses SHA512 hashes from manifests. Manual downloads can verify via:

```
https://downloads.komla.dev/latest/SHA256SUMS
```

```bash
curl -O https://downloads.komla.dev/latest/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
```
