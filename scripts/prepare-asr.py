"""Prepare self-contained Windows CPU speech runtime. No external account data."""
import pathlib
import shutil
import urllib.request
import zipfile
import subprocess
import sys
import json
import argparse

parser = argparse.ArgumentParser(description='Prepare Windows CPU speech runtime and base/small models.')
parser.add_argument('--offline', action='store_true', help='Use existing runtime, packages and local model cache only.')
options = parser.parse_args()

root = pathlib.Path(__file__).resolve().parents[1]
runtime = root / 'bin/asr/runtime'
runtime.mkdir(parents=True, exist_ok=True)
archive = root / 'output/reference/python-3.12.10-embed-amd64.zip'
if not (runtime / 'python.exe').exists():
    if options.offline:
        raise SystemExit('Offline preparation requires an existing bin/asr/runtime/python.exe.')
    archive.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', archive)
    with zipfile.ZipFile(archive) as z:
        z.extractall(runtime)
(runtime / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
target = runtime / 'Lib/site-packages'
if not (target / 'faster_whisper').exists():
    if options.offline:
        raise SystemExit('Offline preparation requires existing speech packages in bin/asr/runtime/Lib/site-packages.')
    if sys.version_info[:2] != (3, 12):
        raise SystemExit('Please run this preparation script with Python 3.12 (Windows x64).')
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:', '--no-compile', '--target', str(target), 'faster-whisper==1.2.1', 'av==15.1.0'], check=True)
from huggingface_hub import snapshot_download
models = root / 'bin/asr/models'
for name in ['base', 'small']:
    destination = models / name
    if (destination / 'model.bin').exists():
        continue
    cache = snapshot_download('Systran/faster-whisper-' + name, local_files_only=options.offline)
    destination.mkdir(parents=True, exist_ok=True)
    for file in pathlib.Path(cache).iterdir():
        if file.is_file():
            shutil.copyfile(file, destination / file.name)
subprocess.run([str(runtime / 'python.exe'), '-c', 'import faster_whisper, ctranslate2; print("ASR runtime ready")'], check=True)
print(json.dumps({'runtime': str(runtime), 'models': ['base', 'small']}))
