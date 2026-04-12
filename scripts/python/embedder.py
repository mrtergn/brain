#!/usr/bin/env python3

import json
import logging
import os
import sys
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
MODEL_NAME = "all-MiniLM-L6-v2"
MODEL_CACHE = ROOT / "data" / "cache" / "models"


def configure_environment() -> None:
    MODEL_CACHE.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(MODEL_CACHE))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(MODEL_CACHE))
    os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(MODEL_CACHE))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    logging.getLogger().setLevel(logging.ERROR)


def load_model():
    configure_environment()
    from huggingface_hub import logging as hf_logging  # type: ignore
    from sentence_transformers import SentenceTransformer  # type: ignore
    from transformers.utils import logging as transformers_logging  # type: ignore

    hf_logging.set_verbosity_error()
    transformers_logging.set_verbosity_error()
    sink = StringIO()
    with redirect_stdout(sink), redirect_stderr(sink):
        return SentenceTransformer(MODEL_NAME, cache_folder=str(MODEL_CACHE), device="cpu")


def encode_texts(model, texts: list[str], batch_size: int = 32) -> list[list[float]]:
    if not texts:
        return []
    embeddings = model.encode(
        texts,
        batch_size=max(1, batch_size),
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    return embeddings.tolist()


def parse_one_shot_payload(argv: list[str]) -> tuple[list[str], int]:
    if len(argv) > 1 and argv[1] != "--server":
        return argv[1:], 32

    raw_payload = sys.stdin.read().strip()
    if not raw_payload:
        return [], 32

    payload = json.loads(raw_payload)
    if isinstance(payload, list):
        return [str(item) for item in payload], 32

    texts = payload.get("texts", [])
    batch_size = int(payload.get("batchSize", 32))
    return [str(item) for item in texts], batch_size


def run_server() -> int:
    try:
        model = load_model()
    except Exception as error:
        sys.stdout.write(json.dumps({"id": "startup", "ok": False, "error": str(error)}) + "\n")
        sys.stdout.flush()
        return 1

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        payload: dict[str, Any] | None = None
        try:
            payload = json.loads(line)
            request_id = str(payload.get("id", "unknown"))
            texts = [str(item) for item in payload.get("texts", [])]
            batch_size = int(payload.get("batchSize", 32))
            embeddings = encode_texts(model, texts, batch_size=batch_size)
            response = {
                "id": request_id,
                "ok": True,
                "model": MODEL_NAME,
                "dimensions": len(embeddings[0]) if embeddings else 384,
                "embeddings": embeddings,
            }
        except Exception as error:
            response = {
                "id": str(payload.get("id", "unknown")) if payload else "unknown",
                "ok": False,
                "error": str(error),
            }
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    return 0


def run_one_shot(argv: list[str]) -> int:
    try:
        model = load_model()
        texts, batch_size = parse_one_shot_payload(argv)
        embeddings = encode_texts(model, texts, batch_size=batch_size)
        sys.stdout.write(json.dumps(embeddings))
        return 0
    except Exception as error:
        sys.stderr.write(f"embedder error: {error}\n")
        return 1


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "--server":
        return run_server()
    return run_one_shot(argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))