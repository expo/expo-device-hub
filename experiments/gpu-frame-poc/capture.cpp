// Disposable proof for Linux x86_64 emulator 36.6.11, not a supported emulator API.
// FFmpeg owns CUDA input buffers. Only compressed packets are read by the CPU.
#include <EGL/egl.h>
#include <GL/gl.h>
#include <dlfcn.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <typeinfo>
#include <unordered_map>
#include <vector>
#include <ffnvcodec/dynlink_cuda.h>
static_assert(offsetof(CUDA_MEMCPY2D,srcMemoryType)==16);
static_assert(offsetof(CUDA_MEMCPY2D,dstMemoryType)==72);
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
}

using Clock = std::chrono::steady_clock;
static double ms(Clock::time_point t) { return std::chrono::duration<double,std::milli>(Clock::now()-t).count(); }
#include "socket-output.h"

template<class T> static T sym(void* lib, const char* name) {
    void* p = dlsym(lib,name);
    if (!p) throw std::runtime_error(std::string("missing symbol: ")+name);
    return reinterpret_cast<T>(p);
}
static void avcheck(int r,const char* op) {
    if(r<0) { char buf[128]; av_strerror(r,buf,sizeof(buf)); throw std::runtime_error(std::string(op)+": "+buf); }
}
static void cucheck(CUresult r,const char* op) {
    if(r!=CUDA_SUCCESS) throw std::runtime_error(std::string(op)+": CUDA "+std::to_string(r));
}
// Public leading fields from gfxstream's BorrowedImageInfo / BorrowedImageInfoGl.
struct Borrowed { virtual ~Borrowed(){}; uint32_t id=0,width=0,height=0; };
struct BorrowedGl: Borrowed { uint32_t texture=0; };
// Leading fields of FFmpeg's AVCUDADeviceContext. Avoid a full CUDA toolkit dependency.
struct CudaDevicePrefix { CUcontext cuda_ctx; CUstream stream; };
struct Slot { AVFrame* frame=nullptr; bool queued=false; uint64_t seq=0; };

struct Capture {
    void* backend=nullptr; void** egl=nullptr;
    void (*fbLock)(void*)=nullptr; void (*fbUnlock)(void*)=nullptr;
    void (*createContext)(void*,void**,void**)=nullptr;
    EGLDisplay (*getDisplay)(void*)=nullptr;
    std::unique_ptr<Borrowed> (*borrow)(void*,uint32_t)=nullptr;
    std::shared_ptr<void> (*find)(void*,uint32_t)=nullptr;
    void (*waitSync)(void*,bool)=nullptr;
    void* (*getGlProc)(const char*)=nullptr;
    GLuint (*nativeTexture)(GLuint)=nullptr;
    EGLContext ctx=nullptr; EGLSurface surf=nullptr; EGLDisplay display=nullptr;
    tcuCtxPushCurrent_v2* push=nullptr; tcuCtxPopCurrent_v2* pop=nullptr;
    CUresult (CUDAAPI *streamSync)(CUstream)=nullptr;
    tcuGraphicsGLRegisterImage* reg=nullptr; tcuGraphicsUnregisterResource* unreg=nullptr;
    tcuGraphicsMapResources* map=nullptr; tcuGraphicsUnmapResources* unmap=nullptr;
    tcuGraphicsSubResourceGetMappedArray* array=nullptr; tcuMemcpy2D_v2* copy=nullptr;
    CUresult (CUDAAPI *arrayDesc)(CUDA_ARRAY_DESCRIPTOR*,CUarray)=nullptr;
    std::unordered_map<GLuint,CUgraphicsResource> resources;
    AVBufferRef* device=nullptr; AVBufferRef* frames=nullptr; AVCodecContext* encoder=nullptr;
    CUcontext cuda=nullptr; FILE* output=nullptr; FILE* metrics=nullptr;
    std::vector<Slot> slots=std::vector<Slot>(4);
    std::mutex mutex; std::condition_variable cv; std::deque<int> queue; std::thread worker;
    std::atomic<bool> enabled{false}, stopping{false};
    bool ready=false, failed=false; int fps=60; int limit=1800;
    std::atomic<uint64_t> seen{0},captured{0},dropped{0},encoded{0},errors{0};
    Clock::time_point start=Clock::now();
    std::string outputPath;
    SocketOutput socketOutput; bool live=false;
    int64_t lastEncodedPts=-1;

    template<class T> T ef(int index) {return reinterpret_cast<T>(egl[index]);}
    void init(const char* path,const char* out,int rate,int count) {
        if(rate<=0||count<=0)throw std::runtime_error("fps and frame count must be positive");
        backend=dlopen(path,RTLD_NOW|RTLD_NOLOAD);
        if(!backend) throw std::runtime_error("renderer is not loaded");
        fbLock=sym<decltype(fbLock)>(backend,"_ZN9gfxstream4host11FrameBuffer4lockEv");
        fbUnlock=sym<decltype(fbUnlock)>(backend,"_ZN9gfxstream4host11FrameBuffer6unlockEv");
        createContext=sym<decltype(createContext)>(backend,"_ZN9gfxstream4host11FrameBuffer26createSharedTrivialContextEPPvS3_");
        getDisplay=sym<decltype(getDisplay)>(backend,"_ZNK9gfxstream4host11FrameBuffer10getDisplayEv");
        borrow=sym<decltype(borrow)>(backend,"_ZN9gfxstream4host11FrameBuffer27borrowColorBufferForDisplayEj");
        find=sym<decltype(find)>(backend,"_ZN9gfxstream4host11FrameBuffer15findColorBufferEj");
        // This release has no exported GL accessor. Verify the two field offsets
        // against instructions in the exact loaded binary before using them.
        auto widthGetter=sym<const unsigned char*>(backend,"_ZNK9gfxstream4host11ColorBuffer8getWidthEv");
        auto borrowImpl=sym<const unsigned char*>(backend,"_ZN9gfxstream4host11ColorBuffer4Impl16borrowForDisplayENS1_7UsedApiE");
        const unsigned char implLoad[]={0x48,0x8b,0x47,0x30};
        const unsigned char glLoad[]={0x48,0x8b,0x76,0x40};
        if(memcmp(widthGetter,implLoad,4)||memcmp(borrowImpl+13,glLoad,4))
            throw std::runtime_error("unsupported renderer private ABI; refusing field access");
        waitSync=sym<decltype(waitSync)>(backend,"_ZN9gfxstream4host2gl13ColorBufferGl8waitSyncEb");
        getGlProc=sym<decltype(getGlProc)>(backend,"_ZN9gfxstream4host2gl35gles2_dispatch_get_proc_func_staticEPKc");
        egl=sym<void**>(backend,"_ZN9gfxstream4host2gl5s_eglE");
        nativeTexture=reinterpret_cast<decltype(nativeTexture)>(getGlProc("glGetGlobalTexName"));
        if(!nativeTexture) throw std::runtime_error("no native texture translator");
        auto cudalib=dlopen("libcuda.so.1",RTLD_NOW|RTLD_LOCAL);
        if(!cudalib) throw std::runtime_error("libcuda.so.1 unavailable");
#define LOAD(member,name) member=sym<decltype(member)>(cudalib,name)
        LOAD(push,"cuCtxPushCurrent_v2"); LOAD(pop,"cuCtxPopCurrent_v2"); LOAD(streamSync,"cuStreamSynchronize");
        LOAD(reg,"cuGraphicsGLRegisterImage"); LOAD(unreg,"cuGraphicsUnregisterResource");
        LOAD(map,"cuGraphicsMapResources"); LOAD(unmap,"cuGraphicsUnmapResources");
        LOAD(array,"cuGraphicsSubResourceGetMappedArray"); LOAD(copy,"cuMemcpy2D_v2");
        LOAD(arrayDesc,"cuArrayGetDescriptor_v2");
#undef LOAD
        fps=rate; limit=count; outputPath=out;
        live=outputPath.rfind("unix:",0)==0;
        if(live)socketOutput.open(outputPath.substr(5));
        enabled=true;
        fprintf(stderr,"[gpu-poc] armed fps=%d limit=%d output=%s\n",fps,limit,out);
    }
    void setupEncoder(int w,int h) {
        avcheck(av_hwdevice_ctx_create(&device,AV_HWDEVICE_TYPE_CUDA,"0",nullptr,0),"CUDA device");
        cuda=reinterpret_cast<CudaDevicePrefix*>(reinterpret_cast<AVHWDeviceContext*>(device->data)->hwctx)->cuda_ctx;
        frames=av_hwframe_ctx_alloc(device);
        if(!frames) throw std::runtime_error("CUDA frame context allocation failed");
        auto f=reinterpret_cast<AVHWFramesContext*>(frames->data);
        f->format=AV_PIX_FMT_CUDA; f->sw_format=AV_PIX_FMT_0BGR32;
        f->width=w; f->height=h; f->initial_pool_size=8;
        avcheck(av_hwframe_ctx_init(frames),"CUDA frames");
        encoder=avcodec_alloc_context3(avcodec_find_encoder_by_name("h264_nvenc"));
        if(!encoder) throw std::runtime_error("h264_nvenc unavailable");
        encoder->width=w; encoder->height=h; encoder->pix_fmt=AV_PIX_FMT_CUDA;
        encoder->hw_frames_ctx=av_buffer_ref(frames);
        encoder->time_base=live?AVRational{1,1000000}:AVRational{1,fps}; encoder->framerate={fps,1}; encoder->bit_rate=12000000;
        encoder->gop_size=fps; encoder->max_b_frames=0;
        AVDictionary* opts=nullptr;
        av_dict_set(&opts,"preset","p1",0); av_dict_set(&opts,"tune","ull",0);
        av_dict_set(&opts,"forced-idr","1",0);
        av_dict_set(&opts,"zerolatency","1",0); av_dict_set(&opts,"delay","0",0);
        int r=avcodec_open2(encoder,encoder->codec,&opts); av_dict_free(&opts); avcheck(r,"open NVENC");
        for(auto& slot:slots) { slot.frame=av_frame_alloc(); avcheck(av_hwframe_get_buffer(frames,slot.frame,0),"allocate GPU frame"); }
        if(!live)output=fopen(outputPath.c_str(),"wb");
        metrics=fopen(((live?outputPath.substr(5):outputPath)+".csv").c_str(),"w");
        if((!live&&!output)||!metrics) throw std::runtime_error("output file creation failed");
        fprintf(metrics,"frame,elapsed_ms,capture_ms,copy_ms,native_texture\n");
        start=Clock::now(); ready=true;
        worker=std::thread([this]{encodeLoop();});
        fprintf(stderr,"[gpu-poc] encoder ready %dx%d CUDA RGB0 -> h264_nvenc\n",w,h);
    }
    void drain() {
        AVPacket* pkt=av_packet_alloc();
        while(true) {
            int r=avcodec_receive_packet(encoder,pkt);
            if(r==AVERROR(EAGAIN)||r==AVERROR_EOF) break;
            avcheck(r,"receive packet");
            if(live) {
                socketOutput.packet(pkt->data,pkt->size,pkt->pts<0?0:pkt->pts,
                    (pkt->flags&AV_PKT_FLAG_KEY)?1:0,encoder->width,encoder->height,fps);
            } else if(fwrite(pkt->data,1,pkt->size,output)!=(size_t)pkt->size) {av_packet_free(&pkt);throw std::runtime_error("write failed");}
            encoded++; av_packet_unref(pkt);
        }
        av_packet_free(&pkt);
    }
    void encodeLoop() {
        AVFrame* latest=av_frame_alloc();auto lastSend=Clock::now();
        try {
            while(true) {
                int i=-1;
                { std::unique_lock<std::mutex> l(mutex);
                  cv.wait_for(l,std::chrono::milliseconds(25),[this]{return stopping||!queue.empty();});
                  if(stopping&&queue.empty())break;
                  if(!queue.empty()){i=queue.front();queue.pop_front();} }
                if(live)socketOutput.pollCommands(encoder->width,encoder->height,fps);
                bool repeat=i<0&&live&&socketOutput.client>=0&&latest->buf[0]&&
                    (socketOutput.needsKey||ms(lastSend)>=500);
                if(i<0&&!repeat)continue;
                AVFrame* frame=i>=0?slots[i].frame:av_frame_clone(latest);
                if(!frame)throw std::runtime_error("repeat frame allocation failed");
                if(live) {
                    if(repeat)frame->pts=static_cast<int64_t>(ms(start)*1000);
                    frame->pts=std::max(frame->pts,lastEncodedPts+1);lastEncodedPts=frame->pts;
                }
                frame->pict_type=(live&&socketOutput.needsKey)?AV_PICTURE_TYPE_I:AV_PICTURE_TYPE_NONE;
                socketOutput.needsKey=false;
                avcheck(avcodec_send_frame(encoder,frame),"send frame");drain();lastSend=Clock::now();
                if(i>=0) {
                    av_frame_unref(latest);avcheck(av_frame_ref(latest,frame),"retain latest GPU frame");
                    std::lock_guard<std::mutex> l(mutex);slots[i].queued=false;
                } else av_frame_free(&frame);
            }
            avcheck(avcodec_send_frame(encoder,nullptr),"flush");drain();if(output)fflush(output);
        } catch(const std::exception& e) {errors++;enabled=false;fprintf(stderr,"[gpu-poc] worker error: %s\n",e.what());}
        av_frame_free(&latest);
    }
    void onFrame(void* fb,uint32_t handle);
    void stop() {
        enabled=false;
        // Caller first detaches hooks and waits for in-flight callbacks.
        stopping=true;cv.notify_all();if(worker.joinable())worker.join();
        socketOutput.close();
        if(output){fclose(output);output=nullptr;}if(metrics){fclose(metrics);metrics=nullptr;}
        fprintf(stderr,"[gpu-poc] summary seen=%lu captured=%lu encoded=%lu dropped=%lu errors=%lu elapsed_ms=%.3f\n",
                seen.load(),captured.load(),encoded.load(),dropped.load(),errors.load(),ms(start));
    }
};
static thread_local bool insideCapture=false;
static std::atomic<uint64_t> readPixelsTotal{0},readPixelsCapture{0},getTexTotal{0},getTexCapture{0};
static void (*originalReadPixels)(GLint,GLint,GLsizei,GLsizei,GLenum,GLenum,void*)=nullptr;
static void (*originalGetTexImage)(GLenum,GLint,GLenum,GLenum,void*)=nullptr;
extern "C" void poc_read_pixels(GLint x,GLint y,GLsizei w,GLsizei h,GLenum format,GLenum type,void* data) {
    readPixelsTotal++;if(insideCapture)readPixelsCapture++;
    originalReadPixels(x,y,w,h,format,type,data);
}
extern "C" void poc_get_tex_image(GLenum target,GLint level,GLenum format,GLenum type,void* data) {
    getTexTotal++;if(insideCapture)getTexCapture++;
    originalGetTexImage(target,level,format,type,data);
}
extern "C" void poc_audit_originals(void* read,void* get) {
    originalReadPixels=reinterpret_cast<decltype(originalReadPixels)>(read);
    originalGetTexImage=reinterpret_cast<decltype(originalGetTexImage)>(get);
}
static Capture capture;
static thread_local void* currentColorGl=nullptr;
static std::mutex captureMutex;

void Capture::onFrame(void* fb,uint32_t handle) {
    if(!enabled) return;
    seen++;
    std::unique_lock<std::mutex> guard(captureMutex,std::try_to_lock);
    if(!guard.owns_lock()){dropped++;return;}
    if(!enabled)return;
    struct Scope { Scope(){insideCapture=true;} ~Scope(){insideCapture=false;} } scope;
    auto begin=Clock::now();
    if(captured>=static_cast<uint64_t>(limit)){enabled=false;return;}
    int slotIndex=-1;
    if(ready) {
        std::lock_guard<std::mutex> l(mutex);
        for(int i=0;i<(int)slots.size();i++) if(!slots[i].queued && av_buffer_is_writable(slots[i].frame->buf[0])) {slotIndex=i;slots[i].queued=true;break;}
        if(slotIndex<0){dropped++;return;}
    }
    // RenderEGL_functions.h dispatch order, verified against this binary at runtime.
    auto currentCtx=ef<EGLContext(*)()>(17);
    auto currentDisplay=ef<EGLDisplay(*)()>(18);
    auto currentSurface=ef<EGLSurface(*)(EGLint)>(19);
    auto makeCurrent=ef<EGLBoolean(*)(EGLDisplay,EGLSurface,EGLSurface,EGLContext)>(16);
    EGLContext oldCtx=currentCtx(); EGLDisplay oldDisplay=currentDisplay();
    EGLSurface oldDraw=currentSurface(EGL_DRAW),oldRead=currentSurface(EGL_READ);
    bool locked=false,pushed=false,mapped=false;CUgraphicsResource resource=nullptr;
    try {
        fbLock(fb);locked=true;
        auto retained=find(fb,handle);
        if(!retained) throw std::runtime_error("posted color buffer disappeared");
        if(!ctx){display=getDisplay(fb);createContext(fb,&ctx,&surf);}
        if(!ctx||!surf||!makeCurrent(display,surf,surf,ctx))throw std::runtime_error("make shared renderer context current failed");
        auto info=borrow(fb,handle);
        Borrowed* descriptor=info.get();
        if(!descriptor||!strstr(typeid(*descriptor).name(),"BorrowedImageInfoGl"))
            throw std::runtime_error("GL descriptor missing (Vulkan composition is unsupported in this proof)");
        void* impl=nullptr;
        memcpy(&impl,static_cast<char*>(retained.get())+0x30,sizeof(impl));
        memcpy(&currentColorGl,static_cast<char*>(impl)+0x40,sizeof(currentColorGl));
        if(!currentColorGl)throw std::runtime_error("no GL backing");
        uint32_t backingWidth=0,backingHeight=0,backingTexture=0;
        memcpy(&backingWidth,currentColorGl,4);memcpy(&backingHeight,static_cast<char*>(currentColorGl)+4,4);
        memcpy(&backingTexture,static_cast<char*>(currentColorGl)+12,4);
        if(backingWidth!=info->width||backingHeight!=info->height||backingTexture!=static_cast<BorrowedGl*>(info.get())->texture)
            throw std::runtime_error("GL backing descriptor mismatch");
        waitSync(currentColorGl,false);
        GLuint texture=nativeTexture(static_cast<BorrowedGl*>(info.get())->texture);
        if(!texture)throw std::runtime_error("native texture is zero");
        if(!ready){setupEncoder(info->width,info->height);slotIndex=0;slots[0].queued=true;}
        if((int)info->width!=encoder->width||(int)info->height!=encoder->height)throw std::runtime_error("resolution changed; fixed-size proof stopped");
        cucheck(push(cuda),"push CUDA");pushed=true;
        auto found=resources.find(texture);
        if(found==resources.end()) {
            cucheck(reg(&resource,texture,GL_TEXTURE_2D,1),"register renderer GL texture");
            resources.emplace(texture,resource);
        } else resource=found->second;
        auto copyBegin=Clock::now();
        cucheck(map(1,&resource,nullptr),"map GL resource");mapped=true;
        CUarray source;cucheck(array(&source,resource,0,0),"get CUDA array");
        CUDA_ARRAY_DESCRIPTOR desc{};cucheck(arrayDesc(&desc,source),"CUDA array descriptor");
        if(desc.Width!=info->width||desc.Height!=info->height||desc.NumChannels!=4||desc.Format!=CU_AD_FORMAT_UNSIGNED_INT8)
            throw std::runtime_error("expected matching RGBA8 texture");
        auto frame=slots[slotIndex].frame;
        CUDA_MEMCPY2D transfer{};
        transfer.srcMemoryType=CU_MEMORYTYPE_ARRAY;transfer.srcArray=source;
        transfer.dstMemoryType=CU_MEMORYTYPE_DEVICE;transfer.dstDevice=reinterpret_cast<CUdeviceptr>(frame->data[0]);
        transfer.dstPitch=frame->linesize[0];transfer.WidthInBytes=info->width*4;transfer.Height=info->height;
        cucheck(copy(&transfer),"GPU-to-GPU copy");
        cucheck(unmap(1,&resource,nullptr),"unmap GL resource");mapped=false;
        // NVENC consumes this buffer on a different worker. Do not depend on
        // implicit cross-engine ordering: finish CUDA work before queueing it.
        cucheck(streamSync(nullptr),"wait for GPU copy completion");
        double copyMs=ms(copyBegin);
        CUcontext popped;cucheck(pop(&popped),"pop CUDA");pushed=false;
        makeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
        if(oldCtx)makeCurrent(oldDisplay,oldDraw,oldRead,oldCtx);
        fbUnlock(fb);locked=false;
        uint64_t n=captured++;
        frame->pts=live?static_cast<int64_t>(ms(start)*1000):n;
        fprintf(metrics,"%lu,%.3f,%.3f,%.3f,%u\n",n,ms(start),ms(begin),copyMs,texture);
        {std::lock_guard<std::mutex> l(mutex);queue.push_back(slotIndex);}
        cv.notify_one();
        if(n%120==0)fprintf(stderr,"[gpu-poc] frame=%lu texture=%u capture_ms=%.3f copy_ms=%.3f\n",n,texture,ms(begin),copyMs);
    } catch(const std::exception& e) {
        if(mapped)unmap(1,&resource,nullptr);
        if(pushed){CUcontext popped;pop(&popped);}
        if(ctx)makeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
        if(oldCtx)makeCurrent(oldDisplay,oldDraw,oldRead,oldCtx);
        if(locked)fbUnlock(fb);
        if(slotIndex>=0){std::lock_guard<std::mutex> l(mutex);slots[slotIndex].queued=false;}
        errors++;enabled=false;fprintf(stderr,"[gpu-poc] capture error: %s\n",e.what());
    }
}
extern "C" int poc_init(const char* backend,const char* out,int fps,int count) {
    try{capture.init(backend,out,fps,count);return 0;}catch(const std::exception& e){fprintf(stderr,"[gpu-poc] init error: %s\n",e.what());return -1;}
}
extern "C" void* poc_cuda_copy_address(){return reinterpret_cast<void*>(capture.copy);}
extern "C" void poc_frame(void* fb,uint32_t handle){capture.onFrame(fb,handle);}
extern "C" void poc_stop(){std::lock_guard<std::mutex> l(captureMutex);capture.stop();
    fprintf(stderr,"[gpu-poc] native audit glReadPixels_total=%lu capture=%lu glGetTexImage_total=%lu capture=%lu\n",
      readPixelsTotal.load(),readPixelsCapture.load(),getTexTotal.load(),getTexCapture.load());
}
