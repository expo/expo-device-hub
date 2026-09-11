#include "stream-format.h"
#include <cassert>
#include <iostream>
int main() {
    assert(streamSize(1080,2424,0)==std::make_pair(1080,2424));
    assert(streamSize(1080,2424,1212)==std::make_pair(540,1212));
    assert(streamSize(1080,2424,1280)==std::make_pair(570,1280));
    assert(streamSize(1080,2424,4096)==std::make_pair(1080,2424));
    assert(streamSize(2424,1080,1280)==std::make_pair(1280,570));
    bool rejected=false;try{streamSize(1080,2424,1);}catch(...){rejected=true;}assert(rejected);
    for(int fps:{5,20,30,60,120}) {
        FramePacer pacer;int captured=0;
        for(int i=0;i<1200;i++)captured+=pacer.take(int64_t(i)*1000000/120,fps);
        assert(captured==fps*10);
    }
    FramePacer pacer;
    assert(pacer.take(0,30));assert(!pacer.take(1000,30));
    assert(pacer.take(10000000,30));assert(!pacer.take(10000001,30)); // no catch-up burst
    assert(pacer.take(10000002,60));assert(!pacer.take(10000003,60)); // settings change
    std::cout << "native stream size and FPS checks passed\n";
}
