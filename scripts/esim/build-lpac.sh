#!/usr/bin/env bash
set -euo pipefail
# Build only. Installation and device provisioning are separate administrator actions.
output=${1:?usage build-lpac.sh NEW_OUTPUT_DIRECTORY}
if [[ -e "$output" ]]; then echo 'Output directory already exists' >&2; exit 1; fi
mkdir -p "$output"
output=$(cd "$output" && pwd)
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pin=a43e46aef6f8b5b1d144bf3b3fc5999d8fcefacc
git clone https://github.com/estkme-group/lpac.git "$output/source"
git -C "$output/source" checkout --detach "$pin"
git -C "$output/source" submodule update --init --recursive
for patch in "$script_dir"/lpac-*.patch; do git -C "$output/source" apply "$patch"; done
cmake -S "$output/source" -B "$output/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/libexec/ceralive/lpac \
  -DBUILD_TESTING=ON -DLPAC_WITH_APDU_AT=ON \
  -DLPAC_WITH_APDU_PCSC=OFF -DLPAC_WITH_APDU_QMI=OFF -DLPAC_WITH_APDU_MBIM=OFF
cmake --build "$output/build" --parallel 2
ctest --test-dir "$output/build" --output-on-failure
DESTDIR="$output/stage" cmake --install "$output/build"
mv "$output/stage/usr/libexec/ceralive/lpac" "$output/install"
printf '%s\n' "$pin" > "$output/install/SOURCE_COMMIT"
cp "$script_dir"/lpac-*.patch "$output/install/"
find "$output/source" -maxdepth 1 -type f -iname 'LICENSE*' -exec cp '{}' "$output/install/" \;

cp -r "$output/source/LICENSES" "$output/install/"

mkdir -p "$output/install/component-notices"
(cd "$output/source" && find src driver euicc utils cjson-ext -name LICENSE -type f -exec cp --parents '{}' "$output/install/component-notices/" \;)
