#!/usr/bin/env bash
# Renders the PNG icons from the SVG sources in public/icons.
# Needs rsvg-convert. On macOS: brew install librsvg
set -euo pipefail

cd "$(dirname "$0")/../public/icons"

render() {
    local source=$1 size=$2 output=$3
    rsvg-convert --width "$size" --height "$size" "${@:4}" "$source" --output "$output"
}

render icon.svg 192 icon-192.png
render icon.svg 512 icon-512.png
render icon-maskable.svg 192 maskable-192.png
render icon-maskable.svg 512 maskable-512.png
# iOS shows transparent pixels as black, so the corners get the background colour.
render icon.svg 180 apple-touch-icon.png --background-color '#22201c'

ls -l ./*.png
