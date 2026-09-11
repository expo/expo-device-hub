#!/usr/bin/env python3
"""Build-time NVRTC only; the injected library needs just the existing CUDA driver."""
import ctypes as C
import ctypes.util
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
library = os.environ.get('POC_NVRTC_LIBRARY') or ctypes.util.find_library('nvrtc')
if not library:
    matches = list(Path(sys.prefix).glob('lib/python*/site-packages/nvidia/cuda_nvrtc/lib/libnvrtc.so*'))
    if matches:
        library = str(matches[0])
if not library:
    raise SystemExit('Install nvidia-cuda-nvrtc-cu12 in the build venv or set POC_NVRTC_LIBRARY')
nvrtc = C.CDLL(library)
program = C.c_void_p()
def check(code):
    if code:
        raise RuntimeError(f'NVRTC error {code}')
check(nvrtc.nvrtcCreateProgram(C.byref(program), (root / 'scale.cu').read_bytes(), b'scale.cu', 0, None, None))
options = (C.c_char_p * 2)(b'--gpu-architecture=compute_75', b'--std=c++11')
try:
    result = nvrtc.nvrtcCompileProgram(program, len(options), options)
    size = C.c_size_t()
    check(nvrtc.nvrtcGetProgramLogSize(program, C.byref(size)))
    log = C.create_string_buffer(size.value)
    check(nvrtc.nvrtcGetProgramLog(program, log))
    if log.value:
        print(log.value.decode(), file=sys.stderr)
    check(result)
    check(nvrtc.nvrtcGetPTXSize(program, C.byref(size)))
    ptx = C.create_string_buffer(size.value)
    check(nvrtc.nvrtcGetPTX(program, ptx))
    (root / 'scale-ptx.h').write_text('static const char scalePtx[] = R"PTX(' + ptx.value.decode() + ')PTX";\n')
finally:
    nvrtc.nvrtcDestroyProgram(C.byref(program))
