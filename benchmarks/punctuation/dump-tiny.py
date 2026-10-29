# ekko-v1-tiny (parakeet.cpp Q5_0 via ekko-stt 0.1.2) raw output on the same 927 clips as hviske.jsonl.
import json, os, sys, time
from ekko.artifacts import ensure_hub_artifact
from ekko.runtime import TinyBackend
R = __import__("pathlib").Path(__file__).resolve().parents[1].as_posix() + "/datasets/"
clips = [json.loads(l) for l in open(sys.argv[1])]
out = sys.argv[2]
done = {json.loads(l)["clipId"] for l in open(out)} if os.path.exists(out) else set()
with TinyBackend(ensure_hub_artifact("tiny")) as b, open(out, "a") as f:
    for i, c in enumerate(clips):
        if c["clipId"] in done: continue
        t = time.perf_counter()
        try: hyp, st = b.transcribe(R + c["clipId"]).text, "ok"
        except Exception as e: hyp, st = "", "failed: %s" % e
        f.write(json.dumps({"clipId": c["clipId"], "ref": c["ref"], "refNorm": c["refNorm"], "hyp": hyp, "status": st, "ms": (time.perf_counter()-t)*1000}, ensure_ascii=False) + "\n"); f.flush()
