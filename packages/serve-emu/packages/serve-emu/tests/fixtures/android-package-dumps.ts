/**
 * Real `adb shell` and `aapt2` output, captured from an Android 16 (API 36)
 * `sdk_gphone64_arm64` emulator for Pixel Launcher, a system app. Lines are cut
 * only at section boundaries, never edited, so a parser that passes here reads
 * what a device really prints.
 */

/** `dumpsys package com.google.android.apps.nexuslauncher`, its `Packages:` section. */
export const LAUNCHER_DUMPSYS_PACKAGE = String.raw`
Packages:
  Package [com.google.android.apps.nexuslauncher] (8dc2fc1):
    appId=10191
    pkg=Package{c935366 com.google.android.apps.nexuslauncher}
    codePath=/system_ext/priv-app/NexusLauncherRelease
    resourcePath=/system_ext/priv-app/NexusLauncherRelease
    legacyNativeLibraryDir=/system_ext/priv-app/NexusLauncherRelease/lib
    extractNativeLibs=true
    primaryCpuAbi=null
    secondaryCpuAbi=null
    cpuAbiOverride=null
    versionCode=907 minSdk=36 targetSdk=36
    minExtensionVersions=[]
    versionName=16
    hiddenApiEnforcementPolicy=0
    usesNonSdkApi=true
    splits=[base]
    apkSigningVersion=3
    flags=[ SYSTEM HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP KILL_AFTER_RESTORE RESTORE_ANY_VERSION ]
    privateFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE_VIA_SDK_VERSION ALLOW_AUDIO_PLAYBACK_CAPTURE BACKUP_IN_FOREGROUND PARTIALLY_DIRECT_BOOT_AWARE PRIVILEGED SYSTEM_EXT PRIVATE_FLAG_ALLOW_NATIVE_HEAP_POINTER_TAGGING ]
    forceQueryable=false
    pageSizeCompat=0
    scannedAsStoppedSystemApp=false
    supportsScreens=[small, medium, large, xlarge, resizeable, anyDensity]
    usesOptionalLibraries:
      androidx.window.extensions
      androidx.window.sidecar
    usesLibraryFiles:
      /system_ext/framework/androidx.window.extensions.jar
      /system_ext/framework/androidx.window.sidecar.jar
    timeStamp=2009-01-01 01:00:00
    lastUpdateTime=2026-11-10 17:07:02
    installerPackageName=null
    installerPackageUid=-1
    initiatingPackageName=null
    originatingPackageName=null
    packageSource=0
    appMetadataFilePath=null
    appMetadataSource=0
    signatures=PackageSignatures{507c6a7 version:3, signatures:[8dbbc65a], past signatures:[]}
    installPermissionsFixed=false
    pkgFlags=[ SYSTEM HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP KILL_AFTER_RESTORE RESTORE_ANY_VERSION ]
    privatePkgFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE_VIA_SDK_VERSION ALLOW_AUDIO_PLAYBACK_CAPTURE BACKUP_IN_FOREGROUND PARTIALLY_DIRECT_BOOT_AWARE PRIVILEGED SYSTEM_EXT PRIVATE_FLAG_ALLOW_NATIVE_HEAP_POINTER_TAGGING ]
    apexModuleName=null
`;

/** `aapt2 dump badging` of the launcher's APK: header, label, and icon lines. */
export const LAUNCHER_BADGING = String.raw`
package: name='com.google.android.apps.nexuslauncher' versionCode='907' versionName='16' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'
minSdkVersion:'36'
targetSdkVersion:'36'
application-label:'Pixel Launcher'
application-label-af:'Pixel-lanseerder'
application-label-am:'ፒክስል ማስጀመሪያ'
application-icon-160:'res/drawable/ic_launcher_home.xml'
application-icon-240:'res/drawable/ic_launcher_home.xml'
application-icon-320:'res/drawable/ic_launcher_home.xml'
application-icon-480:'res/drawable/ic_launcher_home.xml'
application-icon-640:'res/drawable/ic_launcher_home.xml'
application: label='Pixel Launcher' icon='res/drawable/ic_launcher_home.xml'
`;
