#import <UIKit/UIKit.h>

// Unlike simctl pbcopy, this in-simulator writer works without a GUI login.
int main(int argc, char *argv[]) {
  @autoreleasepool {
    if (argc != 1) {
      fputs("usage: serve-sim-pasteboard < text\n", stderr);
      return 2;
    }
    NSData *data = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!text) {
      fputs("stdin was not valid UTF-8\n", stderr);
      return 1;
    }

    UIPasteboard.generalPasteboard.string = text;
    // Exiting immediately after the assignment loses the write.
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
    return 0;
  }
}
