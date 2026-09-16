# Convert

A lightweight local web app for converting almost any file, plus a PDF merge/arrange tool. A small Node server hands files to proven command-line converters (ImageMagick, ffmpeg, Ghostscript, pandoc, LibreOffice). No build step, no accounts, and nothing leaves your machine.

## What it does

- **Convert**: drop any number of files and pick an output format for each (or set them all at once).
  - **Images** (jpg, png, webp, gif, heic, avif, svg, psd, tiff, RAW…) → jpg, png, webp, gif, bmp, tiff, avif, ico, pdf
  - **PDF** → png / jpg (one file per page), txt, docx
  - **Audio** (mp3, wav, flac, aac, m4a, ogg, opus…) → any of those
  - **Video** (mp4, mov, mkv, webm, avi…) → mp4, mov, mkv, webm, avi, gif, or audio only (mp3, wav, m4a)
  - **Office** (doc/docx, xls/xlsx, ppt/pptx, odt, Pages, Numbers, Keynote…) → pdf and other office formats
  - **Text/markup** (md, html, epub, rst, org, tex, ipynb…) → pdf, docx, odt, html, md, txt, epub
  - "Combine images into one PDF" when several images are queued
  - Download files individually, all at once, or as a .zip
- **Merge & arrange PDF**: drop PDFs, images or documents and every page shows up as a thumbnail. Drag to reorder, rotate, delete, then download the merged PDF or only the selected pages. Merging happens in the browser.

If a converter isn't installed, its formats are marked unavailable instead of failing. Check `http://localhost:3000/health` to see what was found.

## Setup

Requires [Node.js](https://nodejs.org) 18+ and `zip`.

**macOS**
```bash
brew install ffmpeg imagemagick libheif ghostscript pandoc
brew install --cask libreoffice
```

**Debian / Ubuntu**
```bash
sudo apt install ffmpeg imagemagick libheif-examples ghostscript pandoc libreoffice zip
```

Then:
```bash
git clone https://github.com/<your-username>/converter.git
cd converter
npm install
npm start   # http://localhost:3000
```

Use a different port with `PORT=4000 npm start`. The server only listens on `127.0.0.1`. Converted files are kept in your OS temp directory for 30 minutes and then deleted.

## Terminal shortcut

Add this to your `~/.zshrc` (or `~/.bashrc`) so typing `converter` starts the server in that terminal and opens the site. Press Ctrl+C to stop it.

```zsh
# Path to your clone of this repo
export CONVERTER_DIR="$HOME/path/to/converter"

converter() {
  local port="${PORT:-3000}"
  local url="http://localhost:$port"
  local opener
  if command -v open >/dev/null 2>&1; then opener=open; else opener=xdg-open; fi

  if [ ! -f "$CONVERTER_DIR/server.js" ]; then
    echo "converter: set CONVERTER_DIR to your clone of the repo (currently '$CONVERTER_DIR')"
    return 1
  fi
  if [ ! -d "$CONVERTER_DIR/node_modules" ]; then
    (cd "$CONVERTER_DIR" && npm install) || return 1
  fi
  if curl -s -o /dev/null "$url"; then
    echo "Something is already running on port $port; opening $url"
    "$opener" "$url" >/dev/null 2>&1
    return
  fi

  # Open the browser once the server answers (gives up after ~10s).
  ( (for _ in $(seq 100); do
      curl -s -o /dev/null "$url" && { "$opener" "$url"; exit; }
      sleep 0.1
    done) >/dev/null 2>&1 & )

  (cd "$CONVERTER_DIR" && PORT="$port" exec node server.js)
}
```

Reload your shell with `source ~/.zshrc`, then run `converter` (or `PORT=4000 converter`).

## Adding formats

All format routing lives in [`converters.js`](converters.js). Each category lists its input extensions, its output targets and a `run()` function that calls a command-line tool. The frontend picks up changes automatically through `/formats`.
