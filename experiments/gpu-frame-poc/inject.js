// For the disposable emulator only. Module remains loaded after hooks detach.
const backend=Process.getModuleByName('libgfxstream_backend.so');
// FFmpeg is statically linked with hidden symbols to avoid renderer collisions.
const plugin=Module.load(POC_CONFIG.library);
const init=new NativeFunction(plugin.getExportByName('poc_init'),'int',['pointer','pointer','int','int']);
const frame=new NativeFunction(plugin.getExportByName('poc_frame'),'void',['pointer','uint']);
const stop=new NativeFunction(plugin.getExportByName('poc_stop'),'void',[]);
const status=new NativeFunction(plugin.getExportByName('poc_status'),'pointer',[]);
const getFB=new NativeFunction(backend.getExportByName('_ZN9gfxstream4host11FrameBuffer5getFBEv'),'pointer',[]);
const out=Memory.allocUtf8String(POC_CONFIG.output);
const path=Memory.allocUtf8String(backend.path);
if(init(path,out,POC_CONFIG.fps,POC_CONFIG.frames)!==0)throw new Error('native initialization failed; see emulator log');
const hooks=[];
const getGlProc=new NativeFunction(backend.getExportByName('_ZN9gfxstream4host2gl35gles2_dispatch_get_proc_func_staticEPKc'),'pointer',['pointer']);
const read=getGlProc(Memory.allocUtf8String('glReadPixels'));
const get=getGlProc(Memory.allocUtf8String('glGetTexImage'));
const readOriginal=Interceptor.replaceFast(read,plugin.getExportByName('poc_read_pixels'));
const getOriginal=Interceptor.replaceFast(get,plugin.getExportByName('poc_get_tex_image'));
new NativeFunction(plugin.getExportByName('poc_audit_originals'),'void',['pointer','pointer'])(readOriginal,getOriginal);
Interceptor.flush();
for(const e of backend.enumerateExports()){
  if(e.name.startsWith('_ZN9gfxstream4host11FrameBuffer4Impl8postImplE')){
    hooks.push(Interceptor.attach(e.address,{onEnter(args){
      // Calls with needLockAndBind=false may already own the nonrecursive lock.
      if(args[3].toUInt32()&255)frame(getFB(),args[1].toUInt32());
    }}));
    send({hook:e.name});
  }
}
send({ready:true,backend:backend.path,output:out.readUtf8String()});
rpc.exports={status(){return JSON.parse(status().readUtf8String());},stop(){for(const h of hooks)h.detach();Interceptor.flush();stop();Interceptor.revert(read);Interceptor.revert(get);return {stopped:true};}};
