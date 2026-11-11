#!/usr/bin/env bash
# Copies the shared libraries, NSS modules and fonts Chromium headless shell needs out of the
# Playwright image, for hosts without system Chromium libraries (Arch Linux ARM bench host).
set -euo pipefail
image="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.60.0-noble}"
out="${1:-$HOME/.cache/test-select-bench/chromium-libs}"
mkdir -p "$out"
docker run --rm -v "$out:/out" "$image" bash -c '
  set -euo pipefail
  shell=$(find /ms-playwright -name headless_shell -type f | head -1)
  ldd "$shell" | awk "/=> \\//{print \$3}" | grep -Ev "/(libc|libm|libdl|libpthread|librt|libresolv|ld-linux[^/]*)\.so" | xargs -I{} cp -L {} /out/
  cp -L /usr/lib/*-linux-gnu/nss/*.so /out/ 2>/dev/null || true
  cp -L /usr/lib/*-linux-gnu/libsoftokn3.so /usr/lib/*-linux-gnu/libfreeblpriv3.so /usr/lib/*-linux-gnu/libnssckbi.so /out/ 2>/dev/null || true
  mkdir -p /out/fonts
  cp -rL /usr/share/fonts/. /out/fonts/
  chown -R '"$(id -u):$(id -g)"' /out
'
for lib in "$out"/*.so*; do
  name=$(basename "$lib")
  if ldconfig -p | grep -qE "^\s+$name \("; then rm "$lib"; fi
done
cat > "$out/fonts.conf" <<CONF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$out/fonts</dir>
  <cachedir>$out/fontcache</cachedir>
</fontconfig>
CONF
echo "$out"
