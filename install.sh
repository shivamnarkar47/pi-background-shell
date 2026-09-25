#!/usr/bin/env sh
# Installs the pi-background-shell extension into pi's agent extensions directory.
#
#   curl -fsSL https://raw.githubusercontent.com/shivamnarkar47/pi-background-shell/main/install.sh | sh
#
# Optional: pass the extensions directory as the first argument.
set -eu

FILE="background-shell.ts"
DIR="${1:-$HOME/.pi/agent/extensions}"
URL="https://raw.githubusercontent.com/shivamnarkar47/pi-background-shell/main/$FILE"

if ! command -v curl >/dev/null 2>&1; then
	echo "pi-background-shell: curl is required" >&2
	exit 1
fi

mkdir -p "$DIR"
if ! curl -fsSL "$URL" -o "$DIR/$FILE"; then
	echo "pi-background-shell: download failed" >&2
	exit 1
fi

echo "Installed $DIR/$FILE"
echo "Restart pi or run /reload to activate it."
