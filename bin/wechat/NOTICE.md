# Video channel worker included in this application

This application includes only download-link.cjs and decrypt.cjs copied from the
local Fengsha video learning reference project. No proxy, certificate, capture
server, mitmproxy, Lux, account database or user configuration is included here.

- decrypt.cjs originates from putyy/res-downloader, commit
  f8ac4d9c85baf28322106e40ea3fdea9867e2f74, Apache-2.0.
  https://github.com/putyy/res-downloader
  The CommonJS adaptation and readiness promise come from the reference project.
  See LICENSE-res-downloader.txt.
- The separately implemented share-link resolver follows Tencent Yuanbao's
  protocol as documented in ltaoo/wx_channels_download, commit
  124f044235bc706fe796c043a14ff442a150ae5d, MIT with Commons Clause.
  https://github.com/ltaoo/wx_channels_download
  See LICENSE-ltaoo.txt.

The user signs into an isolated official Yuanbao session in this application.
Signed media URLs and media header keys are passed only over private worker IPC.
The worker performs complete FFmpeg decoding before returning success. Access
rights, source availability, login expiry and platform changes still apply.