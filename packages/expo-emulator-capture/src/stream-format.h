#pragma once
#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <utility>

inline std::pair<int,int> streamSize(int width,int height,int maxSize) {
    if(maxSize<0||maxSize>4096||width<2||height<2)throw std::runtime_error("invalid stream size");
    int edge=std::max(width,height),target=maxSize>0?std::min(maxSize,edge):edge;
    int w=(int64_t(width)*target/edge)/2*2,h=(int64_t(height)*target/edge)/2*2;
    if(w<2||h<2)throw std::runtime_error("stream size too small for H.264");
    return {w,h};
}
// Clock-paced sampling before GPU work; tolerate callback jitter without drift.
// No sleeping or catch-up queue after a stall.
struct FramePacer {
    int previousFps=0; double nextUs=0;
    bool take(int64_t elapsedUs,int fps) {
        double period=1000000.0/fps;
        if(previousFps!=fps){previousFps=fps;nextUs=elapsedUs;}
        if(elapsedUs+std::min(1000.0,period*0.05)<nextUs)return false;
        nextUs+=period;
        if(nextUs<=elapsedUs)nextUs=elapsedUs+period;
        return true;
    }
};
