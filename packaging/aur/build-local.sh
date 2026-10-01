#!/bin/sh
# Test-build the package from this working tree instead of the GitHub release
# tarball: `git archive` of the tracked files (including uncommitted changes to
# them) is named like the PKGBUILD source, so makepkg uses it without fetching.
#   packaging/aur/build-local.sh [makepkg options]
# OUT=<dir> selects the build directory (default: a new temporary directory).
# Nothing is installed; inspect the result with `pacman -Qlp <pkg>`.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
out=${OUT:-$(mktemp -d)}
pkgname=$(sed -n 's/^pkgname=//p' "$here/PKGBUILD")
pkgver=$(sed -n 's/^pkgver=//p' "$here/PKGBUILD")
tree=$(git -C "$repo" stash create)
git -C "$repo" archive --format=tar.gz --prefix="$pkgname-$pkgver/" \
  -o "$out/$pkgname-$pkgver.tar.gz" "${tree:-HEAD}"
cp "$here/PKGBUILD" "$here/$pkgname.install" "$out/"
cd "$out"
makepkg --force --cleanbuild "$@"
echo "Built in $out"
