// CPU-only declarations for exercising the real agent without Gum, QEMU or a GPU.
#pragma once
#include "../gum/frida-gum.h"
using gpointer = void*;
struct GumInvocationContext { int64_t data = 0; };
struct GumInterceptor {};
struct GumInvocationListener {};
using GumInvocationCallback = void (*)(GumInvocationContext*, gpointer);
#define GUM_IC_GET_INVOCATION_DATA(context, type) reinterpret_cast<type*>(&(context)->data)
constexpr int GUM_ATTACH_OK = 0;
void* gum_invocation_context_get_nth_argument(GumInvocationContext*, unsigned);
void gum_init_embedded();
GumInterceptor* gum_interceptor_obtain();
GumInvocationListener* gum_make_call_listener(GumInvocationCallback, GumInvocationCallback,
                                             gpointer, gpointer);
int gum_interceptor_attach(GumInterceptor*, void*, GumInvocationListener*, gpointer);
