#!/usr/bin/env bash
# Generates the small test streams used by the fixture site:
# a three-quality HLS stream and a three-quality DASH stream.
set -euo pipefail
out="$(dirname "$0")/media"
rm -rf "$out" && mkdir -p "$out"
src=(-f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 24)
label() { echo "drawtext=text='$1':fontsize=h/5:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=(h-th)/2"; }

for spec in "240:300k" "480:900k" "720:2000k"; do
  h="${spec%%:*}"; rate="${spec##*:}"
  mkdir -p "$out/$h"
  ffmpeg -hide_banner -loglevel error -y "${src[@]}" \
    -vf "scale=-2:$h,$(label "${h}p")" \
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

mkdir -p "$out/dash"
ffmpeg -hide_banner -loglevel error -y "${src[@]}" \
  -filter_complex "[0:v]split=3[a][b][c];[a]scale=-2:240,$(label "DASH 240p")[v0];[b]scale=-2:480,$(label "DASH 480p")[v1];[c]scale=-2:720,$(label "DASH 720p")[v2]" \
  -map "[v0]" -map "[v1]" -map "[v2]" -map 1:a \
  -c:v libx264 -preset veryfast -profile:v main -g 60 -keyint_min 60 -sc_threshold 0 \
  -b:v:0 300k -b:v:1 900k -b:v:2 2000k -c:a aac -b:a 64k -ac 2 \
  -f dash -seg_duration 2 -use_template 1 -use_timeline 0 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" "$out/dash/manifest.mpd"
echo "Média de test généré dans $out"
