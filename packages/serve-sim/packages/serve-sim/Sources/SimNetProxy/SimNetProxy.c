#include <arpa/inet.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <objc/runtime.h>
#include <stdio.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

#include "../ServeSimCapabilityLoader/startup-capability.h"

typedef id (*ConfigurationFactory)(id, SEL);
typedef id (*BackgroundFactory)(id, SEL, id);

static struct {
    Class (*getClass)(const char *);
    Class (*getMetaclass)(id);
    Class (*getSuperclass)(Class);
    Method *(*copyMethods)(Class, unsigned int *);
    SEL (*methodName)(Method);
    SEL (*selector)(const char *);
    IMP (*implementation)(Method);
    IMP (*replaceMethod)(Method, IMP);
    void (*send)(void);
} runtime;

static _Atomic(ConfigurationFactory) originalDefault;
static _Atomic(ConfigurationFactory) originalEphemeral;
static _Atomic(BackgroundFactory) originalBackground;
static long proxyPort;
static atomic_flag initialized = ATOMIC_FLAG_INIT;

static Method findFactory(Class cls, const char *name) {
    SEL selector = runtime.selector(name);
    for (Class meta = runtime.getMetaclass((id)cls); meta; meta = runtime.getSuperclass(meta)) {
        unsigned int count = 0;
        Method *methods = runtime.copyMethods(meta, &count);
        Method found = NULL;
        for (unsigned int i = 0; i < count; i++) {
            if (runtime.methodName(methods[i]) == selector) {
                found = methods[i];
                break;
            }
        }
        free(methods);
        if (found) return found;
    }
    return NULL;
}

static id string(const char *value) {
    return ((id (*)(id, SEL, const char *))runtime.send)(
        (id)runtime.getClass("NSString"), runtime.selector("stringWithUTF8String:"), value);
}

static id number(long value) {
    return ((id (*)(id, SEL, long))runtime.send)(
        (id)runtime.getClass("NSNumber"), runtime.selector("numberWithLong:"), value);
}

static id applyProxy(id configuration) {
    if (!configuration) return configuration;
    id host = string("127.0.0.1");
    id port = number(proxyPort);
    id enabled = number(1);
    id keys[] = {string("HTTPEnable"), string("HTTPProxy"), string("HTTPPort"),
                 string("HTTPSEnable"), string("HTTPSProxy"), string("HTTPSPort")};
    id values[] = {enabled, host, port, enabled, host, port};
    id dictionary = ((id (*)(id, SEL, const id *, const id *, unsigned long))runtime.send)(
        (id)runtime.getClass("NSDictionary"), runtime.selector("dictionaryWithObjects:forKeys:count:"),
        values, keys, 6);
    ((void (*)(id, SEL, id))runtime.send)(
        configuration, runtime.selector("setConnectionProxyDictionary:"), dictionary);
    return configuration;
}

static id defaultConfiguration(id cls, SEL selector) {
    return applyProxy(atomic_load(&originalDefault)(cls, selector));
}

static id ephemeralConfiguration(id cls, SEL selector) {
    return applyProxy(atomic_load(&originalEphemeral)(cls, selector));
}

static id backgroundConfiguration(id cls, SEL selector, id identifier) {
    return applyProxy(atomic_load(&originalBackground)(cls, selector, identifier));
}

static long readPort(void) {
    const char *path = getenv("SIMNET_PROXY_PORT_FILE");
    if (!path) return 0;
    int file = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    if (file < 0) return 0;
    struct stat info;
    if (fstat(file, &info) != 0 || !S_ISREG(info.st_mode)) {
        close(file);
        return 0;
    }
    char text[32] = {0};
    ssize_t length = read(file, text, sizeof(text) - 1);
    close(file);
    char *end;
    long port = strtol(text, &end, 10);
    if (length <= 0 || end == text || (*end != '\0' && *end != '\n') || port <= 0 || port > 65535) return 0;
    int socketFd = socket(AF_INET, SOCK_STREAM, 0);
    if (socketFd < 0) return 0;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int result = connect(socketFd, (struct sockaddr *)&address, sizeof address);
    close(socketFd);
    return result == 0 ? port : 0;
}

static void initializeProxy(void) {
    if (atomic_flag_test_and_set(&initialized)) return;
    proxyPort = readPort();
    if (!proxyPort) return;
    runtime.getClass = dlsym(RTLD_DEFAULT, "objc_getClass");
    runtime.getMetaclass = dlsym(RTLD_DEFAULT, "object_getClass");
    runtime.getSuperclass = dlsym(RTLD_DEFAULT, "class_getSuperclass");
    runtime.copyMethods = dlsym(RTLD_DEFAULT, "class_copyMethodList");
    runtime.methodName = dlsym(RTLD_DEFAULT, "method_getName");
    runtime.selector = dlsym(RTLD_DEFAULT, "sel_registerName");
    runtime.implementation = dlsym(RTLD_DEFAULT, "method_getImplementation");
    runtime.replaceMethod = dlsym(RTLD_DEFAULT, "method_setImplementation");
    runtime.send = dlsym(RTLD_DEFAULT, "objc_msgSend");
    if (!runtime.getClass || !runtime.getMetaclass || !runtime.getSuperclass || !runtime.copyMethods ||
        !runtime.methodName || !runtime.selector || !runtime.implementation || !runtime.replaceMethod || !runtime.send) return;
    Class cls = runtime.getClass("NSURLSessionConfiguration");
    if (!cls) return;
    Method defaults = findFactory(cls, "defaultSessionConfiguration");
    Method ephemeral = findFactory(cls, "ephemeralSessionConfiguration");
    Method background = findFactory(cls, "backgroundSessionConfigurationWithIdentifier:");
    if (!defaults || !ephemeral || !background) {
        fprintf(stderr, "[simnetproxy] session factories unavailable; relaunch with a supported simulator runtime.\n");
        return;
    }
    atomic_store(&originalDefault, (ConfigurationFactory)runtime.implementation(defaults));
    atomic_store(&originalEphemeral, (ConfigurationFactory)runtime.implementation(ephemeral));
    atomic_store(&originalBackground, (BackgroundFactory)runtime.implementation(background));
    runtime.replaceMethod(defaults, (IMP)defaultConfiguration);
    runtime.replaceMethod(ephemeral, (IMP)ephemeralConfiguration);
    runtime.replaceMethod(background, (IMP)backgroundConfiguration);
}

SERVE_SIM_STARTUP_CAPABILITY(initializeProxy)
