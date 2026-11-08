#!/usr/bin/env bash
# Сборка неподписанного IPA. Только macOS: нужны Xcode и CocoaPods.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
[ -d ios ] || npx cap add ios
npx capacitor-assets generate --ios
npx cap sync ios
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -archivePath "$PWD/build/App.xcarchive" archive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
rm -rf Payload && mkdir -p Payload
cp -R build/App.xcarchive/Products/Applications/App.app Payload/
zip -qry openboard-unsigned.ipa Payload
echo "Готово: openboard-unsigned.ipa (подпишите через Sideloadly/AltStore или своим сертификатом)"
