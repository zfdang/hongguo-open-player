# ByteVC2 decoder

The patch is from https://github.com/wxyzh/ffmpeg-bvc2 at commit
`04f87d26d67162c0f73c3d9bd1870fd5900f3aee`, originally adapted from
librempeg by Paul B Mahol. It applies to jellyfin-ffmpeg commit
`f6e945886e17c2cf882143bd98222b1bd66ffe28`. The resulting FFmpeg build
is GPL version 3 or later. Its source and build instructions are available
from the linked repositories and `scripts/build-bytevc2.sh`. The script also
pins x264 source from https://github.com/mirror/x264 and builds it statically.
In a development checkout, run `bash scripts/build-bytevc2.sh` on the target
platform before starting Electron or packaging the application.
