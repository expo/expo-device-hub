#pragma once
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <cerrno>

// GPC1: big-endian length(u32), pts-us(u64), flags(u32), width(u32),
// height(u32), fps(u32). Flags: 1=IDR, 2=native hello, 3=settings applied.
// Client sends K (keyframe) or S + max-edge/fps/bitrate (three big-endian u32).
// Only the encoder worker accesses client; the render callback never writes.
struct SocketOutput {
    int listener=-1,client=-1; std::string path; bool needsKey=true, configured=false, settingsPending=false;
    int maxSize=0, requestedFps=60, bitRate=12000000;
    std::vector<uint8_t> commands;
    void open(const std::string& name) {
        if(name.size()>=sizeof(sockaddr_un::sun_path))throw std::runtime_error("socket path too long");
        listener=::socket(AF_UNIX,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);
        if(listener<0)throw std::runtime_error("socket creation failed");
        sockaddr_un address{};address.sun_family=AF_UNIX;strcpy(address.sun_path,name.c_str());
        if(::bind(listener,reinterpret_cast<sockaddr*>(&address),sizeof(address))<0) {
            ::close(listener);listener=-1;throw std::runtime_error("socket bind failed; choose a fresh path");
        }
        path=name;::chmod(path.c_str(),0600);
        if(::listen(listener,1)<0){close();throw std::runtime_error("socket listen failed");}
    }
    void disconnect(){if(client>=0)::close(client);client=-1;needsKey=true;configured=false;settingsPending=false;commands.clear();}
    bool writeAll(const uint8_t* bytes,size_t size) {
        auto deadline=Clock::now()+std::chrono::milliseconds(100);
        while(size&&client>=0) {
            ssize_t n=::send(client,bytes,size,MSG_NOSIGNAL|MSG_DONTWAIT);
            if(n>0){bytes+=n;size-=n;continue;}
            if(n<0&&errno==EINTR)continue;
            if(n<0&&(errno==EAGAIN||errno==EWOULDBLOCK)) {
                int remaining=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-Clock::now()).count();
                pollfd fd{client,POLLOUT,0};if(remaining>0&&::poll(&fd,1,remaining)>0)continue;
            }
            disconnect();return false;
        }
        return size==0;
    }
    bool packet(const uint8_t* data,uint32_t size,uint64_t pts,uint32_t flags,int w,int h,int fps) {
        if(client<0)return false;
        uint8_t header[32]={'G','P','C','1'};
        auto u32=[&](int at,uint32_t value){for(int i=3;i>=0;i--){header[at+i]=value&255;value>>=8;}};
        u32(4,size);u32(8,pts>>32);u32(12,pts);u32(16,flags);u32(20,w);u32(24,h);u32(28,fps);
        return writeAll(header,sizeof(header))&&writeAll(data,size);
    }
    void pollCommands(int w,int h,int fps) {
        if(client<0) {
            client=::accept4(listener,nullptr,nullptr,SOCK_NONBLOCK|SOCK_CLOEXEC);
            if(client<0)return;
            needsKey=true;packet(nullptr,0,0,2,w,h,fps);
        }
        uint8_t bytes[64];ssize_t n=::recv(client,bytes,sizeof(bytes),MSG_DONTWAIT);
        if(n==0){disconnect();return;}
        if(n<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR){disconnect();return;}
        if(n>0)commands.insert(commands.end(),bytes,bytes+n);
        while(!commands.empty()) {
            if(commands[0]=='K'){needsKey=true;commands.erase(commands.begin());continue;}
            if(commands[0]!='S'){disconnect();return;}
            if(commands.size()<13)return;
            auto u32=[&](int at){uint32_t v=0;for(int i=0;i<4;i++)v=(v<<8)|commands[at+i];return v;};
            auto size=u32(1),rate=u32(5),bits=u32(9);
            if(size>4096||(size>0&&uint64_t(std::min(w,h))*size/std::max(w,h)<2)||rate<1||rate>120||bits<100000||bits>50000000){disconnect();return;}
            maxSize=size;requestedFps=rate;bitRate=bits;settingsPending=true;configured=false;
            commands.erase(commands.begin(),commands.begin()+13);
        }
    }
    void close(){disconnect();if(listener>=0)::close(listener);listener=-1;if(!path.empty())::unlink(path.c_str());path.clear();}
};
