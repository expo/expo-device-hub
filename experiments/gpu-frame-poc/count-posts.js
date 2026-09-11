const b=Process.getModuleByName('libgfxstream_backend.so');
let count=0,first=0,last=0;const hooks=[];
for(const e of b.enumerateExports()){
  if(e.name.startsWith('_ZN9gfxstream4host11FrameBuffer4Impl8postImplE')){
    hooks.push(Interceptor.attach(e.address,{onEnter(){const now=Date.now();if(!count)first=now;count++;last=now;}}));
  }
}
rpc.exports={stop(){for(const h of hooks)h.detach();return {count,elapsedMs:last-first,fps:(count-1)*1000/(last-first)};}};
