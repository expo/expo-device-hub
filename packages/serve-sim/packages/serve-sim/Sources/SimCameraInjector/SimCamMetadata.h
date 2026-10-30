#pragma once

#import <AVFoundation/AVFoundation.h>

/** Install the AVCaptureMetadataOutput and preview-layer hooks. */
void SimCamInstallMetadataSwizzles(void);

/** A metadata output joined or left a session that runs on the fake camera. */
void SimCamMetadataAttach(AVCaptureMetadataOutput *output, AVCaptureSession *session);
void SimCamMetadataDetach(AVCaptureMetadataOutput *output);

/** Called by the frame pump for every frame; scans a few of them for the attached outputs. */
void SimCamMetadataSampleFrame(CVPixelBufferRef frame);
