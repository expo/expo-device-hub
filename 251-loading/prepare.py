#!/usr/bin/env python3
"""Run only after recording captures finish: prepare a same-packet MP4 layout control."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def boxes(path):
    result = []
    total = path.stat().st_size
    with path.open('rb') as source:
        offset = 0
        while offset < total:
            source.seek(offset)
            header = source.read(8)
            if len(header) != 8:
                raise ValueError('Incomplete MP4 box header')
            size = int.from_bytes(header[:4], 'big')
            kind = header[4:].decode('ascii', errors='replace')
            if size == 1:
                size = int.from_bytes(source.read(8), 'big')
            elif size == 0:
                size = total - offset
            if size < 8 or offset + size > total:
                raise ValueError('Invalid MP4 box size')
            result.append({'type': kind, 'offset': offset, 'size': size})
            offset += size
    return result


def probe(path):
    command = ['ffprobe', '-v', 'error', '-show_packets', '-show_streams',
               '-show_data_hash', 'sha256', '-of', 'json', str(path)]
    return json.loads(subprocess.check_output(command))


def identity(probed):
    if len(probed['streams']) != 1 or probed['streams'][0]['codec_type'] != 'video':
        raise ValueError('This control expects a video-only native recording')
    stream_keys = ['codec_name', 'profile', 'codec_tag_string', 'width', 'height',
                   'pix_fmt', 'level', 'time_base', 'extradata_size', 'extradata_hash',
                   'color_range', 'color_space', 'color_transfer', 'color_primaries']
    packet_keys = ['pts', 'dts', 'duration', 'size', 'flags', 'data_hash']
    stream = {key: probed['streams'][0].get(key) for key in stream_keys}
    packets = [{key: packet.get(key) for key in packet_keys} for packet in probed['packets']]
    if not packets or any(not packet['data_hash'] for packet in packets):
        raise ValueError('Packet hashes are missing')
    if not stream['extradata_hash']:
        raise ValueError('Codec extradata hash is missing')
    return {'stream': stream, 'packets': packets}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording', type=Path)
    parser.add_argument('--source-head', required=True)
    args = parser.parse_args()
    original = args.recording.resolve(strict=True)
    front_boxes = boxes(original)
    offsets = {box['type']: box['offset'] for box in front_boxes}
    if offsets['moov'] >= offsets['mdat']:
        raise ValueError('Fresh source must already have a front index')
    front_probe = probe(original)
    front_identity = identity(front_probe)
    denominator = front_probe['streams'][0]['time_base'].split('/')
    if denominator[0] != '1':
        raise ValueError('Unexpected native recording time base')
    media = ROOT / 'media'
    media.mkdir(exist_ok=True)
    source_sha = sha(original)
    front = media / f'front-{source_sha}.mp4'
    if not front.exists():
        shutil.copy2(original, front)
    with tempfile.TemporaryDirectory(dir=ROOT) as temp:
        tail_temp = Path(temp) / 'tail.mp4'
        command = ['ffmpeg', '-hide_banner', '-nostdin', '-v', 'error', '-i', str(front),
                   '-map', '0:v:0', '-c', 'copy', '-copyts', '-avoid_negative_ts', 'disabled',
                   '-video_track_timescale', denominator[1], str(tail_temp)]
        subprocess.run(command, check=True)
        tail_probe = probe(tail_temp)
        tail_identity = identity(tail_probe)
        if front_identity != tail_identity:
            (ROOT / 'failed-front-probe.json').write_text(json.dumps(front_probe, indent=2))
            (ROOT / 'failed-tail-probe.json').write_text(json.dumps(tail_probe, indent=2))
            raise ValueError('Remux changed packet, timestamp, or codec identity; do not benchmark')
        tail_boxes = boxes(tail_temp)
        tail_offsets = {box['type']: box['offset'] for box in tail_boxes}
        if tail_offsets['moov'] <= tail_offsets['mdat']:
            raise ValueError('Control must have a tail index')
        tail_sha = sha(tail_temp)
        tail = media / f'tail-{tail_sha}.mp4'
        if not tail.exists():
            shutil.move(str(tail_temp), tail)
    proof = {'source': str(original), 'sourceHead': args.source_head,
             'sourceFileSha256': source_sha, 'tailFileSha256': tail_sha,
             'packetCount': len(front_identity['packets']), 'packetAndTimestampIdentity': True,
             'packetIdentitySha256': hashlib.sha256(json.dumps(front_identity['packets'],
                                        sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
             'stream': front_identity['stream'], 'frontBoxes': front_boxes, 'tailBoxes': tail_boxes,
             'controlCommand': command,
             'ffmpegVersion': subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0]}
    (ROOT / 'packet-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    manifest = {'front': str(front), 'tail': str(tail), 'sourceHead': args.source_head,
                'packetCount': proof['packetCount'], 'packetIdentitySha256': proof['packetIdentitySha256'],
                'settings': {'pairs': 6, 'mbps': 80, 'latencyMs': 150}}
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'prepared': True, 'packetCount': proof['packetCount'],
                      'packetAndTimestampIdentity': True, 'manifest': str(ROOT / 'manifest.json')}))


if __name__ == '__main__':
    main()
