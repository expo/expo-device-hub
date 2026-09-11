// Experimental GPU-only RGBA downscale. Source remains at the emulator's native size.
extern "C" __global__ void scale_rgba(const unsigned char* src, unsigned long long srcPitch,
    int sw, int sh, unsigned char* dst, unsigned long long dstPitch, int dw, int dh) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= dw || y >= dh) return;
    float sx = (x + 0.5f) * sw / dw - 0.5f;
    float sy = (y + 0.5f) * sh / dh - 0.5f;
    sx = sx < 0 ? 0 : sx; sy = sy < 0 ? 0 : sy;
    int x0 = (int)sx, y0 = (int)sy;
    int x1 = x0 + 1 < sw ? x0 + 1 : sw - 1;
    int y1 = y0 + 1 < sh ? y0 + 1 : sh - 1;
    float fx = sx - x0, fy = sy - y0;
    for (int c = 0; c < 4; ++c) {
        float a = src[y0 * srcPitch + x0 * 4 + c];
        float b = src[y0 * srcPitch + x1 * 4 + c];
        float d = src[y1 * srcPitch + x0 * 4 + c];
        float e = src[y1 * srcPitch + x1 * 4 + c];
        dst[y * dstPitch + x * 4 + c] = (unsigned char)((a + (b-a)*fx)*(1-fy) + (d + (e-d)*fx)*fy + 0.5f);
    }
}
