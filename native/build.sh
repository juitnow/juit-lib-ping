#!/bin/sh -xe

CURRENT_DIR="$(pwd)"
cd "$(dirname "${0}")"

if test "$(uname -s)" = "Darwin" ; then
  "../node_modules/.bin/node-gyp" rebuild -arch=arm64
  "../node_modules/.bin/node-gyp" rebuild -arch=x86_64
else
  "../node_modules/.bin/node-gyp" rebuild
fi

cd "${CURRENT_DIR}"
