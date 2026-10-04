"""Fengsha adapter for AI-Video-Transcriber's Whisper/VAD workflow (Apache-2.0).
JSON-lines progress is intentionally limited to timestamps and segments. No keys.
"""
import json
import sys
import os

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    options = json.loads(sys.stdin.readline())
    from faster_whisper import WhisperModel
    emit({"stage": "model", "message": "正在加载本地语音模型"})
    model = WhisperModel(options["model"], device="cpu", compute_type="int8",
                         cpu_threads=min(4, os.cpu_count() or 2), local_files_only=True)
    segments, info = model.transcribe(options["file"], language=options.get("language"),
        beam_size=5, vad_filter=True, vad_parameters={"min_silence_duration_ms": 900, "speech_pad_ms": 300},
        no_speech_threshold=0.7, compression_ratio_threshold=2.3, log_prob_threshold=-1.0,
        condition_on_previous_text=False,
        initial_prompt="以下是简体中文的语音转录，保留原话，使用正确的标点。" if options.get("language") == "zh" else None)
    output = []
    for s in segments:
        if s.text.strip():
            output.append({"start": s.start, "end": s.end, "text": s.text.strip()})
            emit({"stage": "speech", "processed": s.end, "duration": info.duration})
    emit({"result": {"text": "\n".join(s["text"] for s in output), "language": info.language, "segments": output}})

try:
    main()
except Exception:
    emit({"error": "本地语音转录失败，请检查语音模型和运行环境后重试"})
    sys.exit(1)
