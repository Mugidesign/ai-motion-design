"""
oss-video-server — a minimal FastAPI wrapper around Wan2.1 (T2V-1.3B by
default) that implements the small job-based HTTP contract expected by
workers/mcp-servers/motion-generator/src/providers/oss-selfhosted.ts:

    POST /generate           -> {"job_id": "..."}
    GET  /status/{job_id}    -> {"status": "queued|processing|succeeded|failed", ...}

Designed to run on a free GPU tier — Lightning AI Studios (T4/L4/A10G,
~80 free GPU-hours/month as of this writing) is what docs/06-oss-free-stack.md
and README.md in this folder walk through, but any machine with an NVIDIA
GPU and 8GB+ VRAM works the same way.

WHY WAN2.1 T2V-1.3B AS THE DEFAULT: of the current open-weight video
models, it has by far the lowest VRAM floor (~8GB fp16, ~4-6GB with GGUF
quantization) while still producing usable output, so it's the one most
likely to "just work" on whatever free GPU you're handed. Wan2.1/2.2 14B
and HunyuanVideo (1.5 especially) produce higher quality but need
12-24GB+ depending on quantization — swap MODEL_ID and the pipeline class
below if your GPU has the headroom. See the model-swap notes at the
bottom of this file.

VERIFY BEFORE RELYING ON THIS: the exact diffusers `WanPipeline` API may
have moved since this was written — check
https://huggingface.co/docs/diffusers/main/en/api/pipelines/wan for the
current signature and required package versions before deploying. This
is a reference implementation to adapt, not a guaranteed-working install.
"""

import os
import threading
import uuid
from pathlib import Path
from typing import Optional

import torch
from diffusers import WanPipeline
from diffusers.utils import export_to_video
from fastapi import FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

APP_API_KEY = os.environ.get("OSS_VIDEO_API_KEY")  # optional shared secret — set the same value as OSS_VIDEO_API_KEY in .env
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/tmp/oss-video-output"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Swap for "Wan-AI/Wan2.1-T2V-14B-Diffusers" (needs ~24GB+ or GGUF
# quantization) if your GPU has more headroom and you want higher quality.
MODEL_ID = os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")
FPS = 16

app = FastAPI(title="oss-video-server")

_pipe: Optional[WanPipeline] = None
_pipe_lock = threading.Lock()


def get_pipeline() -> WanPipeline:
    """Loads the model on first request rather than at import time, so
    `uvicorn --reload` and health checks don't pay the (multi-GB) load cost
    before anything actually needs the GPU."""
    global _pipe
    with _pipe_lock:
        if _pipe is None:
            _pipe = WanPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
            _pipe.to("cuda")
        return _pipe


# In-memory job store — fine for a single-replica free-tier Studio. If you
# ever run more than one instance behind a load balancer, move this to
# Postgres (you already have one — packages/db) or Redis/Valkey instead.
_jobs: dict[str, dict] = {}


class GenerateRequest(BaseModel):
    prompt: str
    image_url: Optional[str] = None
    duration_seconds: float = 5.0
    resolution: str = "480p"  # "480p" or "720p" — 720p needs meaningfully more VRAM/time


def _check_auth(authorization: Optional[str]) -> None:
    if APP_API_KEY and authorization != f"Bearer {APP_API_KEY}":
        raise HTTPException(status_code=401, detail="invalid or missing API key")


def _run_generation(job_id: str, req: GenerateRequest) -> None:
    try:
        _jobs[job_id]["status"] = "processing"
        pipe = get_pipeline()

        height, width = (480, 832) if req.resolution == "480p" else (720, 1280)
        # Wan2.1's 1.3B checkpoint is commonly used up to ~5s (81 frames at
        # 16fps) in community workflows — verify the current recommended
        # cap for your chosen checkpoint; going far beyond it may degrade
        # quality or exceed VRAM even on the 1.3B model.
        num_frames = min(int(req.duration_seconds * FPS), 81)

        result = pipe(
            prompt=req.prompt,
            height=height,
            width=width,
            num_frames=num_frames,
            guidance_scale=5.0,
        )
        frames = result.frames[0]

        out_path = OUTPUT_DIR / f"{job_id}.mp4"
        export_to_video(frames, str(out_path), fps=FPS)

        _jobs[job_id].update(
            status="succeeded",
            output_url=f"/files/{job_id}.mp4",
            duration_seconds=num_frames / FPS,
        )
    except Exception as exc:  # noqa: BLE001 — deliberately broad: this runs in a background thread with no other error surface
        _jobs[job_id].update(status="failed", error=str(exc))


@app.post("/generate")
def generate(req: GenerateRequest, authorization: Optional[str] = Header(None)):
    _check_auth(authorization)
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "queued"}
    threading.Thread(target=_run_generation, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id}


@app.get("/status/{job_id}")
def status(job_id: str, authorization: Optional[str] = Header(None)):
    _check_auth(authorization)
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "cuda_available": torch.cuda.is_available()}


# Serves generated clips directly off local disk — fine for development
# and demos. For anything long-lived, have _run_generation upload to R2
# (docs/02's asset storage) and return that URL instead, since a free-tier
# Studio's disk and uptime aren't durable.
app.mount("/files", StaticFiles(directory=str(OUTPUT_DIR)), name="files")

# ---------------------------------------------------------------------------
# Model swap notes:
#
# HunyuanVideo 1.5 (higher quality, needs ~16GB+, ~12GB with text-encoder
# offload): swap the import/pipeline for whatever class Tencent's current
# HunyuanVideo 1.5 release ships (check the model card on Hugging Face —
# it may not use the same diffusers pipeline class as Wan).
#
# Wan2.1/2.2 14B (higher quality than 1.3B, needs ~24GB fp8 or ~6-12GB
# with GGUF + CPU offload via community tools like ComfyUI-WanVideoWrapper
# or ianstormtaylor/Wan2GP): set WAN_MODEL_ID to the 14B checkpoint and
# confirm your GPU tier's VRAM before switching — see
# docs/06-oss-free-stack.md for the current feasibility notes against
# Lightning AI's free T4/L4/A10G Studios.
# ---------------------------------------------------------------------------
