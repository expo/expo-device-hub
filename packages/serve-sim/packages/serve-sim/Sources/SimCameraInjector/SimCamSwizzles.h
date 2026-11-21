#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallSwizzles(void);
/** NO until the fake session that owns the output has started, and again once it stops. */
BOOL SimCamOutputSessionIsRunning(AVCaptureOutput *output);
