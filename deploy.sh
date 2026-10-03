#!/usr/bin/env bash
# Nasadenie na maraton.ixy.sk (Caddy na webs.ixy.sk, ~/static/maraton → /srv/maraton)
set -euo pipefail
cd "$(dirname "$0")"
KEY=$(tr -d '\n' < .apikey)
BUILD=$(date +%Y%m%d%H%M%S)
TMP=$(mktemp -d)
sed "s/__API_KEY__/$KEY/" index.html > "$TMP/index.html"
sed "s/__BUILD__/$BUILD/" sw.js > "$TMP/sw.js"
cp route.json manifest.webmanifest "$TMP/"
cp -R icons "$TMP/"
ssh webs.ixy.sk 'mkdir -p ~/static/maraton/icons'
scp -q -r "$TMP"/* webs.ixy.sk:~/static/maraton/
rm -rf "$TMP"
echo "Nasadené: https://maraton.ixy.sk (build $BUILD)"
