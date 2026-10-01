#!/bin/sh
# Print packaging/aur/PKGBUILD for a release: VERSION SOURCE_URL SHA256.
set -eu
version=$1 url=$2 sum=$3
sed -e "s|^pkgver=.*|pkgver=$version|" -e 's|^pkgrel=.*|pkgrel=1|' \
    -e "s|^source=(.*|source=(\"$url\")|" -e "s|^sha256sums=(.*|sha256sums=('$sum')|" \
    packaging/aur/PKGBUILD
