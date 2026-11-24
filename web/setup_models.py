"""Download and verify the local speech models."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
import shutil
import tarfile

from pronunciation import ENGLISH_LEXICON

MODELS = Path(__file__).resolve().parent / "models"
RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
SENSE_VOICE = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
MATCHA = "matcha-icefall-zh-en"
MATCHA_MODEL = "model-steps-3.onnx"
MATCHA_VOCODER = "vocos-16khz-univ.onnx"
SILERO = "silero_vad.onnx"

ASSETS = (
    ("asr-models", SENSE_VOICE + ".tar.bz2", SENSE_VOICE, "model.int8.onnx",
     "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"),
    ("asr-models", SILERO, SILERO, None,
     "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"),
    ("tts-models", MATCHA + ".tar.bz2", MATCHA, MATCHA_MODEL,
     "271b804af570400d3bcdcb53bf6e53cc9f75180ee763b9f13eb2b0d086ef"),
    ("tts-models", ENGLISH_LEXICON, ENGLISH_LEXICON, None,
     "8b67ae549a465eee78f92ecb74644ad90c3c58ce65f19c68baf85878a10ef73a"),
    ("vocoder-models", MATCHA_VOCODER, MATCHA_VOCODER, None,
     "b599142a1fb8ff03de3e84ac35ff537c619e56f4267a6fe894851a42844acf9e"),
)


def install(asset):
    tag, filename, destination, check_file, expected_digest = asset
    target = MODELS / destination
    check = target / check_file if check_file else target
    if check.is_file() and check.stat().st_size:
        return

    print(f"Downloading {filename}", flush=True)
    with TemporaryDirectory(prefix=".download-", dir=MODELS) as path:
        stage = Path(path)
        download = stage / filename
        request = Request(RELEASES + tag + "/" + filename, headers={"User-Agent": "Turnline model setup"})
        with urlopen(request, timeout=60) as response, download.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        with download.open("rb") as source:
            if file_digest(source, "sha256").hexdigest() != expected_digest:
                raise ValueError(f"SHA-256 mismatch: {filename}")

        if check_file:
            with tarfile.open(download, "r:bz2") as archive:
                archive.extractall(stage, filter="data")
            extracted = stage / destination
            if not (extracted / check_file).is_file():
                raise ValueError(f"Missing {check_file} in {filename}")
            extracted.replace(target)
        else:
            download.replace(target)


def main():
    MODELS.mkdir(exist_ok=True)
    with ThreadPoolExecutor() as pool:
        list(pool.map(install, (asset for asset in ASSETS if asset[2] != ENGLISH_LEXICON)))
    print(f"Voice models are ready in {MODELS}")


if __name__ == "__main__":
    main()
