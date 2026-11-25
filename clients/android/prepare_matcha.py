"""Prepare the Android runtime and the same bilingual model used by Turnline Web."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest
from pathlib import Path
from shutil import copyfile, copyfileobj, rmtree
from tempfile import TemporaryDirectory
from urllib.request import urlopen
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from turnline.pronunciation import build_lexicon
from turnline.setup_models import (
    ASSETS, ENGLISH_LEXICON, MATCHA, MATCHA_MODEL, MATCHA_VOCODER, MODELS, RELEASES, install,
)

SHERPA_VERSION = "2.0.3"
SHERPA_DIGEST = "7744a3a8f08f017d59c2d8ed8d9b700345561f5abe9f4e06dc6eaef3a0b977b4"


def prepare_runtime(aar):
    if aar.is_file():
        with aar.open("rb") as source:
            if file_digest(source, "sha256").hexdigest() == SHERPA_DIGEST:
                return
    aar.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=aar.parent) as directory:
        temporary = Path(directory) / aar.name
        url = f"{RELEASES}v{SHERPA_VERSION}/sherpa-onnx-static-link-onnxruntime-{SHERPA_VERSION}.aar"
        print(f"Downloading sherpa-onnx {SHERPA_VERSION} for Android", flush=True)
        with urlopen(url, timeout=60) as source, temporary.open("wb") as output:
            copyfileobj(source, output, length=1024 * 1024)
        with temporary.open("rb") as source:
            if file_digest(source, "sha256").hexdigest() != SHERPA_DIGEST:
                raise ValueError("SHA-256 mismatch: sherpa-onnx Android runtime")
        temporary.replace(aar)


def prepare_assets(assets):
    model = MODELS / MATCHA
    assets.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=assets.parent) as directory:
        stage = Path(directory) / MATCHA
        stage.mkdir()
        for name in (MATCHA_MODEL, "tokens.txt", "phone-zh.fst", "date-zh.fst", "number-zh.fst", "README.md"):
            copyfile(model / name, stage / name)
        copyfile(MODELS / MATCHA_VOCODER, stage / MATCHA_VOCODER)
        words = build_lexicon(stage / "lexicon.txt", model / "lexicon.txt", MODELS / ENGLISH_LEXICON, model / "tokens.txt")
        (stage / "english-words.txt").write_text("\n".join(sorted(words)) + "\n", encoding="utf-8")
        destination = assets / MATCHA
        if destination.exists():
            rmtree(destination)
        stage.replace(destination)


if __name__ == "__main__":
    aar_path, assets_path = map(Path, sys.argv[1:])
    MODELS.mkdir(exist_ok=True)
    with ThreadPoolExecutor() as pool:
        runtime = pool.submit(prepare_runtime, aar_path)
        list(pool.map(install, (asset for asset in ASSETS if asset[2] in (MATCHA, MATCHA_VOCODER, ENGLISH_LEXICON))))
        prepare_assets(assets_path)
        runtime.result()
