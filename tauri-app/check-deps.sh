#!/usr/bin/env bash
# check-deps.sh — verify the system libraries Tauri needs before building.
# Usage:  ./check-deps.sh          (run it from tauri-app/)
set -u

HAVE_PKGCONFIG=1
command -v pkg-config >/dev/null 2>&1 || HAVE_PKGCONFIG=0

REQUIRED="glib-2.0 gobject-2.0 gio-2.0 gdk-3.0 gtk+-3.0 gdk-pixbuf-2.0 pango webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 openssl librsvg-2.0"
WARN_ONLY="ayatana-appindicator3-0.1 xdo"

fail=0

if [ "$HAVE_PKGCONFIG" -eq 0 ]; then
  echo "✘ pkg-config is not installed (on Debian/Ubuntu: sudo apt install pkg-config)"
  fail=1
else
  echo "Required libraries:"
  for pkg in $REQUIRED; do
    if pkg-config --exists "$pkg"; then
      printf '  ✔ %-24s %s\n' "$pkg" "$(pkg-config --modversion "$pkg")"
    else
      printf '  ✘ %-24s MISSING\n' "$pkg"
      fail=1
    fi
  done
  echo "Optional (tray / xdotool features):"
  for pkg in $WARN_ONLY; do
    if pkg-config --exists "$pkg"; then
      printf '  ✔ %-24s %s\n' "$pkg" "$(pkg-config --modversion "$pkg")"
    else
      printf '  – %-24s not found (ok for a basic build)\n' "$pkg"
    fi
  done
fi

if [ "$fail" -eq 0 ]; then
  echo ""
  echo "All good — run: npm run tauri dev"
  exit 0
fi

echo ""
echo "Fix — install the Tauri system dependencies for your distro:"
# Best-effort distro detection from /etc/os-release
id=""; like=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  id="${ID:-}"; like="${ID_LIKE:-}"
fi

case "$id" in
  debian|ubuntu|linuxmint|pop|neon|zorin|kali|raspbian)
    echo "  sudo apt update && sudo apt install \\"
    echo "    libwebkit2gtk-4.1-dev build-essential curl wget file \\"
    echo "    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config"
    echo ""
    echo "  (libwebkit2gtk-4.1-dev pulls in libgtk-3-dev, which provides gdk-3.0)"
    ;;
  fedora|rhel|centos|rocky|alma|nobara|silverblue|kinoite)
    echo "  sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \\"
    echo "    libappindicator-gtk3-devel librsvg2-devel libxdo-devel"
    echo "  sudo dnf group install \"c-development\""
    echo "  (on atomic/silverblue use: sudo rpm-ostree install … + reboot)"
    ;;
  arch|manjaro|endeavouros|garuda|artix|cachyos)
    echo "  sudo pacman -Syu --needed webkit2gtk-4.1 base-devel curl wget file \\"
    echo "    openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool"
    ;;
  opensuse*|suse)
    echo "  sudo zypper in webkit2gtk3-devel libopenssl-devel curl wget file \\"
    echo "    libappindicator3-1 librsvg-devel"
    echo "  sudo zypper in -t pattern devel_basis"
    ;;
  alpine)
    echo "  sudo apk add build-base webkit2gtk-4.1-dev curl wget file openssl \\"
    echo "    libayatana-appindicator-dev librsvg"
    ;;
  gentoo)
    echo "  sudo emerge --ask net-libs/webkit-gtk:4.1 dev-libs/libayatana-appindicator \\"
    echo "    net-misc/curl net-misc/wget sys-apps/file"
    ;;
  *)
    if echo "$like" | grep -qiE 'debian|ubuntu'; then
      echo "  (debian-family guess) sudo apt install libwebkit2gtk-4.1-dev build-essential \\"
      echo "    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config"
    elif echo "$like" | grep -qiE 'fedora|rhel'; then
      echo "  (rpm-family guess) sudo dnf install webkit2gtk4.1-devel openssl-devel librsvg2-devel \\"
      echo "    libappindicator-gtk3-devel libxdo-devel && sudo dnf group install \"c-development\""
    elif echo "$like" | grep -qi 'arch'; then
      echo "  (arch-family guess) sudo pacman -S --needed webkit2gtk-4.1 base-devel librsvg xdotool"
    else
      echo "  Unknown distro — see https://tauri.app/start/prerequisites/"
    fi
    ;;
esac

exit 1
