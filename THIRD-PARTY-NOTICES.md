# 第三方组件

风沙全平台视频下载器是独立本机桌面应用，下载工具以独立进程运行。

## yt-dlp
来源：https://github.com/yt-dlp/yt-dlp 。源码为 Unlicense；官方 PyInstaller 二进制包含 GPLv3+ 等独立组件。保留官方第三方许可说明与下载校验记录，不能把源码的 Unlicense 当成全部二进制许可。

## FFmpeg / ffprobe
复制自本机旧参考项目的独立官方构建，版本 N-126314-g3386acd2f9-20260829。来源：https://github.com/yt-dlp/FFmpeg-Builds 。该构建启用 GPL，实际许可证随 bin 提供。构建源码：https://github.com/FFmpeg/FFmpeg/commit/3386acd2f9 ，构建方案：https://github.com/yt-dlp/FFmpeg-Builds 。没有把它链接进应用。

## Node.js
独立运行环境 v22.22.3；官方来源：https://nodejs.org/download/release/v22.22.3/ 。完整 LICENSE 在 bin/node/LICENSE。

## 视频号
请求协议参考 ltaoo/wx_channels_download 的腾讯元宝接口与旧风沙视频学习台实现；上游 MIT 附 Commons Clause，完整通知保存在 bin/wechat/LICENSE-ltaoo.txt。媒体头处理 worker 源于旧项目，decoder 源于 putyy/res-downloader（Apache-2.0），完整许可与固定来源记录在 bin/wechat。仅使用用户授权的官方会话，不复制旧软件凭据。

## 应用依赖
Electron（MIT）、React（MIT）、lucide（ISC）、SQL.js（MIT）、Zod（MIT）、Vite（MIT）、electron-builder（MIT）保留各包许可证。本次按用户授权将项目源代码与说明提交到指定私有仓库；安装包、大型工具二进制、语音运行时、模型和用户资料不进入 Git。

## 视频 / 播客转录与摘要

中文字形转换使用 OpenCC-JS 1.0.5（MIT），来源 https://github.com/nk2028/opencc-js ，随应用依赖保留 LICENSE。转换仅用于中文识别结果和中文校正文案，不依赖在线服务，不改变原音视频或导入文本。

参考 https://github.com/wendy7756/AI-Video-Transcriber ，版本 634e6a2207f54efa9874fd7cb58aea06e2a49e92，Apache-2.0。本项目重新实现 Electron 任务、加密模型配置、React 页面和本地归档，转录 worker 按本机 JSON-lines 协议适配其 Whisper、VAD 与无语音保护思路。原许可证在 bin/asr/LICENSE-AI-Video-Transcriber.txt；未引入上游浏览器 localStorage 保存密钥的实现。

随安装包提供 Python 3.12.10（PSF，许可证在 bin/asr/runtime/LICENSE.txt）、Faster-Whisper 1.2.1（MIT）、CTranslate2（MIT）、PyAV 15.1.0（BSD，附 FFmpeg 许可）、ONNX Runtime（MIT）等运行库。各 wheel 许可证保留在 bin/asr/runtime/Lib/site-packages 的 dist-info 目录；使用 base / small 模型，来源 https://huggingface.co/Systran/faster-whisper-base 与 https://huggingface.co/Systran/faster-whisper-small （Whisper MIT）。运行时仅使用本机 CPU，不要求另行配置 GPU。

视频号作者列表 API 客户端依据 https://github.com/ltaoo/wx_channels_download 的原视频详情、作者发布列表、分享链接与在线状态接口编写。0.3.1 在 bin/collector 内置其官方 v260907 独立进程，下载来源 https://github.com/ltaoo/wx_channels_download/releases/tag/v260907 ，可执行文件 SHA256 为 26a99c72dc1873982671426af2b60a20ceef9f7bb31e47fb7db42f94de45a818。完整 MIT + Commons Clause 许可在 bin/collector/LICENSE；涉及销售或商业分发须另行核对并取得所需授权。本工具自己实现按任务连接与 Windows 恢复守护；0.3.4 起用户本机版本按任务自动临时切换证书与代理。证书和组件用户数据在本机首次准备时生成，不随安装包提供其他软件的证书、私钥或账号资料。

## 本项目许可与仓库范围

package.json 当前声明 UNLICENSED，仓库上传不表示本项目已采用某个开源许可证。各第三方组件仍适用各自许可证。源码仓库保留 worker、许可证与来源说明；外部二进制、运行时和模型按安装部署文档从相应上游获取。历史验收文档中的“本次未对外发布”指对应历史交付。

0.4.0 的完整 Windows 安装包另通过用户指定私有仓库的 GitHub Release 提供，其中包含下载工具、语音运行时、模型和上述第三方许可证。它们不进入 Git 源码历史。本次发布不改变本项目或第三方许可，不表示已取得商业销售或商业分发授权。
