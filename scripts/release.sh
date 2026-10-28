#!/usr/bin/env bash
set -euo pipefail

# Ensure Homebrew binaries are in PATH (for wrangler, etc.). Append so a
# pinned Node (e.g. node@22) keeps precedence over Homebrew's latest node.
if [[ -d "/opt/homebrew/bin" ]]; then
  export PATH="$PATH:/opt/homebrew/bin"
fi

# ---------------------------------------------------------------------------
# release.sh — bump version, build all platforms, upload to Cloudflare R2
#
# Usage:
#   npm run release -- [subcommand] <version> [options]
#
# Subcommands:
#   full    Bump + build, pause for verification, then upload + push on resume (default)
#   build   Build only, no commit/tag/upload
#   upload  Upload only (requires x.y.z version)
#
# Examples:
#   npm run release -- patch                          # Bump + build, then pause
#   npm run release -- build patch                    # Build only
#   npm run release -- upload 0.5.1                   # Upload existing build
#   npm run release -- patch --platforms=mac,windows  # Skip Linux
#   npm run release -- patch --archs=arm64            # arm64 only
#
# Options:
#   --platforms=X,Y      Platforms to build (mac,windows,linux) [default: all]
#   --archs=X,Y          Architectures to build (arm64,x64) [default: all]
#   --skip-notarization  Skip macOS notarization (for testing only)
#   --skip-e2e           Skip Playwright e2e tests
#   --skip-vm-security   Skip the Docker SSH integration tests
#   --staging            Build for staging env, upload to staging/ prefix, skip publish
#   --dry-run            Validate setup without building or releasing
#   --resume-from=PHASE  Resume from specific phase
#   --force              Force rebuild even if artifacts exist
#   --skip-verify        Skip upload verification (on by default)
#   --no-rollback        Disable automatic rollback on failure
#   --no-parallel        Disable parallel builds (run platforms sequentially)
#   --no-cleanup         Skip removal of old R2 artifacts
#
# Phases (for --resume-from):
#   preflight, version, test, e2e, vm-security, audit, build, notarize, package, smoke-test, upload, upload-manifests, verify, publish, cleanup
# ---------------------------------------------------------------------------

# Load environment variables (Apple notarization credentials, etc.)
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

R2_BUCKET="${KOMLA_R2_BUCKET:-komla-releases}"
R2_FLAGS_BINARY=(--remote --cache-control="public, immutable, max-age=31536000")
R2_FLAGS_META=(--remote --cache-control="no-cache")
DIST_DIR="dist"
STATE_FILE=".release-state.json"
RETENTION_COUNT=20

# Options
SUBCOMMAND="full"
SKIP_NOTARIZATION=false
SKIP_E2E=false
SKIP_VM_SECURITY=false
DRY_RUN=false
FORCE_REBUILD=false
VERIFY_UPLOADS=true
NO_ROLLBACK=false
PARALLEL_BUILDS=true
NO_CLEANUP=false
STAGING=false
COLIMA_STARTED=false
RESUME_FROM=""
PLATFORMS=()
ARCHS=()

# ---- colors ----------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

# ---- helpers ---------------------------------------------------------------

die() { echo -e "${RED}error:${RESET} $*" >&2; exit 1; }

info() { echo -e "${BLUE}==>${RESET} $*"; }

success() { echo -e "${GREEN}✓${RESET} $*"; }

warn() { echo -e "${YELLOW}warning:${RESET} $*"; }

timer_start() { TIMER_START=$(date +%s); }

timer_end() {
  local elapsed=$(($(date +%s) - TIMER_START))
  local mins=$((elapsed / 60))
  local secs=$((elapsed % 60))
  if [[ $mins -gt 0 ]]; then
    echo "    (${mins}m ${secs}s)"
  else
    echo "    (${secs}s)"
  fi
}

ensure_clean_tree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "working tree is dirty — commit or stash changes first"
  fi
}

notify() {
  local title="$1" message="$2"
  if command -v osascript &>/dev/null; then
    osascript -e "display notification \"$message\" with title \"$title\" sound name \"Glass\"" 2>/dev/null || true
  elif command -v notify-send &>/dev/null; then
    notify-send "$title" "$message" 2>/dev/null || true
  fi
}

CURRENT_PHASE=""

run_phase() {
  local phase="$1"
  shift
  CURRENT_PHASE="$phase"
  local phase_start
  phase_start=$(date +%s)
  state_update "$phase" "in_progress"

  "$@"

  local duration=$(( $(date +%s) - phase_start ))
  state_update "$phase" "complete" "$duration"
  CURRENT_PHASE=""
}

validate_notarization_credentials() {
  local missing=()
  [[ -z "${APPLE_ID:-}" ]] && missing+=("APPLE_ID")
  [[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && missing+=("APPLE_APP_SPECIFIC_PASSWORD")
  [[ -z "${APPLE_TEAM_ID:-}" ]] && missing+=("APPLE_TEAM_ID")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo ""
    echo "error: Missing Apple notarization credentials"
    echo ""
    echo "  Missing variables: ${missing[*]}"
    echo ""
    echo "  Create a .env file with these variables (see .env.example):"
    echo "    APPLE_ID=your-apple-id@email.com"
    echo "    APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx"
    echo "    APPLE_TEAM_ID=XXXXXXXXXX"
    echo ""
    echo "  To create an app-specific password:"
    echo "    1. Go to https://appleid.apple.com/account/manage"
    echo "    2. Sign in with your Apple ID"
    echo "    3. Go to 'App-Specific Passwords'"
    echo "    4. Click '+' to generate a new password"
    echo ""
    echo "  To find your Team ID:"
    echo "    1. Go to https://developer.apple.com/account"
    echo "    2. Look under 'Membership details'"
    echo ""
    exit 1
  fi
  success "Notarization credentials found"
}

# Windows signing is optional: WIN_SIGN_STORETYPE turns it on for
# scripts/windows-sign.cjs (see docs/RELEASING.md).
windows_signing_enabled() { [[ -n "${WIN_SIGN_STORETYPE:-}" ]]; }

validate_windows_signing() {
  if ! windows_signing_enabled; then
    warn "WIN_SIGN_STORETYPE is not set — Windows binaries will be unsigned"
    return 0
  fi
  command -v "${JSIGN:-jsign}" >/dev/null 2>&1 \
    || die "jsign not found — install with: brew install jsign (or set JSIGN)"
  command -v osslsigncode >/dev/null 2>&1 \
    || die "osslsigncode not found — install with: brew install osslsigncode"
  success "Windows signing configured (${WIN_SIGN_STORETYPE}), jsign and osslsigncode found"
}

# ---- confirmation ----------------------------------------------------------

confirm_before_upload() {
  # --resume-from=upload = user has already inspected the build and explicitly
  # chose to upload. Resuming from any earlier phase (build, notarize, etc.)
  # still walks through the pre-upload pause.
  if [[ "$RESUME_FROM" == "upload" ]]; then
    return 0
  fi
  # Staging releases auto-upload (safe — separate app identity + bucket prefix)
  if [[ "$STAGING" == "true" ]]; then
    return 0
  fi
  # Production releases always stop here so the artifacts can be tested before
  # they go to real users. Resume explicitly with --resume-from=upload.
  echo ""
  success "Build complete for v${VERSION}"
  info "Test the artifacts in dist/, then resume with:"
  echo "  npm run release -- ${VERSION} --resume-from=upload"
  colima_stop_if_started
  trap - EXIT  # Don't rollback — this is a clean pause
  exit 0
}

# ---- state tracking --------------------------------------------------------

state_init() {
  local version="$1"
  cat > "$STATE_FILE" << EOF
{
  "version": "$version",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "phases": {}
}
EOF
}

state_update() {
  local phase="$1" status="$2"
  local duration="${3:-0}"
  local error="${4:-}"

  if [[ ! -f "$STATE_FILE" ]]; then
    return
  fi

  local tmp
  tmp=$(mktemp)

  if [[ -n "$error" ]]; then
    jq --arg phase "$phase" --arg status "$status" --argjson duration "$duration" --arg error "$error" \
      '.phases[$phase] = {status: $status, duration: $duration, error: $error}' "$STATE_FILE" > "$tmp"
  else
    jq --arg phase "$phase" --arg status "$status" --argjson duration "$duration" \
      '.phases[$phase] = {status: $status, duration: $duration}' "$STATE_FILE" > "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

state_get_phase_status() {
  local phase="$1"
  if [[ -f "$STATE_FILE" ]]; then
    jq -r --arg phase "$phase" '.phases[$phase].status // "pending"' "$STATE_FILE"
  else
    echo "pending"
  fi
}

state_get_version() {
  if [[ -f "$STATE_FILE" ]]; then
    jq -r '.version // ""' "$STATE_FILE"
  else
    echo ""
  fi
}

state_cleanup() {
  rm -f "$STATE_FILE"
}

colima_stop_if_started() {
  if [[ "$COLIMA_STARTED" == "true" ]]; then
    info "Stopping colima..."
    colima stop 2>/dev/null || true
    COLIMA_STARTED=false
  fi
}

# ---- rollback --------------------------------------------------------------

rollback() {
  local version="$1"

  if [[ "$NO_ROLLBACK" == "true" ]]; then
    warn "Rollback disabled — manual cleanup may be required"
    return 0
  fi

  warn "Rolling back release..."

  # Delete tag if it exists locally
  if git tag -l "v${version}" | grep -q .; then
    git tag -d "v${version}" 2>/dev/null || true
    echo "  deleted local tag v${version}"
  fi

  # Reset version commit if it's the HEAD
  if git log -1 --format=%s 2>/dev/null | grep -q "^v${version}$"; then
    git reset --soft HEAD~1
    git checkout HEAD -- package.json package-lock.json
    echo "  reverted version commit"
  fi

  # Revert uncommitted version bump (build-only mode)
  if ! git diff --quiet -- package.json package-lock.json 2>/dev/null; then
    git checkout -- package.json package-lock.json
    echo "  reverted uncommitted version bump"
  fi

  success "Rollback complete"
}

# ---- platform/arch selection -----------------------------------------------

parse_platforms() {
  IFS=',' read -ra PLATFORMS <<< "$1"
}

parse_archs() {
  IFS=',' read -ra ARCHS <<< "$1"
}

should_build() {
  local platform="$1"

  # If no platforms specified, build all
  if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
    return 0
  fi

  # Check if platform is in the list
  local p
  for p in "${PLATFORMS[@]}"; do
    if [[ "$p" == "$platform" ]]; then
      return 0
    fi
  done
  return 1
}

should_build_arch() {
  local arch="$1"

  # If no archs specified, build all
  if [[ ${#ARCHS[@]} -eq 0 ]]; then
    return 0
  fi

  # Check if arch is in the list
  local a
  for a in "${ARCHS[@]}"; do
    if [[ "$a" == "$arch" ]]; then
      return 0
    fi
  done
  return 1
}

# ---- incremental builds ----------------------------------------------------

should_rebuild() {
  local platform="$1" arch="$2"
  local artifact

  if [[ "$FORCE_REBUILD" == "true" ]]; then
    return 0
  fi

  case "$platform-$arch" in
    mac-arm64)    artifact="$DIST_DIR/komla-${VERSION}-arm64.zip" ;;
    mac-x64)      artifact="$DIST_DIR/komla-${VERSION}-x64.zip" ;;
    win-x64)      artifact="$DIST_DIR/komla-${VERSION}-x64-setup.exe" ;;
    win-arm64)    artifact="$DIST_DIR/komla-${VERSION}-arm64-setup.exe" ;;
    linux-x64)    artifact="$DIST_DIR/komla-${VERSION}-x86_64.AppImage" ;;
    linux-arm64)  artifact="$DIST_DIR/komla-${VERSION}-arm64.AppImage" ;;
    *)            return 0 ;;
  esac

  # Rebuild if artifact doesn't exist
  [[ ! -f "$artifact" ]]
}

# ---- upload with retry -----------------------------------------------------

is_already_uploaded() {
  local src="$1" key="$2"
  local checksum_file="${src}.uploaded-sha256"

  # After a successful upload we write a SHA-256 sidecar next to the artifact.
  # On resume we compare the current artifact's hash against that sidecar to
  # decide whether to re-upload, then verify the object actually exists on the
  # CDN with a HEAD request. The local check avoids slow downloads from R2
  # (wrangler has no HEAD command); the remote check prevents false positives
  # when the sidecar exists but the upload didn't actually land.
  if [[ ! -f "$checksum_file" ]]; then
    return 1
  fi

  local saved_hash current_hash
  saved_hash=$(cat "$checksum_file")
  current_hash=$(shasum -a 256 "$src" | awk '{print $1}')

  if [[ "$saved_hash" != "$current_hash" ]]; then
    return 1
  fi

  # Sidecar matches — verify the object is actually reachable on the CDN.
  # Distinguish a definitive 404 (object missing, must re-upload) from transient
  # network/CDN errors (keep sidecar, still re-upload this run but don't nuke
  # the proof that we uploaded successfully before).
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --head --max-time 10 "https://downloads.komla.dev/${key}" 2>/dev/null) || http_code="000"

  if [[ "$http_code" == "200" ]]; then
    return 0
  elif [[ "$http_code" == "404" || "$http_code" == "410" ]]; then
    warn "  $key has matching sidecar but returned $http_code — will re-upload"
    rm -f "$checksum_file"
    return 1
  else
    # Transient error (timeout, 5xx, DNS failure) — re-upload to be safe but
    # keep the sidecar so a future resume can skip if the CDN recovers.
    warn "  $key CDN check returned $http_code — will re-upload (keeping sidecar)"
    return 1
  fi

  return 0
}

upload_with_retry() {
  local src="$1" key="$2"
  local max_attempts=3
  local attempt=1
  local filename
  filename=$(basename "$key")

  if [[ ! -f "$src" ]]; then
    warn "$src not found, skipping"
    return 0
  fi

  # Check if already uploaded with matching hash
  if [[ "$FORCE_REBUILD" != "true" ]] && is_already_uploaded "$src" "$key"; then
    success "  $key already uploaded (hash matches), skipping"
    return 0
  fi

  local err_log
  err_log=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$err_log'" RETURN

  while [[ $attempt -le $max_attempts ]]; do
    echo "  uploading $key (attempt $attempt/$max_attempts)"
    if wrangler r2 object put "${R2_BUCKET}/${key}" --file="$src" "${R2_FLAGS[@]}" \
        --content-disposition "attachment; filename=\"${filename}\"" 2>"$err_log"; then
      # Write SHA-256 sidecar so resume can skip this file
      shasum -a 256 "$src" | awk '{print $1}' > "${src}.uploaded-sha256"
      return 0
    fi

    warn "Upload failed: $(cat "$err_log")"

    if [[ $attempt -lt $max_attempts ]]; then
      local delay=$((attempt * 5))
      warn "Retrying in ${delay}s..."
      sleep "$delay"
    fi
    ((attempt++))
  done

  die "Upload failed after $max_attempts attempts: $key"
}


# ---- upload verification ---------------------------------------------------

verify_upload() {
  local key="$1" expected_checksum="$2"
  local tmp

  tmp=$(mktemp)
  trap 'rm -f "${tmp:-}"' RETURN

  if ! curl -sf "https://downloads.komla.dev/${key}" -o "$tmp"; then
    return 1
  fi

  local actual_checksum
  actual_checksum=$(shasum -a 256 "$tmp" | cut -d' ' -f1)

  [[ "$actual_checksum" == "$expected_checksum" ]]
}

verify_all_uploads() {
  info "Verifying uploads..."

  local checksums_file="$DIST_DIR/SHA256SUMS"
  if [[ ! -f "$checksums_file" ]]; then
    warn "SHA256SUMS not found, skipping verification"
    return 0
  fi

  local failures=0

  while IFS= read -r line; do
    local checksum file
    checksum=$(echo "$line" | awk '{print $1}')
    file=$(echo "$line" | awk '{print $2}')

    # Map local filename to remote key
    local key="${UPLOAD_PREFIX}/$file"

    echo "  verifying $file..."
    if verify_upload "$key" "$checksum"; then
      success "  $file OK"
    else
      warn "  $file FAILED"
      ((failures++))
    fi
  done < "$checksums_file"

  if [[ $failures -gt 0 ]]; then
    die "Upload verification failed for $failures file(s)"
  fi

  success "All uploads verified"
}

# ---- smoke test ------------------------------------------------------------

run_smoke_test() {
  local artifact="$DIST_DIR/komla-${VERSION}-arm64.zip"

  if [[ ! -f "$artifact" ]]; then
    warn "macOS arm64 artifact not found, skipping smoke test"
    return 0
  fi

  info "Running pre-upload smoke test..."

  local tmp_dir
  tmp_dir=$(mktemp -d)
  # Clean up temp dir on function return, and avoid leaking the trap to other functions.
  trap '[[ -n "${tmp_dir:-}" ]] && rm -rf "$tmp_dir"; trap - RETURN' RETURN

  # Extract the way Finder and the updater do. The notarized zip stores extended
  # attributes as AppleDouble entries; ditto restores them, while unzip writes
  # them out as ._ files that break the app's signature.
  ditto -x -k "$artifact" "$tmp_dir"

  local app_name="Komla.app"
  [[ "$STAGING" == "true" ]] && app_name="Komla Staging.app"
  local app_path="$tmp_dir/$app_name"
  if [[ ! -d "$app_path" ]]; then
    warn "$app_name not found in archive, skipping smoke test"
    return 0
  fi

  # Verify ripgrep binary is bundled. Newer @vscode/ripgrep versions expose
  # the executable from a platform package, e.g. @vscode/ripgrep-darwin-arm64.
  local rg_relative
  rg_relative=$(node -e "const path = require('path'); const { rgPath } = require('@vscode/ripgrep'); console.log(path.relative(process.cwd(), rgPath));")
  local rg_unpacked="$app_path/Contents/Resources/app.asar.unpacked/$rg_relative"
  if [[ ! -f "$rg_unpacked" ]]; then
    die "Smoke test failed — ripgrep binary not found in packaged app at: $rg_unpacked"
  fi
  success "Ripgrep binary found in packaged app"

  # Voice transcription and keyboard layouts load their native modules only when
  # first used, so the launch below can't show that their files shipped.
  if ! ELECTRON_RUN_AS_NODE=1 "$app_path/Contents/MacOS/${app_name%.app}" \
    scripts/check-packaged-native-modules.cjs "$app_path/Contents/Resources/app.asar"; then
    die "Smoke test failed — a native module does not load in the packaged app"
  fi
  success "Native modules load in packaged app"

  # Verify bundled version matches expected release version
  local bundled_version
  bundled_version=$(defaults read "$app_path/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "")
  if [[ -z "$bundled_version" ]]; then
    warn "Could not read version from Info.plist"
  elif [[ "$bundled_version" != "$VERSION" ]]; then
    die "Smoke test failed — bundled version ($bundled_version) does not match release version ($VERSION)"
  else
    success "Bundled version matches: $bundled_version"
  fi

  # Launch app and capture stderr
  local stderr_log
  stderr_log=$(mktemp)
  open -g -a "$app_path" 2>"$stderr_log" &
  local open_pid=$!
  sleep 5

  # Find the actual app process
  local app_pid
  app_pid=$(pgrep -f "${app_name}/Contents/MacOS/" 2>/dev/null || true)

  if [[ -n "$app_pid" ]]; then
    # App is running, kill it
    kill "$app_pid" 2>/dev/null || true
    wait "$open_pid" 2>/dev/null || true
    success "Smoke test passed — app launched successfully"
  else
    # Check if it crashed
    wait "$open_pid" 2>/dev/null || true
    if [[ -s "$stderr_log" ]]; then
      warn "App stderr output:"
      cat "$stderr_log" >&2
    fi
    rm -f "$stderr_log"
    die "Smoke test failed — app crashed on launch"
  fi

  # Report any stderr warnings (don't fail — some Electron noise is normal)
  if [[ -s "$stderr_log" ]]; then
    warn "App produced stderr output during launch:"
    head -20 "$stderr_log" >&2
  fi
  rm -f "$stderr_log"
}

# ---- phase ordering --------------------------------------------------------

# Defined before phase_preflight because preflight calls it (notarize and
# vm-security checks are gated on resume-from semantics).
should_run_phase() {
  local phase="$1"

  # If resuming, check if we should skip this phase
  if [[ -n "$RESUME_FROM" ]]; then
    local phases=("preflight" "version" "test" "e2e" "vm-security" "audit" "build" "notarize" "package" "smoke-test" "upload" "upload-manifests" "verify" "publish" "cleanup")
    local found_resume=false

    for p in "${phases[@]}"; do
      if [[ "$p" == "$RESUME_FROM" ]]; then
        found_resume=true
      fi
      if [[ "$found_resume" == "true" ]] && [[ "$p" == "$phase" ]]; then
        return 0
      fi
    done
    return 1
  fi

  return 0
}

# ---- phase functions -------------------------------------------------------

phase_preflight() {
  info "Running pre-flight checks..."

  # Upload-only doesn't modify the tree — no need for a clean worktree
  if [[ "$SUBCOMMAND" != "upload" ]]; then
    ensure_clean_tree
    success "Working tree is clean"
  fi

  # Only require Apple credentials when the current run will actually notarize.
  # Skip for upload-only, resume-past-notarize, staging, and non-mac builds.
  if [[ "$SKIP_NOTARIZATION" != "true" ]] && should_build "mac" && [[ "$SUBCOMMAND" != "upload" ]]; then
    if [[ -z "$RESUME_FROM" ]] || should_run_phase "notarize"; then
      validate_notarization_credentials
    else
      echo "  (skipping notarization credential check — resuming past notarize phase)"
    fi
  elif should_build "mac"; then
    echo "  (skipping notarization credential check)"
  fi

  # Verify ripgrep binary exists. Newer @vscode/ripgrep versions expose the
  # executable from a platform package, e.g. @vscode/ripgrep-darwin-arm64.
  local rg_bin
  rg_bin=$(node -e "const { rgPath } = require('@vscode/ripgrep'); console.log(rgPath);")
  if [[ ! -x "$rg_bin" ]]; then
    die "Ripgrep binary not found at $rg_bin — run npm install to restore @vscode/ripgrep"
  fi
  success "Ripgrep binary found"

  command -v wrangler >/dev/null 2>&1 || die "wrangler CLI not found — install with: npm i -g wrangler"
  success "wrangler CLI found"

  # Official builds embed the managed utility token, which is not in the source
  # tree. electron.vite.config.ts refuses to build an official app without it.
  if [[ "$SUBCOMMAND" != "upload" ]] && { [[ -z "$RESUME_FROM" ]] || should_run_phase "build"; }; then
    [[ -n "${KOMLA_UTILITY_TOKEN:-}" ]] \
      || die "KOMLA_UTILITY_TOKEN not set — add it to .env (see .env.example)"
    success "Utility token found"
  fi

  # Every packaged platform includes the shared Komla executable matrix, so
  # any build phase needs cargo-xwin even when the app platform filter omits Windows.
  if [[ "$SUBCOMMAND" != "upload" ]] && { [[ -z "$RESUME_FROM" ]] || should_run_phase "build"; }; then
    cargo xwin --version >/dev/null 2>&1 \
      || die "cargo-xwin not found — install with: cargo install cargo-xwin --version 0.19.2 --locked"
    success "cargo-xwin found"
  fi

  # Every packaged app embeds the full Komla CLI/companion matrix, whose Linux
  # artifacts are built in Docker even for macOS-only or Windows-only releases.
  if [[ "$SUBCOMMAND" != "upload" ]] && { [[ -z "$RESUME_FROM" ]] || should_run_phase "build"; }; then
    command -v docker >/dev/null 2>&1 || die "docker CLI not found — install Docker Desktop or colima"
    success "docker CLI found"

    if ! docker info >/dev/null 2>&1; then
      if command -v colima >/dev/null 2>&1; then
        info "Docker is not running — starting colima..."
        colima start || die "Failed to start colima"
        COLIMA_STARTED=true
        success "colima started"
      else
        die "Docker is not running — start Docker Desktop or install colima"
      fi
    else
      success "Docker is running"
    fi
  fi

  if should_build "windows"; then
    if ! command -v wine &>/dev/null && [[ ! -x "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine" ]]; then
      die "Wine not found — install with: brew install --cask wine-stable"
    fi
    success "Wine found"
  fi

  if should_build "windows" && [[ "$SUBCOMMAND" != "upload" ]]; then
    validate_windows_signing
  fi

  # The integration phase runs a Docker SSH host. Validate it up front so
  # failures surface before the test phase.
  if [[ "$SKIP_VM_SECURITY" != "true" ]] && [[ "$SUBCOMMAND" != "upload" ]]; then
    if [[ -z "$RESUME_FROM" ]] || should_run_phase "vm-security"; then
      command -v docker >/dev/null 2>&1 \
        || die "docker CLI not found — install Docker Desktop or Docker Engine (or pass --skip-vm-security)"
      docker info >/dev/null 2>&1 \
        || die "Docker is not running — start Docker Desktop or Docker Engine (or pass --skip-vm-security)"
      success "Docker is running"
    fi
  fi

  echo ""
}

phase_version() {
  local version_arg="$BUMP"

  if [[ "$STAGING" == "true" ]]; then
    version_arg=$(node -e "
const semver = require('semver');
const pkg = require('./package.json');
const bump = process.argv[1];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (['patch', 'minor', 'major'].includes(bump)) {
  const current = semver.parse(pkg.version);
  if (!current) fail('invalid package.json version: ' + pkg.version);

  const prerelease = current.prerelease;
  if (prerelease[0] === 'staging') {
    const next = Number(prerelease[1] || 0) + 1;
    console.log(current.major + '.' + current.minor + '.' + current.patch + '-staging.' + next);
  } else {
    const nextBase = semver.inc(pkg.version, bump);
    if (!nextBase) fail('could not bump version: ' + pkg.version);
    console.log(nextBase + '-staging.1');
  }
} else if (semver.valid(bump)) {
  console.log(bump);
} else {
  fail('invalid staging version argument: ' + bump);
}
" "$BUMP")
  fi

  npm version "$version_arg" --no-git-tag-version
  VERSION=$(node -p "require('./package.json').version")
  info "Version is now $VERSION"

  # Verify CHANGELOG.md has an entry for this version when present.
  # Allow empty/no-entry changelogs so production releases can ship without notes.
  if [[ "$STAGING" != "true" ]]; then
    if grep -q "## \[${VERSION}\]" CHANGELOG.md; then
      success "CHANGELOG.md has entry for v${VERSION}"
    else
      warn "CHANGELOG.md has no entry for v${VERSION} — continuing without release notes"
    fi
  else
    info "Skipping changelog check (staging release)"
  fi

  # Initialize state tracking
  state_init "$VERSION"

  git add package.json package-lock.json
  git commit -m "v${VERSION}"
  git tag "v${VERSION}"
  success "Committed and tagged v${VERSION}"
}

phase_test() {
  info "Running tests..."
  npm test
  success "Tests passed"
}

phase_e2e() {
  info "Running Playwright e2e tests..."
  KOMLA_E2E_HIDE_WINDOWS=1 npm run test:e2e
  success "e2e tests passed"
}

phase_vm_security() {
  local companion_target
  companion_target=$(bash scripts/native-host-target.sh Linux "$(uname -m)")
  info "Building the ${companion_target} Remote Companion required by SSH integration tests..."
  bash scripts/build-native-matrix.sh "$companion_target"
  info "Running Docker SSH workspace integration tests..."
  npm run test:integration
  success "Integration tests passed"
}

phase_audit() {
  info "Running security audit (shipped dependencies, high+ severity)..."
  node scripts/audit-shipped-deps.mjs
  success "Security audit passed"
}

phase_build_mac() {
  if ! should_build "mac"; then
    echo "  (skipping macOS build)"
    return 0
  fi

  local build_arm64=false build_x64=false
  should_build_arch "arm64" && build_arm64=true
  should_build_arch "x64" && build_x64=true

  # Check for incremental build
  local needs_build=false
  if [[ "$build_arm64" == "true" ]] && should_rebuild "mac" "arm64"; then
    needs_build=true
  fi
  if [[ "$build_x64" == "true" ]] && should_rebuild "mac" "x64"; then
    needs_build=true
  fi

  if [[ "$needs_build" != "true" ]]; then
    success "macOS artifacts exist, skipping build (use --force to rebuild)"
    return 0
  fi

  local builder_args=(--mac)
  [[ "$build_arm64" == "true" ]] && builder_args+=(--arm64)
  [[ "$build_x64" == "true" ]] && builder_args+=(--x64)

  # afterPack removes stale build/ dirs from native modules (node-pty,
  # @parcel/watcher) so the correct per-arch prebuild is always used.
  # In parallel mode it also swaps pre-cached keyboard-layout binaries
  # and disables npmRebuild to keep node_modules/ stable across jobs.
  builder_args+=(--config.afterPack=./scripts/afterPack.cjs)
  if [[ -n "${NATIVE_MODULES_CACHE:-}" ]]; then
    builder_args+=(--config.npmRebuild=false)
  fi

  # Staging builds use different app identity so both can coexist
  if [[ "$STAGING" == "true" ]]; then
    builder_args+=(-c.appId=com.komla.staging "-c.productName=Komla Staging")
  fi

  # Always disable electron-builder's built-in notarization — we handle it in a
  # separate phase (phase_notarize) so it can be resumed independently on failure.
  builder_args+=("-c.mac.notarize=false")

  local arch_desc=""
  [[ "$build_arm64" == "true" ]] && arch_desc="arm64"
  [[ "$build_x64" == "true" ]] && arch_desc="${arch_desc:+$arch_desc + }x64"

  info "Building macOS ($arch_desc)..."
  timer_start
  npx electron-builder "${builder_args[@]}"
  timer_end
  success "macOS build complete"
}

phase_notarize() {
  if ! should_build "mac"; then
    echo "  (skipping notarization — macOS not selected)"
    return 0
  fi

  if [[ "$SKIP_NOTARIZATION" == "true" ]]; then
    echo "  (skipping notarization)"
    return 0
  fi

  validate_notarization_credentials

  if ! node -e "require('app-builder-lib/out/targets/blockmap/blockmap')" >/dev/null 2>&1; then
    die "app-builder-lib blockmap generator not found"
  fi

  info "Notarizing macOS apps..."
  timer_start

  local app_name="Komla.app"
  [[ "$STAGING" == "true" ]] && app_name="Komla Staging.app"

  for app_dir in "$DIST_DIR/mac-arm64" "$DIST_DIR/mac"; do
    if [[ ! -d "$app_dir" ]]; then
      continue
    fi

    local arch_label
    [[ "$app_dir" == *arm64* ]] && arch_label="arm64" || arch_label="x64"

    # Skip if this arch wasn't selected (avoids notarizing stale artifacts)
    if ! should_build_arch "$arch_label"; then
      continue
    fi

    local app_path="$app_dir/$app_name"
    if [[ ! -d "$app_path" ]]; then
      warn "  $app_path not found, skipping"
      continue
    fi

    # 1. Submit for notarization
    echo "  notarizing $arch_label ($app_path)..."
    local submit_zip
    submit_zip=$(mktemp).zip
    ditto -c -k --keepParent "$app_path" "$submit_zip"

    xcrun notarytool submit "$submit_zip" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait

    rm -f "$submit_zip"

    # 2. Staple the notarization ticket
    xcrun stapler staple "$app_path"
    success "  $arch_label notarized"

    # 3. Regenerate ZIP and blockmap from the stapled .app
    #    The auto-updater downloads these, so they must contain the stapled ticket.
    local release_zip="$DIST_DIR/komla-${VERSION}-${arch_label}.zip"
    echo "  regenerating $arch_label zip..."
    ditto -c -k --keepParent "$app_path" "$release_zip"
    node -e "
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
buildBlockMap(process.argv[1], 'gzip', process.argv[2]).catch((error) => {
  console.error(error)
  process.exit(1)
})
" "$release_zip" "${release_zip}.blockmap"

    # 4. Staple the DMG directly (Apple's servers have the ticket from the .app submission).
    local release_dmg="$DIST_DIR/komla-${VERSION}-${arch_label}.dmg"
    if [[ -f "$release_dmg" ]]; then
      echo "  stapling $arch_label dmg..."
      xcrun stapler staple "$release_dmg" || warn "  DMG stapling failed (non-fatal — Gatekeeper will use online check)"
    fi
  done

  # 5. Patch the macOS manifest so SHA512/size match the regenerated ZIPs.
  #    electron-builder wrote the manifest with pre-notarization hashes; the
  #    auto-updater uses these to validate downloads.
  _patch_mac_manifest

  timer_end
  success "Notarization complete"
}

# Update SHA512 and size in the macOS manifest for regenerated ZIP artifacts.
_patch_mac_manifest() {
  local manifest_name="latest-mac.yml"
  [[ "$STAGING" == "true" ]] && manifest_name="staging-mac.yml"
  local manifest="$DIST_DIR/$manifest_name"

  if [[ ! -f "$manifest" ]]; then
    warn "  macOS manifest not found at $manifest, skipping patch"
    return 0
  fi

  echo "  patching macOS manifest hashes..."

  for arch_label in arm64 x64; do
    if ! should_build_arch "$arch_label"; then
      continue
    fi

    local zip_file="$DIST_DIR/komla-${VERSION}-${arch_label}.zip"
    if [[ ! -f "$zip_file" ]]; then
      continue
    fi

    local zip_name
    zip_name=$(basename "$zip_file")
    local new_sha512
    new_sha512=$(shasum -a 512 "$zip_file" | awk '{print $1}' | xxd -r -p | base64)
    local new_size
    new_size=$(stat -f%z "$zip_file")

    # Update the files[] entry and top-level path/sha512 for this zip.
    # Exits non-zero if the expected entry wasn't found in the manifest.
    python3 -c "
import sys, re

manifest = open('$manifest').read()
original = manifest

# Update files[] entry: match url line, then sha512 and size lines
pattern = r'(- url: $(python3 -c "import re; print(re.escape('$zip_name'))")\n    sha512: )[^\n]+(\n    size: )\d+'
manifest, count = re.subn(pattern, r'\g<1>$new_sha512\g<2>$new_size', manifest)
if count == 0:
    print('error: files[] entry for $zip_name not found in manifest', file=sys.stderr)
    sys.exit(1)

# Update top-level path/sha512 if it matches this zip
if 'path: $zip_name' in manifest:
    manifest = re.sub(r'(path: $(python3 -c "import re; print(re.escape('$zip_name'))")\nsha512: )[^\n]+', r'\g<1>$new_sha512', manifest)

open('$manifest', 'w').write(manifest)
"
    echo "    updated $zip_name: size=$new_size"
  done
}

phase_build_windows() {
  if ! should_build "windows"; then
    echo "  (skipping Windows build)"
    return 0
  fi

  local build_arm64=false build_x64=false
  should_build_arch "arm64" && build_arm64=true
  should_build_arch "x64" && build_x64=true

  # Check for incremental build
  local needs_build=false
  if [[ "$build_x64" == "true" ]] && should_rebuild "win" "x64"; then
    needs_build=true
  fi
  if [[ "$build_arm64" == "true" ]] && should_rebuild "win" "arm64"; then
    needs_build=true
  fi

  if [[ "$needs_build" != "true" ]]; then
    success "Windows artifacts exist, skipping build (use --force to rebuild)"
    return 0
  fi

  local arch_desc=""
  [[ "$build_x64" == "true" ]] && arch_desc="x64"
  [[ "$build_arm64" == "true" ]] && arch_desc="${arch_desc:+$arch_desc + }arm64"

  info "Building Windows ($arch_desc) via Wine..."
  timer_start
  # build-windows.sh builds both archs; pass specific ones if filtering
  if [[ "$build_x64" == "true" ]] && [[ "$build_arm64" == "true" ]]; then
    bash scripts/build-windows.sh
  elif [[ "$build_x64" == "true" ]]; then
    bash scripts/build-windows.sh x64
  elif [[ "$build_arm64" == "true" ]]; then
    bash scripts/build-windows.sh arm64
  fi
  timer_end
  success "Windows build complete"
}

phase_build_linux_x64() {
  if ! should_build "linux" || ! should_build_arch "x64"; then
    return 0
  fi

  if should_rebuild "linux" "x64"; then
    info "Building Linux x64 via Docker..."
    timer_start
    bash scripts/build-linux.sh x64
    timer_end
    success "Linux x64 build complete"
  else
    success "Linux x64 artifact exists, skipping build (use --force to rebuild)"
  fi
}

phase_build_linux_arm64() {
  if ! should_build "linux" || ! should_build_arch "arm64"; then
    return 0
  fi

  if should_rebuild "linux" "arm64"; then
    info "Building Linux arm64 via Docker (this may take 10-30 minutes)..."
    timer_start
    bash scripts/build-linux.sh arm64
    timer_end
    success "Linux arm64 build complete"
  else
    success "Linux arm64 artifact exists, skipping build (use --force to rebuild)"
  fi
}

phase_build_linux() {
  if ! should_build "linux"; then
    echo "  (skipping Linux build)"
    return 0
  fi

  phase_build_linux_x64
  phase_build_linux_arm64
}

# Fails the release when a Windows binary has no signature or changed after
# signing. osslsigncode also checks the certificate chain against its own CA
# bundle, which lacks some code-signing roots (Microsoft's among them), so a
# chain it cannot build only warns; Get-AuthenticodeSignature on Windows is the
# final check.
verify_windows_signature() {
  local file="$1" output
  [[ -f "$file" ]] || die "Cannot verify the signature of a missing file: $file"
  if output=$(osslsigncode verify -in "$file" 2>&1); then
    echo "  signed: $file"
  elif grep -q "No signature found" <<<"$output"; then
    die "Not signed: $file (built before signing was configured? rebuild with --force)"
  elif grep -q "MISMATCH" <<<"$output"; then
    die "Signature does not match the file contents: $file"
  else
    warn "Signed, but osslsigncode could not verify the certificate chain: $file"
  fi
}

verify_windows_signatures() {
  windows_signing_enabled || return 0
  command -v osslsigncode >/dev/null 2>&1 \
    || die "osslsigncode not found — install with: brew install osslsigncode"
  info "Verifying Windows signatures..."
  local exe="Komla.exe"
  [[ "${KOMLA_ENV:-}" == "staging" ]] && exe="Komla Staging.exe"
  local arch unpacked target
  for arch in x64 arm64; do
    should_build_arch "$arch" || continue
    unpacked="$DIST_DIR/win-unpacked"
    [[ "$arch" == "arm64" ]] && unpacked="$DIST_DIR/win-arm64-unpacked"
    verify_windows_signature "$DIST_DIR/komla-${VERSION}-${arch}-setup.exe"
    verify_windows_signature "$unpacked/$exe"
    for target in x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
      verify_windows_signature "$unpacked/resources/native/$target/komla.exe"
    done
  done
  success "Windows binaries are signed"
}

phase_package() {
  # Zip Windows installers for manual download (prevents browser SmartScreen warnings)
  if should_build "windows"; then
    verify_windows_signatures
    info "Zipping Windows installers for manual download..."
    for arch in x64 arm64; do
      if should_build_arch "$arch"; then
        exe="$DIST_DIR/komla-${VERSION}-${arch}-setup.exe"
        zipfile="$DIST_DIR/komla-${VERSION}-${arch}-setup.zip"
        if [[ -f "$exe" ]]; then
          rm -f "$zipfile"
          zip -j "$zipfile" "$exe"
          echo "  created $(basename "$zipfile")"
        fi
      fi
    done
    success "Windows ZIP archives created"
  fi

  # Generate checksums
  info "Generating checksums..."
  bash scripts/generate-checksums.sh "$VERSION"
  success "Checksums generated"
}

phase_smoke_test() {
  if should_build "mac"; then
    run_smoke_test
  fi
}

phase_upload() {
  info "Uploading binaries to R2 (bucket: $R2_BUCKET)"
  R2_FLAGS=("${R2_FLAGS_BINARY[@]}")

  # macOS DMGs (manual download) + ZIPs + blockmaps (auto-updater)
  if should_build "mac"; then
    if should_build_arch "arm64"; then
      upload_with_retry "$DIST_DIR/komla-${VERSION}-arm64.dmg"          "${UPLOAD_PREFIX}/komla-${VERSION}-arm64.dmg"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-arm64.zip"          "${UPLOAD_PREFIX}/komla-${VERSION}-arm64.zip"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-arm64.zip.blockmap" "${UPLOAD_PREFIX}/komla-${VERSION}-arm64.zip.blockmap"
    fi
    if should_build_arch "x64"; then
      upload_with_retry "$DIST_DIR/komla-${VERSION}-x64.dmg"          "${UPLOAD_PREFIX}/komla-${VERSION}-x64.dmg"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-x64.zip"          "${UPLOAD_PREFIX}/komla-${VERSION}-x64.zip"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-x64.zip.blockmap" "${UPLOAD_PREFIX}/komla-${VERSION}-x64.zip.blockmap"
    fi
  fi

  if should_build "windows"; then
    if should_build_arch "x64"; then
      upload_with_retry "$DIST_DIR/komla-${VERSION}-x64-setup.exe"            "${UPLOAD_PREFIX}/komla-${VERSION}-x64-setup.exe"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-x64-setup.exe.blockmap"   "${UPLOAD_PREFIX}/komla-${VERSION}-x64-setup.exe.blockmap"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-x64-setup.zip"            "${UPLOAD_PREFIX}/komla-${VERSION}-x64-setup.zip"
    fi
    if should_build_arch "arm64"; then
      upload_with_retry "$DIST_DIR/komla-${VERSION}-arm64-setup.exe"          "${UPLOAD_PREFIX}/komla-${VERSION}-arm64-setup.exe"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-arm64-setup.exe.blockmap" "${UPLOAD_PREFIX}/komla-${VERSION}-arm64-setup.exe.blockmap"
      upload_with_retry "$DIST_DIR/komla-${VERSION}-arm64-setup.zip"          "${UPLOAD_PREFIX}/komla-${VERSION}-arm64-setup.zip"
    fi
  fi

  if should_build "linux"; then
    if should_build_arch "x64"; then
      upload_with_retry "$DIST_DIR/komla-${VERSION}-x86_64.AppImage" "${UPLOAD_PREFIX}/komla-${VERSION}-x86_64.AppImage"
    fi
    if should_build_arch "arm64"; then
      upload_with_retry "$DIST_DIR/komla-${VERSION}-arm64.AppImage" "${UPLOAD_PREFIX}/komla-${VERSION}-arm64.AppImage"
    fi
  fi
}

phase_upload_manifests() {
  R2_FLAGS=("${R2_FLAGS_META[@]}")

  local mac_manifest="latest-mac.yml"
  local windows_manifest="latest.yml"
  local linux_x64_manifest="latest-linux.yml"
  local linux_arm64_manifest="latest-linux-arm64.yml"

  if [[ "$STAGING" == "true" ]]; then
    # electron-builder names a prerelease's manifests after its channel, but the
    # updater fetches latest*.yml under staging/latest/. dist/latest*.yml are the
    # last production build's, so uploading them would hide the staging release.
    mac_manifest="staging-mac.yml"
    windows_manifest="staging.yml"
    linux_x64_manifest="staging-linux.yml"
    linux_arm64_manifest="staging-linux-arm64.yml"
  fi

  patch_and_upload_manifest() {
    local file="$1" key="$2" min_system_version="${3:-}"
    local src="$DIST_DIR/$file"
    [[ -f "$src" ]] || { echo "  warning: $src not found, skipping"; return 0; }

    echo "  patching + uploading $key"
    local tmp
    tmp=$(mktemp)

    # Remove the universal installer entry from the YAML files list.
    # Uses the YAML list marker (  - ) and continuation indent (    ) to detect
    # entry boundaries, so this works regardless of how many fields per entry.
    # Optionally add minimumSystemVersion after the top-level version line.
    awk -v min_system_version="$min_system_version" '
      /^  - url: komla-'"${VERSION}"'-setup\.exe/ { skip=1; next }
      /^  - url: komla-setup\.exe/ { skip=1; next }
      skip && !/^    / { skip=0 }
      skip { next }
      { print }
      min_system_version != "" && /^version: / { print "minimumSystemVersion: " min_system_version }
    ' "$src" > "$tmp"

    wrangler r2 object put "${R2_BUCKET}/${key}" --file="$tmp" "${R2_FLAGS[@]}"
    rm -f "$tmp"
  }

  info "Uploading manifests to R2"

  if should_build "mac"; then
    # Electron 44 requires macOS 13 (Darwin 22). electron-updater compares
    # minimumSystemVersion with os.release(), the Darwin version on macOS, and
    # skips updates the OS can't run, so macOS 12 stays on its last working
    # release. Raise this when an Electron upgrade drops a macOS version.
    patch_and_upload_manifest "$mac_manifest" "${UPLOAD_PREFIX}/latest-mac.yml" "22.0.0"
  fi

  if should_build "windows"; then
    patch_and_upload_manifest "$windows_manifest" "${UPLOAD_PREFIX}/latest.yml"
    # Upload ARM64-specific manifest for Windows ARM64 auto-updater.
    # electron-updater on Windows has no built-in arch suffix, so the ARM64
    # app uses channel "latest-arm64" which fetches latest-arm64.yml.
    # Note: this uploads the same latest.yml source — when both archs are built
    # together, the manifest lists all files and electron-updater selects by
    # filename; when archs are built separately (--archs=arm64), it contains
    # only arm64 assets, preventing the x64 build from overwriting it.
    if should_build_arch "arm64"; then
      patch_and_upload_manifest "$windows_manifest" "${UPLOAD_PREFIX}/latest-arm64.yml"
    fi
  fi

  if should_build "linux"; then
    if should_build_arch "x64"; then
      patch_and_upload_manifest "$linux_x64_manifest" "${UPLOAD_PREFIX}/latest-linux.yml"
    fi
    if should_build_arch "arm64"; then
      patch_and_upload_manifest "$linux_arm64_manifest" "${UPLOAD_PREFIX}/latest-linux-arm64.yml"
    fi
  fi

  # Upload checksums
  info "Uploading checksums to R2"
  if [[ -f "$DIST_DIR/SHA256SUMS" ]]; then
    upload_with_retry "$DIST_DIR/SHA256SUMS" "${UPLOAD_PREFIX}/SHA256SUMS"
  fi
}

phase_verify() {
  if [[ "$VERIFY_UPLOADS" == "true" ]]; then
    verify_all_uploads
  fi
}

phase_publish() {
  info "Pushing to remote..."
  # Only this release's tag: --tags would also push every other local tag.
  git push origin HEAD "refs/tags/v${VERSION}"
  success "Pushed to remote"
}

phase_cleanup() {
  info "Cleaning up old releases (keeping newest $RETENTION_COUNT versions)..."

  # CHANGELOG.md lists versions newest-first
  local versions
  versions=$(sed -n 's/^## \[\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)\].*/\1/p' CHANGELOG.md)

  if [[ -z "$versions" ]]; then
    warn "No versions found in CHANGELOG.md, skipping cleanup"
    return 0
  fi

  local version_count
  version_count=$(echo "$versions" | wc -l | tr -d ' ')

  if [[ "$version_count" -le "$RETENTION_COUNT" ]]; then
    success "Only $version_count versions in changelog, nothing to clean up"
    return 0
  fi

  # Skip the newest RETENTION_COUNT, delete the rest
  local old_versions
  old_versions=$(echo "$versions" | tail -n +"$((RETENTION_COUNT + 1))")
  local delete_count
  delete_count=$(echo "$old_versions" | wc -l | tr -d ' ')

  echo "  $version_count total versions, removing $delete_count oldest..."

  while IFS= read -r old_ver; do
    [[ -z "$old_ver" ]] && continue
    for key in \
      "${UPLOAD_PREFIX}/komla-${old_ver}-arm64.zip" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-arm64.zip.blockmap" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-x64.zip" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-x64.zip.blockmap" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-arm64.dmg" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-x64.dmg" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-x64-setup.exe" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-x64-setup.exe.blockmap" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-arm64-setup.exe" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-arm64-setup.exe.blockmap" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-x64-setup.zip" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-arm64-setup.zip" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-x86_64.AppImage" \
      "${UPLOAD_PREFIX}/komla-${old_ver}-arm64.AppImage"; do
      wrangler r2 object delete "${R2_BUCKET}/${key}" --remote 2>/dev/null || true
    done
    echo "    removed v${old_ver}"
  done <<< "$old_versions"

  success "Cleaned up $delete_count old versions"
}

# ---- build orchestration ---------------------------------------------------

build_all_platforms() {
  # Check if any platform actually needs rebuilding before running Vite compilation
  local any_needs_build=false
  if [[ "$FORCE_REBUILD" == "true" ]]; then
    any_needs_build=true
  else
    for plat_arch in mac-arm64 mac-x64 win-x64 win-arm64 linux-x64 linux-arm64; do
      local plat="${plat_arch%-*}" arch="${plat_arch#*-}"
      # Map platform names to should_build format
      case "$plat" in
        mac) should_build "mac" || continue ;;
        win) should_build "windows" || continue ;;
        linux) should_build "linux" || continue ;;
      esac
      should_build_arch "$arch" || continue
      if should_rebuild "$plat" "$arch"; then
        any_needs_build=true
        break
      fi
    done
  fi

  if [[ "$any_needs_build" != "true" ]]; then
    success "All platform artifacts exist, skipping build (use --force to rebuild)"
    return 0
  fi

  info "Compiling app..."
  info "Building Komla CLI and Remote Companion matrix..."
  npm run build:native:matrix
  npm run build

  # Pre-install @parcel/watcher platform packages for all target platforms.
  # npm only installs the host platform's optional dep by default. afterPack
  # asserts these exist before removing build/ dirs, and in parallel mode
  # npmRebuild=false means electron-builder won't install cross-arch variants.
  local watcher_pkgs=()
  if should_build "mac"; then
    watcher_pkgs+=("@parcel/watcher-darwin-arm64:darwin:arm64" "@parcel/watcher-darwin-x64:darwin:x64")
  fi
  if should_build "windows"; then
    watcher_pkgs+=("@parcel/watcher-win32-x64:win32:x64" "@parcel/watcher-win32-arm64:win32:arm64")
    # build-windows.sh reinstalls its prebuilds (pruning other --no-save packages
    # mid-build) unless the ripgrep variants are present too.
    watcher_pkgs+=("@vscode/ripgrep-win32-x64:win32:x64" "@vscode/ripgrep-win32-arm64:win32:arm64")
  fi
  if [[ ${#watcher_pkgs[@]} -gt 0 ]]; then
    info "Pre-installing @parcel/watcher platform packages..."
    local watcher_install_args=()
    for watcher_spec in "${watcher_pkgs[@]}"; do
      local watcher_pkg="${watcher_spec%%:*}"
      local watcher_version
      local watcher_parent="@parcel/watcher"
      [[ "$watcher_pkg" == @vscode/ripgrep-* ]] && watcher_parent="@vscode/ripgrep"
      watcher_version=$(node -p "require('./node_modules/${watcher_parent}/package.json').optionalDependencies['$watcher_pkg']")
      watcher_install_args+=("${watcher_pkg}@${watcher_version}")
    done
    npm install --no-save --force "${watcher_install_args[@]}"
  fi

  if [[ "$PARALLEL_BUILDS" == "true" ]]; then
    # Parallel mode: pre-rebuild keyboard-layout for each macOS target arch and
    # cache the .node files. Then run all three platforms in parallel with macOS
    # using npmRebuild=false — the afterPack hook swaps in the correct cached
    # keyboard-layout binary per arch. afterPack also removes stale build/ dirs
    # from node-pty and @parcel/watcher so the correct prebuilds are used.
    # Linux uses Docker (isolated filesystem).
    # Linux arm64 runs after x64 since both Docker containers mount the project dir.

    # Pre-build keyboard-layout for each macOS arch before spawning
    # parallel jobs so that node_modules/ is never mutated during packaging.

    if should_build "mac"; then
      local cache_dir="$(pwd)/.cache/native-modules"
      rm -rf "$cache_dir"
      local kl_build="node_modules/keyboard-layout/build/Release"
      local kl_node="$kl_build/keyboard-layout-manager.node"

      # Save the host-arch binary so we can restore it after cross-arch rebuilds.
      # Without this, the last rebuild leaves the wrong arch in place, breaking
      # require('keyboard-layout') for local dev/test after a parallel release.
      # Uses a trap so the restore happens even if the loop fails mid-way.
      local kl_host_backup
      kl_host_backup=$(mktemp)
      cp "$kl_node" "$kl_host_backup"
      trap '[[ -f "${kl_host_backup:-}" ]] && cp "${kl_host_backup}" "${kl_node}" 2>/dev/null; rm -f "${kl_host_backup:-}"; trap - RETURN' RETURN

      info "Pre-building keyboard-layout for macOS targets..."
      for target_arch in arm64 x64; do
        if should_build_arch "$target_arch"; then
          npx electron-rebuild -f -w keyboard-layout -a "$target_arch"
          mkdir -p "$cache_dir/$target_arch"
          cp "$kl_node" "$cache_dir/$target_arch/"
          echo "  cached keyboard-layout for $target_arch"
        fi
      done

      export NATIVE_MODULES_CACHE="$cache_dir"
      success "Native module cache ready"
    fi

    # All three platforms in parallel
    local pids=() logs=() names=()

    if should_build "mac"; then
      local mac_log; mac_log=$(mktemp)
      (phase_build_mac > "$mac_log" 2>&1) &
      pids+=($!); logs+=("$mac_log"); names+=("macOS")
    fi

    if should_build "windows"; then
      local win_log; win_log=$(mktemp)
      (phase_build_windows > "$win_log" 2>&1) &
      pids+=($!); logs+=("$win_log"); names+=("Windows")
    fi

    if should_build "linux" && should_build_arch "x64"; then
      local linux_x64_log; linux_x64_log=$(mktemp)
      (phase_build_linux_x64 > "$linux_x64_log" 2>&1) &
      pids+=($!); logs+=("$linux_x64_log"); names+=("Linux x64")
    fi

    if [[ ${#pids[@]} -gt 0 ]]; then
      info "Building ${names[*]} in parallel..."

      # Wait for all parallel jobs
      local statuses=()
      for pid in "${pids[@]}"; do
        local s=0
        wait "$pid" || s=$?
        statuses+=($s)
      done

      # Show output and collect failures
      local failures=()
      for i in "${!logs[@]}"; do
        cat "${logs[$i]}"
        rm -f "${logs[$i]}"
        if [[ ${statuses[$i]} -ne 0 ]]; then
          failures+=("${names[$i]}")
        fi
      done

      # macOS electron-builder rebuilds native modules for both arm64 and x64;
      # the last arch (x64) wins, leaving wrong-arch binaries on arm64 hosts.
      # Restore them so post-build phases (smoke test, etc.) work correctly, and
      # before failing so the next run's e2e tests don't load x64 binaries.
      # Linux arm64 builds against its own node_modules volume, so it can run after.
      if should_build "mac"; then
        info "Restoring host-arch native modules..."
        npx electron-rebuild -f -w node-pty,keyboard-layout,@parcel/watcher 2>&1 | tail -5
        local host_arch
        host_arch=$(uname -m | sed 's/x86_64/x64/')
        local host_rg_pkg="@vscode/ripgrep-darwin-${host_arch}"
        local host_rg_version
        host_rg_version=$(node -p "require('./node_modules/@vscode/ripgrep/package.json').optionalDependencies['$host_rg_pkg']")
        npm install --no-save --force --os=darwin --cpu="$host_arch" "${host_rg_pkg}@${host_rg_version}"
        success "Native modules restored for $(uname -m)"
      fi

      if [[ ${#failures[@]} -gt 0 ]]; then
        die "Build failed for: ${failures[*]}"
      fi
    fi

    # Linux arm64 runs after x64 (both mount the project dir into Docker)
    phase_build_linux_arm64
  else
    # Sequential builds
    phase_build_mac
    phase_build_windows
    phase_build_linux
  fi
}

# ---- parse arguments -------------------------------------------------------

BUMP=""
VERSION=""

# Check for subcommand
case "${1:-}" in
  build|upload|full)
    SUBCOMMAND="$1"
    shift
    ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platforms=*)
      parse_platforms "${1#*=}"
      shift
      ;;
    --archs=*)
      parse_archs "${1#*=}"
      shift
      ;;
    --skip-notarization)
      SKIP_NOTARIZATION=true
      shift
      ;;
    --skip-e2e)
      SKIP_E2E=true
      shift
      ;;
    --skip-vm-security)
      SKIP_VM_SECURITY=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE_REBUILD=true
      shift
      ;;
    --skip-verify)
      VERIFY_UPLOADS=false
      shift
      ;;
    --no-rollback)
      NO_ROLLBACK=true
      shift
      ;;
    --no-parallel)
      PARALLEL_BUILDS=false
      shift
      ;;
    --no-cleanup)
      NO_CLEANUP=true
      shift
      ;;
    --staging)
      STAGING=true
      shift
      ;;
    --resume-from=*)
      RESUME_FROM="${1#*=}"
      shift
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      if [[ -z "$BUMP" ]]; then
        BUMP="$1"
      else
        die "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

# Validate arguments based on subcommand
case "$SUBCOMMAND" in
  upload)
    # Upload requires explicit version (x.y.z format)
    [[ -n "$BUMP" ]] || die "upload subcommand requires version: npm run release -- upload 0.5.1"
    case "$BUMP" in
      [0-9]*.[0-9]*.[0-9]*) VERSION="$BUMP" ;;
      *) die "upload subcommand requires explicit version (x.y.z), not: $BUMP" ;;
    esac
    ;;
  build|full)
    [[ -n "$BUMP" ]] || die "usage: release.sh [build|upload|full] <patch|minor|major|x.y.z> [options]"
    case "$BUMP" in
      patch|minor|major) ;;
      [0-9]*.[0-9]*.[0-9]*) ;;
      *) die "invalid version argument: $BUMP (expected patch, minor, major, or x.y.z)" ;;
    esac
    ;;
esac

# Handle --resume-from
if [[ -n "$RESUME_FROM" ]]; then
  if [[ ! -f "$STATE_FILE" ]]; then
    die "No release state found — cannot resume without $STATE_FILE"
  fi
  VERSION=$(state_get_version)
  if [[ -z "$VERSION" ]]; then
    die "Could not determine version from state file"
  fi
  info "Resuming release v${VERSION} from phase: $RESUME_FROM"
fi

# ---- staging configuration -------------------------------------------------

if [[ "$STAGING" == "true" ]]; then
  UPLOAD_PREFIX="staging/latest"
  export KOMLA_ENV=staging
  # Staging builds skip macOS notarization (may trigger Gatekeeper warnings on first install)
  SKIP_NOTARIZATION=true
  # Staging builds skip upload verification
  VERIFY_UPLOADS=false
else
  UPLOAD_PREFIX="latest"
  export KOMLA_ENV=production
fi
# Marks the app as an official build, which telemetry counts apart from builds
# from source and which is the only kind that updates itself.
export KOMLA_DISTRIBUTION=official

# ---- show configuration ----------------------------------------------------

echo ""
echo "Release Configuration"
echo "---------------------"
echo "  Subcommand: $SUBCOMMAND"
echo "  Version: $BUMP"
echo "  Platforms: ${PLATFORMS[*]:-all}"
echo "  Archs: ${ARCHS[*]:-all}"
[[ "$STAGING" == "true" ]] && echo "  Staging: true (upload prefix: $UPLOAD_PREFIX)"
[[ "$SKIP_NOTARIZATION" == "true" ]] && echo "  Skip notarization: true"
[[ "$SKIP_E2E" == "true" ]] && echo "  Skip e2e: true"
[[ "$SKIP_VM_SECURITY" == "true" ]] && echo "  Skip vm-security: true"
[[ "$FORCE_REBUILD" == "true" ]] && echo "  Force rebuild: true"
[[ "$VERIFY_UPLOADS" != "true" ]] && echo "  Skip verify: true"
[[ "$PARALLEL_BUILDS" != "true" ]] && echo "  Parallel builds: false (sequential)"
[[ "$NO_CLEANUP" == "true" ]] && echo "  No cleanup: true"
[[ "$DRY_RUN" == "true" ]] && echo "  Dry run: true"
[[ -n "$RESUME_FROM" ]] && echo "  Resume from: $RESUME_FROM"
echo ""

# ---- dry run exit ----------------------------------------------------------

if [[ "$DRY_RUN" == "true" ]]; then
  phase_preflight
  echo "==> Dry run complete — all checks passed!"
  echo ""
  echo "  To perform the actual release, run without --dry-run:"
  echo "    npm run release -- $BUMP"
  echo ""
  exit 0
fi

# ---- main execution --------------------------------------------------------

# Always stop colima on exit if we started it
trap colima_stop_if_started EXIT

# Set up rollback trap (only for build/full subcommands that create commits)
if [[ "$SUBCOMMAND" != "upload" ]] && [[ -z "$RESUME_FROM" ]]; then
  trap_handler() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]] && [[ -n "${VERSION:-}" ]]; then
      if [[ -n "${CURRENT_PHASE:-}" ]]; then
        state_update "$CURRENT_PHASE" "failed" 0 "Exit code: $exit_code"
      fi
      notify "Komla Release" "Release v${VERSION} failed during ${CURRENT_PHASE:-unknown}"
      rollback "$VERSION"
    fi
    colima_stop_if_started
    exit $exit_code
  }
  trap trap_handler EXIT
fi

case "$SUBCOMMAND" in
  build)
    # Build only — no version bump, no upload
    if [[ -z "$RESUME_FROM" ]]; then
      phase_preflight

      # Get current version from package.json or bump it
      case "$BUMP" in
        patch|minor|major)
          npm version "$BUMP" --no-git-tag-version
          VERSION=$(node -p "require('./package.json').version")
          info "Version bumped to $VERSION (not committed — build only mode)"
          ;;
        *)
          VERSION="$BUMP"
          # Set version without committing
          npm version "$VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true
          info "Building version $VERSION"
          ;;
      esac
      state_init "$VERSION"
    fi

    if should_run_phase "test"; then
      run_phase "test" phase_test
    fi

    if should_run_phase "e2e"; then
      if [[ "$SKIP_E2E" != "true" ]]; then
        run_phase "e2e" phase_e2e
      else
        info "Skipping e2e phase (--skip-e2e)"
      fi
    fi

    if should_run_phase "vm-security"; then
      if [[ "$SKIP_VM_SECURITY" != "true" ]]; then
        run_phase "vm-security" phase_vm_security
      else
        info "Skipping vm-security phase (--skip-vm-security)"
      fi
    fi

    if should_run_phase "audit"; then
      run_phase "audit" phase_audit
    fi

    if should_run_phase "build"; then
      run_phase "build" build_all_platforms
    fi

    if should_run_phase "notarize"; then
      run_phase "notarize" phase_notarize
    fi

    if should_run_phase "package"; then
      run_phase "package" phase_package
    fi

    if should_run_phase "smoke-test"; then
      run_phase "smoke-test" phase_smoke_test
    fi

    colima_stop_if_started

    echo ""
    success "Build complete! Artifacts in $DIST_DIR/"
    echo ""
    echo "  To upload these artifacts:"
    echo "    npm run release -- upload $VERSION"
    echo ""
    notify "Komla Release" "Build complete for v${VERSION}"
    ;;

  upload)
    # Upload only — requires version, no building
    phase_preflight
    phase_upload
    phase_upload_manifests
    phase_verify

    echo ""
    success "Upload complete for v${VERSION}!"
    echo ""
    notify "Komla Release" "Upload complete for v${VERSION}"
    ;;

  full)
    # Full release — version bump, build, pause, upload + push on resume
    if should_run_phase "preflight"; then
      phase_preflight
    fi

    if should_run_phase "version" && [[ -z "$RESUME_FROM" ]]; then
      run_phase "version" phase_version
    elif [[ -z "$VERSION" ]]; then
      VERSION=$(node -p "require('./package.json').version")
    fi

    # Ensure state tracking is initialized even when the version phase was skipped
    if [[ -z "$RESUME_FROM" ]] && [[ ! -f "$STATE_FILE" ]]; then
      state_init "$VERSION"
    fi

    if should_run_phase "test"; then
      run_phase "test" phase_test
    fi

    if should_run_phase "e2e"; then
      if [[ "$SKIP_E2E" != "true" ]]; then
        run_phase "e2e" phase_e2e
      else
        info "Skipping e2e phase (--skip-e2e)"
      fi
    fi

    if should_run_phase "vm-security"; then
      if [[ "$SKIP_VM_SECURITY" != "true" ]]; then
        run_phase "vm-security" phase_vm_security
      else
        info "Skipping vm-security phase (--skip-vm-security)"
      fi
    fi

    if should_run_phase "audit"; then
      run_phase "audit" phase_audit
    fi

    if should_run_phase "build"; then
      run_phase "build" build_all_platforms
    fi

    if should_run_phase "notarize"; then
      run_phase "notarize" phase_notarize
    fi

    if should_run_phase "package"; then
      run_phase "package" phase_package
    fi

    if should_run_phase "smoke-test"; then
      run_phase "smoke-test" phase_smoke_test
    fi

    # Confirm before the point of no return
    if should_run_phase "upload"; then
      confirm_before_upload
      run_phase "upload" phase_upload
    fi

    if should_run_phase "upload-manifests"; then
      run_phase "upload-manifests" phase_upload_manifests
    fi

    if should_run_phase "verify"; then
      run_phase "verify" phase_verify
    fi

    if should_run_phase "publish" && [[ "$STAGING" != "true" ]]; then
      run_phase "publish" phase_publish
    elif [[ "$STAGING" == "true" ]]; then
      info "Skipping publish phase (staging release)"
    fi

    # Clean up state file on success
    state_cleanup

    # Clear the trap on success
    trap - EXIT

    # Stop colima if we started it
    colima_stop_if_started

    # Clean up old versions from R2 (non-fatal)
    if [[ "${NO_CLEANUP}" != "true" ]] && [[ "$STAGING" != "true" ]]; then
      phase_cleanup || warn "Artifact cleanup failed (non-fatal)"
    fi

    echo ""
    if [[ "$STAGING" == "true" ]]; then
      echo "==> Staging release v${VERSION} complete!"
    else
      echo "==> Release v${VERSION} complete!"
    fi
    echo ""
    echo "    Artifacts uploaded to R2 (prefix: ${UPLOAD_PREFIX}/):"
    if should_build "mac"; then
      mac_files=()
      should_build_arch "arm64" && mac_files+=("komla-${VERSION}-arm64.zip")
      should_build_arch "x64" && mac_files+=("komla-${VERSION}-x64.zip")
      echo "      - macOS: ${mac_files[*]}"
    fi
    if should_build "windows"; then
      win_files=()
      should_build_arch "x64" && win_files+=("komla-${VERSION}-x64-setup.zip")
      should_build_arch "arm64" && win_files+=("komla-${VERSION}-arm64-setup.zip")
      echo "      - Windows: ${win_files[*]} (+ .exe for auto-updater)"
    fi
    if should_build "linux"; then
      linux_files=()
      should_build_arch "x64" && linux_files+=("komla-${VERSION}-x86_64.AppImage")
      should_build_arch "arm64" && linux_files+=("komla-${VERSION}-arm64.AppImage")
      echo "      - Linux: ${linux_files[*]}"
    fi
    echo ""
    if [[ "$STAGING" == "true" ]]; then
      echo "    Download URLs:"
      echo "      https://downloads.komla.dev/${UPLOAD_PREFIX}/"
      echo ""
    fi
    if should_build "mac" && should_build_arch "arm64" && [[ "$SKIP_NOTARIZATION" != "true" ]]; then
      echo "    Verify notarization with:"
      echo "      spctl -a -vvv -t install dist/komla-${VERSION}-arm64.zip"
      echo ""
    fi
    notify "Komla Release" "v${VERSION} released successfully"
    ;;
esac
