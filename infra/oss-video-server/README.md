# oss-video-server — Wan2.1 on a free GPU tier

Runs `server.py` (Wan2.1 T2V-1.3B by default) behind a small HTTP API that
`motion-generator-mcp`'s `oss-selfhosted` provider talks to. This is what
lets `AI Motion Design Factory` produce **real** video output at $0 in
compute cost, instead of only the `mock` provider's placeholder.

## Is this actually feasible on a free tier? (short answer: yes, with caveats)

| Model | VRAM needed | Fits free-tier GPUs? |
|---|---|---|
| Wan2.1 T2V-1.3B (default here) | ~8GB fp16, ~4-6GB GGUF-quantized | T4 (16GB) / L4 (24GB) / A10G (24GB) — comfortably |
| Wan2.1/2.2 14B, FP8 | ~24GB | L4 / A10G — tight but workable; T4 (16GB) — no |
| Wan2.1/2.2 14B, GGUF + CPU offload | ~6-12GB | T4 / L4 / A10G — yes, slower |
| HunyuanVideo (original, 13B) | ~24-60GB depending on quantization | L4/A10G at best with aggressive quantization; risky |
| HunyuanVideo 1.5 (8.3B) | ~16GB recommended, ~12GB with offload | T4 (tight) / L4 / A10G — comfortably |

Lightning AI's free plan (as of this writing) gives **~80 GPU-hours per
month** across T4/L4/A10G/L40S Studios, with the free Studio auto-restarting
every 4 hours. That is genuinely enough for **development, demos, and
low-volume real usage** — it is **not** enough to run a production SaaS
generating hundreds of client videos a month. Budget accordingly: either
stay within the free allowance for dev/staging and pay for real GPU time
(Lightning's paid tiers, RunPod, Modal, or your own hardware) once you have
paying tenants, or keep `mock`/a commercial API (`runway`, `kling`, ...) as
the production default and use this only for prototyping. Lightning AI's
free-tier terms, GPU menu, and even the platform's ownership have changed
before and may change again — confirm current numbers at lightning.ai
before you build a cost model around them.

## Setup on Lightning AI Studios

1. Create a Lightning AI account and start a new Studio, selecting a GPU
   (T4 is the safe default for the 1.3B model; pick L4/A10G if you plan to
   try the 14B or HunyuanVideo 1.5 later).
2. In the Studio terminal:
   ```bash
   pip install -r requirements.txt
   export OSS_VIDEO_API_KEY="pick-a-shared-secret"   # optional but recommended
   uvicorn server:app --host 0.0.0.0 --port 8000
   ```
3. Expose port 8000 to get a public URL — Lightning AI Studios support
   exposing a running port as an HTTPS endpoint; the exact button/command
   has moved around their UI before, so check Lightning's current docs
   (Studios -> Networking/Ports) rather than relying on steps written here.
4. Set the resulting URL as `OSS_VIDEO_ENDPOINT_URL` and your chosen secret
   as `OSS_VIDEO_API_KEY` in the root `.env` (see `.env.example`), and set
   `MOTION_GENERATOR_DEFAULT_PROVIDER=oss-selfhosted` in
   `workers/mcp-servers/motion-generator/wrangler.jsonc` (or pass
   `preferredProvider: "oss-selfhosted"` per request).
5. Remember the free Studio restarts every 4 hours — for anything beyond
   demos, either restart `uvicorn` on a schedule or expect occasional
   failed jobs that the `motion-designer` agent's retry policy
   (docs/03 §3.1) will catch and retry.

## Local test without Cloudflare in the loop

```bash
curl -X POST http://localhost:8000/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OSS_VIDEO_API_KEY" \
  -d '{"prompt": "A cat walking through a sunlit garden, cinematic lighting", "duration_seconds": 5, "resolution": "480p"}'
# -> {"job_id": "..."}

curl http://localhost:8000/status/<job_id> -H "Authorization: Bearer $OSS_VIDEO_API_KEY"
```

## Known rough edges in this scaffold

- Single in-memory job store — restarting the server loses in-flight job
  status (finished files on disk are unaffected). Fine for one Studio;
  move to Postgres if you run more than one instance.
- Generated files are served straight off local disk. For anything you
  want to survive a Studio restart, push to R2 at the end of
  `_run_generation` and return that URL instead — R2 is already the asset
  store for the rest of the platform (docs/02).
- No queueing/concurrency limit — a burst of requests will try to run
  multiple generations on one GPU at once and likely OOM. Add a simple
  semaphore around `get_pipeline()` calls if you expect concurrent load.
