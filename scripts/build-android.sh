#!/usr/bin/env bash
# Локальная сборка APK. Нужны: Node 18+, JDK 17, Android SDK (ANDROID_HOME).
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
[ -d android ] || npx cap add android
npx capacitor-assets generate --android
npx cap sync android
(cd android && ./gradlew assembleDebug)
echo "Готово: android/app/build/outputs/apk/debug/app-debug.apk"
