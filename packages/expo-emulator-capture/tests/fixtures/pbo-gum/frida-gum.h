#pragma once
using gpointer = void*;
struct GumInvocationContext { void* arguments[2]; };
using Callback = void (*)(GumInvocationContext*, gpointer);
struct GumInvocationListener { Callback enter; };
struct GumInterceptor {};
inline GumInvocationListener listener{};
inline GumInterceptor interceptor;
inline GumInterceptor* gum_interceptor_obtain() { return &interceptor; }
inline GumInvocationListener* gum_make_call_listener(Callback enter, Callback, gpointer, void*) {
  listener.enter = enter; return &listener;
}
constexpr int GUM_ATTACH_OK = 0;
inline int gum_interceptor_attach(GumInterceptor*, void*, GumInvocationListener*, void*) { return 0; }
inline void* gum_invocation_context_get_nth_argument(GumInvocationContext* c, unsigned index) {
  return c->arguments[index];
}
inline void g_object_unref(void*) {}
