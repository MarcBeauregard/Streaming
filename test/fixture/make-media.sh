#!/usr/bin/env bash
# Generates a small three-quality HLS stream used by the fixture site.
set -euo pipefail
out="$(dirname "$0")/media"
rm -rf "$out" && mkdir -p "$out"
for spec in "240:300k" "480:900k" "720:2000k"; do
  h="${spec%%:*}"; rate="${spec##*:}"
  mkdir -p "$out/$h"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=44100" \
    -t 24 -vf "scale=-2:$h,drawtext=text='${h}p':fontsize=h/4:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=(h-th)/2" \
    -c:v libx264 -preset veryfast -profile:v main -b:v "$rate" -g 60 -keyint_min 60 -sc_threshold 0 \
    -c:a aac -b:a 64k -ac 2 \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "$out/$h/seg%03d.ts" "$out/$h/index.m3u8"
done
cat > "$out/master.m3u8" <<'M3U'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240,FRAME-RATE=30.000,CODECS="avc1.4d4015,mp4a.40.2"
240/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1100000,RESOLUTION=854x480,FRAME-RATE=30.000,CODECS="avc1.4d401f,mp4a.40.2"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2300000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
M3U
echo "Média de test généré dans $out"
