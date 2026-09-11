#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
sdk=${ANDROID_HOME:?}; bt="$sdk/build-tools/36.0.0"; jar="$sdk/platforms/android-35/android.jar"
mkdir -p animation/build/classes animation/build/dex
javac -source 8 -target 8 -classpath "$jar" -d animation/build/classes animation/*.java
"$bt/d8" --lib "$jar" --output animation/build/dex animation/build/classes/dev/expo/gpupoc/*.class
"$bt/aapt" package -f -M animation/AndroidManifest.xml -I "$jar" -F animation/build/unsigned.apk
(cd animation/build/dex; "$bt/aapt" add ../unsigned.apk classes.dex)
if [[ ! -f animation/build/debug.jks ]]; then
  keytool -genkeypair -keystore animation/build/debug.jks -storepass android -keypass android \
    -alias debug -dname 'CN=GPU Capture Experiment' -keyalg RSA -validity 3650
fi
"$bt/zipalign" -f 4 animation/build/unsigned.apk animation/build/aligned.apk
"$bt/apksigner" sign --ks animation/build/debug.jks --ks-pass pass:android \
  --out animation/build/animation.apk animation/build/aligned.apk
