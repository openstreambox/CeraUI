#!/bin/sh
# Build the pinned translator in a caller-owned, disposable scratch directory.
set -eu
kit=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$#" = 2 ] || { echo 'usage: build-translator.sh scratch-dir amd64|arm64' >&2; exit 2; }
mkdir -p "$1"
cd "$1"
case "$2" in
  amd64) cc=${CC:-gcc}; strip=${STRIP:-strip}; host='' ;;
  arm64) cc=${CC:-aarch64-linux-gnu-gcc}; strip=${STRIP:-aarch64-linux-gnu-strip}; host='--host=aarch64-linux-gnu' ;;
  *) exit 2 ;;
esac
curl --fail --silent --show-error --proto '=https' --location --remote-name https://ports.ubuntu.com/ubuntu-ports/pool/universe/t/tayga/tayga_0.9.2.orig.tar.bz2
printf '%s\n' '2b1f7927a9d2dcff9095aff3c271924b052ccfd2faca9588b277431a44f0009c  tayga_0.9.2.orig.tar.bz2' | sha256sum -c -
[ ! -e tayga-0.9.2 ]
tar xf tayga_0.9.2.orig.tar.bz2
cd tayga-0.9.2
patch -p1 < "$kit/tayga-udp-zero.diff"
CC="$cc" CFLAGS='-O2' LDFLAGS='-static' ./configure $host --prefix=/usr
# The upstream makefile overrides configure's CFLAGS with debug flags.
make -j2 CFLAGS='-O2 -g0' LDFLAGS='-static'
"$strip" --strip-all tayga
cd ..
mkdir -p output
cp tayga-0.9.2/tayga output/tayga
cp tayga-0.9.2/COPYING output/COPYING
(cd output && sha256sum tayga COPYING > SHA256SUMS)
