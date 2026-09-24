#import <UIKit/UIKit.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int write_whole_file(const char *path, const void *contents, size_t length) {
  FILE *file = fopen(path, "w");
  if (file == NULL) return 0;
  size_t wrote = fwrite(contents, 1, length, file);
  int closed = fclose(file);
  return wrote == length && closed == 0;
}

static void answer(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || tmp[0] == '\0') return;

  char request[1024], value[1024], done[1024], pending[1024];
  snprintf(request, sizeof request, "%s/serve-sim-pasteboard.request", tmp);
  snprintf(value, sizeof value, "%s/serve-sim-pasteboard.txt", tmp);
  snprintf(done, sizeof done, "%s/serve-sim-pasteboard.txt.done", tmp);
  snprintf(pending, sizeof pending, "%s/serve-sim-pasteboard.txt.pending", tmp);

  // The nonce identifies the request being answered; the host rejects any other.
  FILE *file = fopen(request, "r");
  if (file == NULL) return;
  char nonce[128];
  size_t length = fread(nonce, 1, sizeof nonce - 1, file);
  fclose(file);
  nonce[length] = '\0';

  __block NSString *text = nil;
  dispatch_sync(dispatch_get_main_queue(), ^{
    text = UIPasteboard.generalPasteboard.string ?: @"";
  });

  // Publish done only after a whole write, or the host reads truncated text as success.
  NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
  if (!write_whole_file(value, data.bytes, data.length)) {
    fprintf(stderr, "[serve-sim] could not write the pasteboard answer to %s\n", value);
    return;
  }

  unlink(request);

  // Rename so the host never reads a half-written done file.
  if (!write_whole_file(pending, nonce, length) || rename(pending, done) != 0) {
    fprintf(stderr, "[serve-sim] could not publish the pasteboard answer to %s\n", done);
  }
}

static void *poll(void *unused) {
  (void)unused;
  for (;;) {
    @autoreleasepool {
      answer();
    }
    usleep(50 * 1000);
  }
  return NULL;
}

__attribute__((constructor))
static void sim_pasteboard_reader_ui_init(void) {
  pthread_t thread;
  if (pthread_create(&thread, NULL, poll, NULL) == 0) pthread_detach(thread);
}
