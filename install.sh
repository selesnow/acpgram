#!/usr/bin/env bash
# AcpGram installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/selesnow/acpgram/main/install.sh | bash
#
# Installs (or updates) the latest release into ~/.local/share/acpgram, adds the `acpgram` command to ~/.local/bin,
# installs a private Node.js 24 if the system one is missing or older (official build from nodejs.org, checksum verified),
# then runs the setup wizard. Settings (.env) and data (data/) are kept on update.
#
# Environment: ACPGRAM_HOME   install dir          (default ~/.local/share/acpgram)
#              ACPGRAM_BIN    dir for the command  (default ~/.local/bin)
#              ACPGRAM_VERSION release tag, e.g. v1.10.0 (default: latest)
#              ACPGRAM_RELEASE_URL where to download the release from (mirror or local test; default GitHub Releases)
#              ACPGRAM_NO_SETUP=1  do not run the setup wizard
#              ACPGRAM_YES=1       answer "yes" to questions (non-interactive)
#
# The whole script is a function called on the last line: if the download is cut short, nothing runs at all.

main() {
  set -euo pipefail

  local REPO="selesnow/acpgram"
  local NODE_MAJOR=24
  local APP_HOME="${ACPGRAM_HOME:-$HOME/.local/share/acpgram}"
  local BIN_DIR="${ACPGRAM_BIN:-$HOME/.local/bin}"
  case "$APP_HOME" in /*) ;; *) die "ACPGRAM_HOME must be an absolute path: $APP_HOME" ;; esac
  case "$BIN_DIR" in /*) ;; *) die "ACPGRAM_BIN must be an absolute path: $BIN_DIR" ;; esac

  need curl
  need tar
  need awk
  if command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SHA256="shasum -a 256"; else die "sha256sum or shasum is required"; fi

  local OS ARCH
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "unsupported OS $(uname -s): use install.ps1 on Windows" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "unsupported CPU architecture $(uname -m)" ;;
  esac

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$APP_HOME"

  # ---------- Node.js ----------
  local NODE=""
  if command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge "$NODE_MAJOR" ]; then
    NODE="$(command -v node)"
  elif [ -x "$APP_HOME/node/bin/node" ] && [ "$(node_major "$APP_HOME/node/bin/node")" -ge "$NODE_MAJOR" ]; then
    NODE="$APP_HOME/node/bin/node"
  fi
  if [ -z "$NODE" ]; then
    step "Node.js $NODE_MAJOR+ is required$(command -v node >/dev/null 2>&1 && printf ' (found %s)' "$(node -v)")"
    ask_yes "Install a private Node.js $NODE_MAJOR for AcpGram into $APP_HOME/node (no sudo)?" || die "install Node.js $NODE_MAJOR+ and run the installer again (or set ACPGRAM_YES=1)"
    local BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" FILE
    curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    FILE="$(grep -oE "node-v[0-9.]+-${OS}-${ARCH}\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n1 || true)"
    [ -n "$FILE" ] || die "no Node.js $NODE_MAJOR build for $OS-$ARCH"
    say "Downloading $FILE"
    curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
    verify "$TMP" "$FILE" SHASUMS256.txt || die "Node.js checksum mismatch"
    # unpack next to the old one (same file system), then swap - the old Node stays until the new one is ready
    rm -rf "$APP_HOME/.node-new"
    mkdir -p "$APP_HOME/.node-new"
    tar -xzf "$TMP/$FILE" -C "$APP_HOME/.node-new" --strip-components=1
    rm -rf "$APP_HOME/node"
    mv "$APP_HOME/.node-new" "$APP_HOME/node"
    NODE="$APP_HOME/node/bin/node"
  fi
  say "Node.js $("$NODE" -v): $NODE"

  # ---------- release ----------
  local TAG
  if [ -n "${ACPGRAM_VERSION:-}" ]; then
    TAG="$ACPGRAM_VERSION"
  else
    # the redirect of /releases/latest points to /releases/tag/<tag> (no API rate limits)
    TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed -E 's#.*/tag/##')"
  fi
  case "$TAG" in v[0-9]*) ;; *) die "could not find the release ($TAG)" ;; esac
  step "Installing AcpGram $TAG into $APP_HOME"
  local ARCHIVE="acpgram-$TAG.tar.gz"
  local URL="${ACPGRAM_RELEASE_URL:-https://github.com/$REPO/releases/download/$TAG}"
  curl -fsSL "$URL/$ARCHIVE" -o "$TMP/$ARCHIVE" || die "release $TAG not found"
  curl -fsSL "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
  verify "$TMP" "$ARCHIVE" SHA256SUMS || die "release checksum mismatch"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
  [ -f "$TMP/acpgram/src/main.mjs" ] || die "unexpected archive layout"

  local UPDATE=0
  [ -f "$APP_HOME/src/main.mjs" ] && UPDATE=1
  # new files are staged on the same file system and moved into place one by one;
  # settings (.env), data (data/) and the private Node.js are not in the archive and stay untouched
  rm -rf "$APP_HOME/.incoming"
  mkdir -p "$APP_HOME/.incoming"
  (cd "$TMP/acpgram" && tar -cf - .) | (cd "$APP_HOME/.incoming" && tar -xf -)
  local item name
  for item in "$APP_HOME/.incoming"/* "$APP_HOME/.incoming"/.[!.]*; do
    [ -e "$item" ] || continue
    name="$(basename "$item")"
    case "$name" in .env | data | node) continue ;; esac
    rm -rf "${APP_HOME:?}/$name"
    mv "$item" "$APP_HOME/$name"
  done
  rm -rf "$APP_HOME/.incoming"

  # ---------- the acpgram command ----------
  mkdir -p "$BIN_DIR"
  # the command remembers where AcpGram lives - `acpgram update` updates this very installation
  cat > "$BIN_DIR/acpgram.new" <<EOF
#!/bin/sh
# AcpGram command (created by install.sh)
ACPGRAM_HOME='$APP_HOME' ACPGRAM_BIN='$BIN_DIR' exec '$NODE' --disable-warning=ExperimentalWarning '$APP_HOME/src/cli.mjs' "\$@"
EOF
  chmod +x "$BIN_DIR/acpgram.new"
  mv "$BIN_DIR/acpgram.new" "$BIN_DIR/acpgram"
  say "Command: $BIN_DIR/acpgram"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      local LINE="export PATH=\"$BIN_DIR:\$PATH\"" rc
      # ~/.profile - sh and bash logins; ~/.zshrc - zsh (the macOS default shell does not read ~/.profile)
      local files=("$HOME/.profile")
      [ -f "$HOME/.bashrc" ] && files+=("$HOME/.bashrc")
      [ -f "$HOME/.bash_profile" ] && files+=("$HOME/.bash_profile")
      if [ -f "$HOME/.zshrc" ] || [ "$OS" = darwin ] || [ "${SHELL##*/}" = zsh ]; then files+=("$HOME/.zshrc"); fi
      for rc in "${files[@]}"; do
        grep -qsF "$LINE" "$rc" || printf '\n# AcpGram\n%s\n' "$LINE" >> "$rc"
      done
      say "Added $BIN_DIR to PATH (open a new terminal to use 'acpgram')"
      ;;
  esac

  # ---------- setup / restart ----------
  if [ "$UPDATE" = 1 ]; then
    step "Updated to $TAG"
    if [ "$OS" = linux ] && systemctl --user cat acpgram >/dev/null 2>&1; then
      systemctl --user restart acpgram && say "Service acpgram restarted"
    elif [ "$OS" = darwin ] && launchctl print "gui/$(id -u)/io.github.acpgram" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/io.github.acpgram" && say "Service io.github.acpgram restarted"
    fi
  fi
  if [ ! -f "$APP_HOME/.env" ] && [ "${ACPGRAM_NO_SETUP:-}" != 1 ]; then
    if has_tty; then
      step "Setup"
      "$NODE" --disable-warning=ExperimentalWarning "$APP_HOME/src/setup.mjs" < /dev/tty || say "Setup did not finish: run 'acpgram setup' later"
    else
      say "No terminal: run 'acpgram setup' to configure the bot"
    fi
  fi

  step "Done"
  say "  acpgram          start the bot"
  say "  acpgram setup    settings wizard"
  say "  acpgram service install | status | uninstall"
  say "  acpgram update   update to the latest release"
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }
node_major() { "$1" -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0; }

# a terminal really exists only if /dev/tty can be opened (its permission bits are rw for everyone even without one)
has_tty() { { : < /dev/tty; } 2>/dev/null; }

# questions go to the terminal: with `curl | bash` stdin is the script itself; no terminal means "no"
ask_yes() {
  [ "${ACPGRAM_YES:-}" = 1 ] && return 0
  has_tty || return 1
  printf '%s [Y/n]: ' "$1" > /dev/tty
  local a=''
  read -r a < /dev/tty || true
  case "$a" in n | N | no | No | NO) return 1 ;; esac
  return 0
}

# checks file $2 in dir $1 against the checksum list $3 (formats "hash  name" and "hash *name"); no entry = failure
verify() {
  (cd "$1" && awk -v f="$2" '{ n = $2; sub(/^\*/, "", n); if (n == f) print $1 "  " f }' "$3" | grep . | $SHA256 -c - >/dev/null 2>&1)
}

main "$@"
