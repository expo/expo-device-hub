#!/usr/bin/env python3
"""Offline decode of test-animation barcode. CPU decoding here is validation only."""
import json,subprocess,sys
for path in sys.argv[1:]:
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
       '-show_entries','stream=width,height','-of','json',path]))['streams'][0]
    w,h=info['width'],info['height']
    # Android test View fills the screen on the tested API 36 image.
    samples=subprocess.check_output(['ffmpeg','-nostdin','-v','error','-r','1','-i',path,'-vf',
       f'format=gray,crop={w}:1:0:{int(h*.78)},scale=16:1:flags=area',
       '-fps_mode','passthrough','-f','rawvideo','-pix_fmt','gray','pipe:1'])
    codes=[sum((value>128)<<bit for bit,value in enumerate(samples[i:i+16]))
       for i in range(0,len(samples),16)]
    deltas=[(b-a)%65536 for a,b in zip(codes,codes[1:])]
    print(json.dumps({'file':path,**info,'decoded_frames':len(codes),
       'first_barcode':codes[0],'last_barcode':codes[-1],
       'unique_barcodes':len(set(codes)),'duplicate_adjacent':deltas.count(0),
       'forward_one':deltas.count(1),'forward_gaps':sum(1<d<32768 for d in deltas),
       'backward_or_corrupt':sum(d>=32768 for d in deltas)},indent=2))
