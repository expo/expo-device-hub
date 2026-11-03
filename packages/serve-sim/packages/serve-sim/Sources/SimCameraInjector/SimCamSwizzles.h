#pragma once

#import <Foundation/Foundation.h>

void SimCamInstallSwizzles(void);
/** Install `swiz` in place of `orig` on `cls`, also when `cls` only inherits `orig`. */
BOOL SimCamSwizzleInstanceMethod(Class cls, SEL orig, SEL swiz);
