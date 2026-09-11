const backend = Process.getModuleByName('libgfxstream_backend.so');
for (const e of backend.enumerateExports()) {
  if (/FrameBuffer.*(post|lock|unlock|getFB|findColorBuffer|borrowColorBufferForDisplay|createSharedTrivialContext|getDisplay)|getBorrowedImageInfo|waitSync|s_egl|gles2_dispatch_get_proc_func_static/.test(e.name))
    send({name:e.name, address:e.address.toString()});
}
send({modules:Process.enumerateModules().map(m=>({name:m.name,path:m.path}))});
rpc.exports = {stop(){return {done:true};}};
