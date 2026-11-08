@echo off
rem Локальная сборка APK на Windows. Нужны: Node 18+, JDK 17, Android SDK (ANDROID_HOME).
cd /d "%~dp0\.."
call npm install || exit /b 1
if not exist android call npx cap add android || exit /b 1
call npx capacitor-assets generate --android || exit /b 1
call npx cap sync android || exit /b 1
cd android
call gradlew.bat assembleDebug || exit /b 1
echo Готово: android\app\build\outputs\apk\debug\app-debug.apk
