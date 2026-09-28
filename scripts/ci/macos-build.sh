#!/usr/bin/env bash
# Build the universal macOS app. Signs with a Developer ID certificate and
# notarizes when the Apple secrets are present; otherwise builds ad-hoc signed
# (runs locally, but Gatekeeper blocks it when downloaded).
#
# Inputs (all optional, from GitHub secrets):
#   APPLE_CERTIFICATE           base64 of the "Developer ID Application" .p12
#   APPLE_CERTIFICATE_PASSWORD  password of that .p12
#   APPLE_SIGNING_IDENTITY      e.g. "Developer ID Application: Jane Doe (TEAMID1234)"
# Notarization, either an App Store Connect API key (recommended):
#   APPLE_API_ISSUER, APPLE_API_KEY (key id), APPLE_API_KEY_P8 (contents of AuthKey_<id>.p8)
# or an Apple ID:
#   APPLE_ID, APPLE_PASSWORD (app-specific password), APPLE_TEAM_ID
# In-app updates (see README > In-app updates):
#   TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD
set -euo pipefail

TARGET=universal-apple-darwin
BUNDLE="target/$TARGET/release/bundle"
APP="$BUNDLE/macos/Fast Reviewer.app"
OUT="${OUT_DIR:-out}"

# GitHub passes unset secrets as empty strings; the Tauri bundler treats a
# set-but-empty variable as configured, so drop the empty ones.
for v in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY \
         APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_P8 APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
         TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  if [ -z "${!v:-}" ]; then unset "$v"; fi
done

# The updater only offers a release whose version is higher than the running
# app's, so every CI build gets its own increasing version: a v* tag's version,
# else <major>.<minor> from tauri.conf.json and the CI run number.
conf() { node -p "require('./src-tauri/tauri.conf.json').$1"; }
BASE_VERSION="$(conf version)"
if [ "${GITHUB_REF_TYPE:-}" = tag ] && [[ "${GITHUB_REF_NAME:-}" == v* ]]; then
  VERSION="${GITHUB_REF_NAME#v}"
elif [ -n "${GITHUB_RUN_NUMBER:-}" ]; then
  VERSION="${BASE_VERSION%.*}.$GITHUB_RUN_NUMBER"
else
  VERSION="$BASE_VERSION"
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::'$VERSION' is not a semver version (tags must look like v1.2.3)"
  exit 1
fi
echo "Version: $VERSION"

# Updater artifacts: the .app as a .tar.gz, signed with the updater key.
updater=0
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if [ -z "$(conf plugins.updater.pubkey)" ]; then
    echo "::error::TAURI_SIGNING_PRIVATE_KEY is set but plugins.updater.pubkey in src-tauri/tauri.conf.json is empty. See README > In-app updates."
    exit 1
  fi
  updater=1
else
  echo "::warning::No updater signing key: installed apps won't be offered this build. See README > In-app updates."
fi

signed=0
notary=()
if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  signed=1
  # Import the certificate into a throwaway keychain that codesign can find.
  KEYCHAIN="$RUNNER_TEMP/signing.keychain-db"
  KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"
  echo "$APPLE_CERTIFICATE" | base64 --decode > "$RUNNER_TEMP/cert.p12"
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security import "$RUNNER_TEMP/cert.p12" -k "$KEYCHAIN" -P "${APPLE_CERTIFICATE_PASSWORD:-}" \
    -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  rm -f "$RUNNER_TEMP/cert.p12"
  # The keychain now holds the identity; Tauri only needs its name.
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "$APPLE_SIGNING_IDENTITY" || {
    echo "::error::Signing identity '$APPLE_SIGNING_IDENTITY' not found in the imported certificate"
    security find-identity -v -p codesigning "$KEYCHAIN"
    exit 1
  }

  if [ -n "${APPLE_API_KEY_P8:-}" ] && [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    export APPLE_API_KEY_PATH="$RUNNER_TEMP/AuthKey_$APPLE_API_KEY.p8"
    printf '%s\n' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY_PATH"
    unset APPLE_API_KEY_P8
    notary=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    notary=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else
    echo "::warning::No notarization credentials: the app is signed but not notarized, so Gatekeeper will still block it."
  fi
else
  echo "::warning::No Apple signing secrets: building ad-hoc signed. See README > Code signing."
fi

# Build-time overrides of tauri.conf.json.
CONFIG="$(node -e '
  const [version, signed, updater] = process.argv.slice(1);
  const bundle = { createUpdaterArtifacts: updater === "1" };
  if (signed !== "1") bundle.macOS = { signingIdentity: "-" };
  console.log(JSON.stringify({ version, bundle }));
' "$VERSION" "$signed" "$updater")"
# When signed, Tauri signs with the hardened runtime and, given API-key or Apple-ID env
# vars, notarizes and staples the .app before packing it for the updater.
pnpm tauri build --target "$TARGET" --bundles app,dmg --config "$CONFIG"

DMG="$(ls "$BUNDLE"/dmg/*.dmg)"
if [ "$signed" = 1 ]; then
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG"
  if [ ${#notary[@]} -gt 0 ]; then
    xcrun notarytool submit "$DMG" "${notary[@]}" --wait --timeout 30m
    xcrun stapler staple "$DMG"
    # Fail the build if Gatekeeper would still reject what we ship.
    xcrun stapler validate "$APP"
    xcrun stapler validate "$DMG"
    spctl --assess --type execute -vv "$APP"
    spctl --assess --type open --context context:primary-signature -vv "$DMG"
  fi
  codesign --verify --deep --strict -vv "$APP"
fi

# Step outputs for the release job (only notarized builds are published).
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "version=$VERSION" >> "$GITHUB_OUTPUT"
  if [ "$signed" = 1 ] && [ ${#notary[@]} -gt 0 ]; then
    echo "notarized=true" >> "$GITHUB_OUTPUT"
  fi
fi

mkdir -p "$OUT"
cp "$DMG" "$OUT/"
# Zip the .app too (ditto keeps symlinks, signature and stapled ticket).
ditto -c -k --keepParent "$APP" "$OUT/Fast-Reviewer-macOS-universal.app.zip"
if [ "$updater" = 1 ]; then
  # What the in-app updater downloads; the release job lists it in latest.json.
  cp "$APP.tar.gz" "$OUT/Fast-Reviewer-macOS-universal.app.tar.gz"
  cp "$APP.tar.gz.sig" "$OUT/Fast-Reviewer-macOS-universal.app.tar.gz.sig"
fi
ls -la "$OUT"
