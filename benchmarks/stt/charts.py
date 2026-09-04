#!/usr/bin/env python3
import json
import sys
from pathlib import Path

matplotlib = None
plt = None
np = None


def load_plotting() -> None:
    """Load optional rendering dependencies only when charts are requested."""
    global matplotlib, plt, np, COLORS
    try:
        import matplotlib as matplotlib_module
        matplotlib_module.use("Agg")
        import matplotlib.pyplot as pyplot_module
        import numpy as numpy_module
    except ImportError as error:
        print(
            "Chart rendering requires matplotlib and numpy. "
            "Install them for this Python environment before generating charts.",
            file=sys.stderr,
        )
        raise SystemExit(1) from error
    matplotlib = matplotlib_module
    plt = pyplot_module
    np = numpy_module
    tab20 = plt.cm.tab20(np.linspace(0, 1, 20))
    tab20b = plt.cm.tab20b(np.linspace(0, 1, 20))
    COLORS = [matplotlib.colors.to_hex(c) for c in np.vstack((tab20, tab20b))]

CONDITION_LABELS = {
    "test-clean": "English (clean)",
    "test-other": "English (noisy)",
    "es_419": "Spanish",
    "da_dk": "Danish",
    "hu_hu": "Hungarian",
}

CONDITION_FLAGS = {
    "English (clean)": "\U0001f1ec\U0001f1e7",
    "English (noisy)": "\U0001f1ec\U0001f1e7",
    "Spanish": "\U0001f1ea\U0001f1f8",
    "Danish": "\U0001f1e9\U0001f1f0",
    "Hungarian": "\U0001f1ed\U0001f1fa",
}

_flag_cache: dict[str, "np.ndarray"] = {}


def _render_flag(emoji: str) -> "np.ndarray | None":
    if emoji in _flag_cache:
        return _flag_cache[emoji]
    import subprocess, tempfile, os
    from PIL import Image
    tmp = tempfile.mktemp(suffix=".png")
    swift = f'''
import AppKit
let font = NSFont.systemFont(ofSize: 36)
let attrs: [NSAttributedString.Key: Any] = [.font: font]
let str = NSAttributedString(string: "{emoji}", attributes: attrs)
let size = str.size()
let img = NSImage(size: size)
img.lockFocus()
str.draw(at: .zero)
img.unlockFocus()
let tiff = img.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: "{tmp}"))
'''
    try:
        subprocess.run(["swift", "-e", swift], capture_output=True, timeout=10)
        if os.path.exists(tmp):
            img = np.array(Image.open(tmp)) / 255.0
            _flag_cache[emoji] = img
            os.unlink(tmp)
            return img
    except Exception:
        pass
    return None

COLORS = []

DARK_BG = "#1a1a1a"
DARK_FG = "#eeeeee"
DARK_GRID = "#333333"
DARK_LABEL = "#999999"
WINNER_COLOR = "#ffd700"

# The one sentence every surface that shows both products must print, character for
# character. Exported from benchmarks/contract/timing.ts as
# INSTRUMENTATION_ASYMMETRY_LABEL; duplicated here as a literal because this is Python and
# cannot import the constant, and pinned against the TypeScript one by
# `benchmarks/stt/report.test.ts` so the two cannot drift. A paraphrase in one surface is
# how a reader ends up believing the two numbers are the same measurement.
# The canonical field name for the pooled v2 speed summary on a v1-shaped leaf, from
# `benchmarks/contract/v1-leaf.ts::LEAF_SPEED_V2_FIELD`. A bare `speed` is refused by name
# in both repositories: it is the name a v1 field would have had, so it invites a reader to
# treat it as one, and it gives a v3 nowhere to go. Reading the wrong key is how every
# external leaf came back as `{}` and fell through to `meanRTF`.
LEAF_SPEED_V2_FIELD = "speedV2"

INSTRUMENTATION_ASYMMETRY_LABEL = (
    "Response times are not measured the same way for both products: Codictate is timed at "
    "the direct adapter call boundary, Wispr Flow is timed from the UI-observed paste."
)

# One sentence stating what every number on these charts is, because "pooled" is the
# difference between the accuracy of the combined sample and a mean of per-dataset rates.
POOLING_NOTE = (
    "Pooled: accuracy is sum(errors) / sum(references) and speed is "
    "sum(response time) / sum(audio). Never a mean of per-dataset rates."
)


def add_captions(fig, extra: "str | None" = None) -> None:
    """Print the instrumentation-asymmetry label, verbatim, under every chart.

    Every chart, not only the speed ones: a reader who sees an accuracy chart from this
    run beside a published head-to-head needs the same sentence in front of them, and a
    caption that appears on some figures and not others is a caption nobody trusts.
    """
    lines = [INSTRUMENTATION_ASYMMETRY_LABEL, POOLING_NOTE]
    if extra:
        lines.append(extra)
    fig.text(0.5, -0.035, "\n".join(lines), ha="center", va="top",
             fontsize=7, color=DARK_LABEL, wrap=True)


def publishable_wall_rtf(leaf: dict) -> "float | None":
    """The publishable v2 wall-clock RTF for a leaf, or None.

    The Python side of ``benchmarks/contract/v1-leaf.ts::publishableWallRtf``, which this
    file cannot import. Same rule, and the rule is the whole point: **it never falls back
    to ``meanRTF``.**

    This function replaced ``speed.get("wallRtf", r.get("meanRTF"))``. That fallback
    crossed two definitions - ``wallRtf`` is the provenance-filtered v2 response quotient,
    ``meanRTF`` is session wall clock over audio across every scored Sample, playback and
    lead/tail included - so an external Wispr Flow leaf whose summary was absent or whose
    clips all predated the keydown-edge instrumentation silently rendered a legacy number
    in a v2 chart, at 2.8 against Codictate's 0.1.

    A missing value means "no publishable v2 speed". A row with none is drawn empty,
    omitted, or labelled legacy from an explicitly legacy code path - never quietly
    filled in.
    """
    speed = leaf.get(LEAF_SPEED_V2_FIELD)
    if not isinstance(speed, dict):
        return None
    wall_rtf = speed.get("wallRtf")
    if not isinstance(wall_rtf, (int, float)) or isinstance(wall_rtf, bool):
        return None
    if wall_rtf != wall_rtf or wall_rtf in (float("inf"), float("-inf")):
        return None
    return float(wall_rtf)


def poolable_speed_totals(leaf: dict) -> "tuple[float, float] | None":
    """The (responseMs, audioDurationSec) a leaf may contribute to a pooled speed, or None.

    The Python side of ``benchmarks/contract/v1-leaf.ts::poolableSpeedTotals``, and the
    counterpart to ``publishable_wall_rtf``: one says whether a leaf may be *shown*, this
    one whether it may be *added*. ``None`` is exactly the cannot-pool case - no summary,
    no sums, or a zero denominator.

    A leaf that returns ``None`` may still display its own per-condition ``wallRtf``, and
    must **not** be folded into a cross-condition figure by weighting it with
    ``totalAudioSec``. That substitution weights a provenance-filtered numerator by an
    unfiltered denominator - two different sets of Samples - and yields something that
    looks like a pooled speed and is not one. The contract's golden fixture is built so
    the two cannot be confused: 12000 ms over 80 s for the six Samples surviving both
    filters, beside ``totalWallSec 18.5`` / ``totalAudioSec 100`` over all ten scored.
    """
    speed = leaf.get(LEAF_SPEED_V2_FIELD)
    if not isinstance(speed, dict):
        return None
    response_ms = speed.get("responseMs")
    audio = speed.get("audioDurationSec")
    for value in (response_ms, audio):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return None
        if value != value or value in (float("inf"), float("-inf")):
            return None
    # Deliberately *not* rejecting a zero denominator here: the TypeScript accessor
    # returns the sums whenever both are finite, and this has to give the same answer to
    # the same leaf. A present-but-zero denominator adds nothing to either sum, and
    # `pooled_ms_per_audio_sec` returns None for a zero total anyway.
    return float(response_ms), float(audio)


def _leaf_word_errors(r: dict) -> "float | None":
    """A leaf's whole-number word errors, or None when it has no denominator.

    None, never 0. A leaf with no ``referenceWords`` cannot be pooled - the runs written
    before that field existed have no denominator on disk and can never be re-measured -
    and folding one in as zero errors over zero words is a perfect score for a clip nobody
    scored. ``wer * referenceWords`` is the error count for an archived leaf and is always
    a whole number, which is what makes a published rate checkable by eye.
    """
    if r.get("wer") is None or r["wer"] < 0:
        return None
    if r.get("wordErrors") is not None:
        return float(r["wordErrors"])
    refs = r.get("referenceWords")
    if refs is None:
        return None
    # Rounded, because it *is* a whole number: `wer` was `wordErrors / referenceWords`, so
    # the product is the error count and the fraction is float noise. Rounding makes the
    # derived value identical to the exact `wordErrors` a v2 leaf carries, which matters
    # because the two repositories currently write different halves of that pair - one
    # writes the integer, the other only the rate - and two derivations of one number with
    # nothing pinning them is how they drift.
    return float(round(float(r["wer"]) * float(refs)))


def pooled_wer(points: list) -> "tuple[float | None, int]":
    """(rate, skipped) over points, as sum(errors) / sum(references)."""
    errors = 0.0
    refs = 0.0
    skipped = 0
    for p in points:
        e = p.get("word_errors")
        r = p.get("reference_words")
        if e is None or r is None:
            skipped += 1
            continue
        errors += e
        refs += r
    return ((errors / refs) if refs > 0 else None), skipped


def pooled_accuracy_pct(points: list) -> "float | None":
    """Pooled word accuracy as a percentage, or None when nothing could be pooled."""
    rate, _ = pooled_wer(points)
    return None if rate is None else (1 - rate) * 100


def pooled_ms_per_audio_sec(points: list) -> "float | None":
    """Pooled **v2** speed: total response time over total audio, in ms per audio second.

    The fix for defect 8. This used to be ``sum(per-dataset RTFs) / count``, an arithmetic
    mean of ratios, which weights a 5-clip condition exactly like a 900-clip one and is a
    different number from the speed of the combined sample.

    Pools the two sums ``speedV2.responseMs`` and ``speedV2.audioDurationSec`` - the same
    pair ``responseMsPerAudioSec`` and ``wallRtf`` are derived from, and the same pair
    ``report.ts::pooledSpeedForConditions`` pools, with the same inclusion rule: a leaf
    contributes iff its ``speedV2.audioDurationSec`` is above zero. That shared pair and
    shared rule is what makes acceptance gate 11 hold by construction instead of by
    inspection.

    ``None`` when no leaf carries a v2 summary, or when every v2 Sample was withheld for
    want of timing provenance. ``None`` is not an invitation to substitute ``meanRTF``:
    see ``pooled_legacy_ms_per_audio_sec``.
    """
    response_ms = 0.0
    audio = 0.0
    for p in points:
        totals = p.get("poolable_speed")
        if totals is None:
            continue
        response_ms += totals[0]
        audio += totals[1]
    if audio <= 0:
        return None
    return response_ms / audio


def unpoolable_v2_leaves(points: list) -> int:
    """v2 leaves that cannot join a pooled speed, counted so a caption can say so.

    Counted, never weighted. See ``poolable_speed_totals``.
    """
    def contributes(point: dict) -> bool:
        totals = point.get("poolable_speed")
        return totals is not None and totals[1] > 0

    return sum(1 for p in points if p.get("has_v2_speed") and not contributes(p))


def pooled_legacy_ms_per_audio_sec(points: list) -> "tuple[float | None, int]":
    """The **legacy** v1 quotient, over the leaves that carry no v2 summary.

    ``totalWallSec / totalAudioSec``, in ms per audio second, and a *different
    measurement* from the one above: the v1 sums are session wall clock over audio across
    every scored Sample, failures and provenance-less Samples included. Kept because the
    archive has nothing else and old validated data stays displayable - and kept separate,
    because folding it into the v2 ratio pools two definitions under one number.

    Returns the value and how many leaves it covers, so a caption can say so.
    """
    wall = 0.0
    audio = 0.0
    leaves = 0
    for p in points:
        if p.get("has_v2_speed"):
            continue
        seconds = p.get("total_audio_sec")
        if not seconds or seconds <= 0:
            continue
        wall += p.get("total_wall_sec") or 0.0
        audio += seconds
        leaves += 1
    return ((wall / audio * 1000) if audio > 0 else None), leaves


def pooled_speed_exclusions(points: list) -> "tuple[int, int]":
    """(withheld, responded) across the v2 leaves.

    Surfaced because the failure it describes is silent: a bucket whose every Sample lacks
    timing provenance renders as "N/A", which reads as "never measured" rather than
    "measured and withheld".
    """
    withheld = sum(p.get("speed_excluded") or 0 for p in points)
    responded = sum(p.get("responded") or 0 for p in points)
    return withheld, responded


def pooled_inference_rtf(points: list) -> "tuple[float | None, int]":
    """The Codictate-only inference RTF, pooled. A SECONDARY DIAGNOSTIC.

    ``(sum(inferenceMs) / 1000) / sum(inferenceAudioSec)``, from the leaf's own numerator
    and denominator. It used to reconstruct the numerator as ``inferenceRtf *
    total_audio_sec``, which is the wrong denominator: ``inferenceRtf`` was divided by the
    audio of the clips that *reported an inference time*, and ``total_audio_sec`` is the
    audio of the speed-compatible ones. Those differ whenever any Sample has a
    ``responseMs`` and no ``inferenceMs``, and the resulting number is wrong in a way
    nothing downstream disagrees with.

    Leaves without an inference numerator are **skipped**, not counted as zero: the Speech
    Engine Adapter returns a status and a transcript and nothing else (ADR-0006), so there
    is no engine-reported inference duration today and the diagnostic is empty until an
    adapter reports one.

    Never comparable to a Wispr Flow number - a UI-observed paste has no inference
    boundary to measure - and never the headline speed.
    """
    inference_ms = 0.0
    audio = 0.0
    skipped = 0
    for p in points:
        numerator = p.get("inference_ms")
        seconds = p.get("inference_audio_sec")
        if numerator is None or not seconds or seconds <= 0:
            skipped += 1
            continue
        inference_ms += numerator
        audio += seconds
    return ((inference_ms / 1000 / audio) if audio > 0 else None), skipped


def split_variant_key(key: str) -> "tuple[str, str]":
    """Split a flattened row key into (model id, harness label).

    Mirrors parseVariantKey in results-schema.ts. Splitting before naming matters for
    two reasons: title-casing an unsplit key renders the archived rows as
    "Large V3 Turbo Q5_0@Whisper Cli q5_0", and MODEL_SIZES_MB never matches a suffixed
    key, so every archived row silently loses its disk size.
    """
    model_id, sep, suffix = key.rpartition("@")
    if sep and suffix in HARNESS_LABELS:
        return model_id, suffix
    return key, DEFAULT_HARNESS


def model_name(key: str) -> str:
    import re
    model_id, harness = split_variant_key(key)
    parts = []
    # Base name: everything before quant suffix and .en
    base = model_id.replace(".en", "").rstrip("-")
    base = re.sub(r"-?q\d+_\d+$", "", base)
    parts.append(base.replace("-", " ").title())
    # Quant
    q = re.search(r"(q\d+_\d+)", model_id)
    parts.append(q.group(1) if q else "full")
    # English-only
    if ".en" in model_id:
        parts.append("en")
    name = " ".join(parts)
    # Same rule as report.ts modelName: only a non-default Harness is tagged.
    return name if harness == DEFAULT_HARNESS else f"{name} [{harness}]"


MODEL_SIZES_MB = {
    "tiny": 75, "tiny-q5_1": 31, "tiny-q8_0": 42,
    "tiny.en": 75, "tiny.en-q5_1": 31, "tiny.en-q8_0": 42,
    "base": 142, "base-q5_1": 57, "base-q8_0": 78,
    "base.en": 142, "base.en-q5_1": 57, "base.en-q8_0": 78,
    "small": 466, "small-q5_1": 181, "small-q8_0": 252,
    "small.en": 466, "small.en-q5_1": 181, "small.en-q8_0": 252,
    "small.en-tdrz": 465,
    "medium": 1500, "medium-q5_0": 514, "medium-q8_0": 785,
    "medium.en": 1500, "medium.en-q5_0": 514, "medium.en-q8_0": 785,
    "large-v1": 2900, "large-v2": 2900,
    "large-v2-q5_0": 1100, "large-v2-q8_0": 1500,
    "large-v3": 2900, "large-v3-q5_0": 1100,
    "large-v3-turbo": 1500, "large-v3-turbo-q5_0": 574, "large-v3-turbo-q8_0": 834,
    "parakeet-tdt-0.6b-v3": 500,
}


def fmt_size(mb: int) -> str:
    if mb >= 1000:
        return f"{mb / 1000:.1f} GB"
    return f"{mb} MB"


def model_label(key: str) -> str:
    name = model_name(key)
    # Look the size up by Model ID, not by row key: the same weights are the same size
    # whichever Harness transcribed with them.
    size = MODEL_SIZES_MB.get(split_variant_key(key)[0])
    if size:
        return f"{name}\n({fmt_size(size)})"
    return name


def condition_label(key: str) -> str:
    return CONDITION_LABELS.get(key, key)


# Archived ASR Harness labels: every Harness name that may appear as a key in a
# result file, including retired ones. Kept in sync with BENCHMARK_HARNESS_LABELS in
# results-schema.ts, NOT with the runnable ASR_HARNESS_IDS in
# src/shared/asr-harness.ts - dropping a retired label here would make the archived
# whisper-cli buckets unreadable to the chart script.
HARNESS_LABELS = ("crispasr", "whisper-cli")

# The bucket whose rows keep the bare model id. Tracks DEFAULT_HARNESS_LABEL (the
# shipping Harness) so chart labels match report.md row labels.
DEFAULT_HARNESS = "crispasr"

# The Harness that produced files written before Harness was a dimension. A fact about
# the archive, not a default - see PRE_HARNESS_ARCHIVE_LABEL in results-schema.ts.
PRE_HARNESS_ARCHIVE_LABEL = "whisper-cli"

# Speech Models that never ran under any Harness, so they stay in the default bucket
# when a pre-harness file is migrated. Mirrors harnessBucketForModel's Parakeet case.
HARNESS_FREE_MODEL_IDS = ("parakeet-tdt-0.6b-v3",)


def _flatten_dataset(datasets: dict) -> dict:
    """Collapse [dataset][harness][model] into [dataset][key].

    Default-harness results keep the bare model id, so charts of a run under the
    shipping Harness alone look exactly as they did before Harness became a dimension.
    Result files written before that change have no harness level and are read as
    whisper-cli, which is what they were run with.
    """
    flat = {}
    for dataset_key, inner in datasets.items():
        if not isinstance(inner, dict):
            continue
        if inner and all(k in HARNESS_LABELS for k in inner):
            by_harness = inner
        else:
            by_harness = {}
            for model_id, result in (inner or {}).items():
                bucket = (
                    DEFAULT_HARNESS
                    if model_id in HARNESS_FREE_MODEL_IDS
                    else PRE_HARNESS_ARCHIVE_LABEL
                )
                by_harness.setdefault(bucket, {})[model_id] = result
        models = {}
        for harness, by_model in by_harness.items():
            if not isinstance(by_model, dict):
                continue
            for model_id, result in by_model.items():
                key = model_id if harness == DEFAULT_HARNESS else f"{model_id}@{harness}"
                models[key] = result
        flat[dataset_key] = models
    return flat


def flatten_harnesses(results: dict) -> dict:
    return {
        **results,
        "librispeech": _flatten_dataset(results.get("librispeech", {})),
        "fleurs": _flatten_dataset(results.get("fleurs", {})),
    }


def _point(model: str, condition: str, r: dict) -> dict:
    """One leaf as a chart point, carrying the sums every pooled figure needs.

    The counts travel with the rate on purpose. A rate cannot be pooled without the
    denominator it was divided by, and every chart below that combines conditions has to
    pool - so a point that carried only ``wer`` and ``meanRTF`` left the chart code no
    option but the mean of means it used to draw.

    The v2 and the legacy speed inputs are separate keys and are never merged. There used
    to be one key filled by ``speed.get("wallRtf", r.get("meanRTF"))``, and that fallback
    crossed two definitions: ``wallRtf`` is the provenance-filtered v2 ratio over the
    successful, speed-compatible Samples, and ``meanRTF`` is session wall clock over
    audio across every scored Sample. For an external Wispr Flow leaf whose clips all
    predate the keydown-edge instrumentation, ``wallRtf`` is correctly ``None`` - there is
    no publishable v2 speed - and ``meanRTF`` is many times larger, so the fallback plotted
    the wrong product's number as if it were comparable to Codictate's.
    """
    speed = r.get(LEAF_SPEED_V2_FIELD)
    has_v2 = isinstance(speed, dict)
    if not has_v2 and isinstance(r.get("speed"), dict):
        # Refused by name, and said out loud. A leaf that wrote its v2 summary under
        # `speed` is not a leaf without one - reading it as such is what sent every
        # external row down the `meanRTF` fallback and plotted a legacy number in a v2
        # chart. Silence here is the failure mode.
        print(
            f"[charts] {model}/{condition}: v2 speed summary is under `speed`, not "
            f"`{LEAF_SPEED_V2_FIELD}`; it is ignored rather than read as a v2 summary. "
            f"Rewrite the leaf with the canonical field name.",
            file=sys.stderr,
        )
    speed = speed if has_v2 else {}
    return {
        "model": model,
        "condition": condition,
        "wer": r["wer"],
        "word_errors": _leaf_word_errors(r),
        "reference_words": r.get("referenceWords"),
        "cer": r.get("cer"),
        # -- v2 speed: the only inputs a published speed may come from --
        "has_v2_speed": has_v2,
        "wall_rtf": publishable_wall_rtf(r),
        # The contract's cannot-pool decision, made once. `None` here means this leaf may
        # show its own `wall_rtf` and may not be added to a cross-condition figure.
        "poolable_speed": poolable_speed_totals(r),
        "attempted": speed.get("attemptedCount"),
        "responded": speed.get("respondedCount"),
        "speed_excluded": speed.get("speedExcludedCount"),
        # -- the inference diagnostic's own numerator and denominator --
        # Never `total_audio_sec`: that is the *speed-compatible* audio, a different set of
        # clips whenever a Sample reports a `responseMs` and no `inferenceMs`.
        "inference_ms": speed.get("inferenceMs"),
        "inference_audio_sec": speed.get("inferenceAudioSec"),
        # -- legacy v1 sums, for the archived leaves that carry nothing else --
        "total_audio_sec": r.get("totalAudioSec"),
        "total_wall_sec": r.get("totalWallSec") or 0.0,
    }


def extract_data(results: dict) -> list[dict]:
    points = []
    for dataset, models in results.get("librispeech", {}).items():
        for model, r in models.items():
            if r["wer"] < 0:
                continue
            points.append(_point(model, condition_label(dataset), r))
    for lang, models in results.get("fleurs", {}).items():
        for model, r in models.items():
            if r["wer"] < 0:
                continue
            points.append(_point(model, condition_label(lang), r))
    return points


def extract_cer_data(results: dict) -> list[dict]:
    points = []
    for lang, models in results.get("fleurs", {}).items():
        for model, r in models.items():
            cer = r.get("cer")
            if cer is None or cer < 0:
                continue
            points.append({
                "model": model,
                "condition": condition_label(lang),
                "cer": cer,
            })
    return points


def style_ax(ax: "plt.Axes") -> None:
    ax.set_facecolor(DARK_BG)
    ax.tick_params(colors=DARK_LABEL, which="both")
    for spine in ax.spines.values():
        spine.set_color(DARK_GRID)
    ax.xaxis.label.set_color(DARK_FG)
    ax.yaxis.label.set_color(DARK_FG)
    ax.title.set_color(DARK_FG)


def generate_accuracy_bar(results: dict, out_path: Path) -> None:
    points = extract_data(results)
    if not points:
        return

    conditions = list(dict.fromkeys(p["condition"] for p in points))
    models = list(dict.fromkeys(p["model"] for p in points))

    y = np.arange(len(models))
    bar_height = 0.9 / max(len(conditions), 1)

    fig_h = max(10, len(models) * 1.4)
    fig, ax = plt.subplots(figsize=(14, fig_h))
    fig.set_facecolor(DARK_BG)
    style_ax(ax)

    has_negative = False
    for ci, cond in enumerate(conditions):
        accs = []
        for model in models:
            match = [p for p in points if p["model"] == model and p["condition"] == cond]
            raw = (1 - match[0]["wer"]) * 100 if match else 0
            if raw < 0:
                has_negative = True
            accs.append(max(raw, 0))
        best = max(accs)
        offset = (ci - len(conditions) / 2 + 0.5) * bar_height
        bars = ax.barh(y + offset, accs, bar_height * 0.9, label=cond,
                       color=COLORS[ci % len(COLORS)], zorder=3)
        for bar, val in zip(bars, accs):
            if val > 0:
                is_best = val == best and val > 0
                label_x = max(bar.get_width() + 0.3, 6)
                ax.text(label_x, bar.get_y() + bar.get_height() / 2,
                        f"{val:.1f}%", va="center", ha="left",
                        fontsize=11,
                        color=WINNER_COLOR if is_best else DARK_LABEL,
                        fontweight="bold" if is_best else "normal",
                        zorder=4)

    ax.set_xlabel("Accuracy %", labelpad=4)
    ax.set_title("Accuracy by Model and Condition", fontweight="bold", pad=12)
    ax.set_yticks(y)
    ax.set_yticklabels([model_label(m) for m in models], fontsize=11)
    ax.grid(axis="x", color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)
    ax.invert_yaxis()

    from matplotlib.offsetbox import OffsetImage, AnnotationBbox

    ax.legend(facecolor="#2a2a2a", edgecolor=DARK_GRID, labelcolor=DARK_FG,
              fontsize=8, bbox_to_anchor=(0, -0.04), loc="upper left",
              borderaxespad=0, ncol=len(conditions), framealpha=0.9,
              handlelength=1.2, handletextpad=0.4, columnspacing=1.5)
    if has_negative:
        fig.text(0.5, -0.005, "* Negative accuracy values (WER > 100%) clamped to 0%",
                 ha="center", fontsize=7, color=DARK_LABEL)

    fig.tight_layout()
    fig.subplots_adjust(left=0.18)

    from matplotlib.transforms import blended_transform_factory
    flag_trans = blended_transform_factory(ax.transAxes, ax.transData)
    flag_ystep = 0.18
    for mi, model in enumerate(models):
        flag_conds = [c for c in conditions if CONDITION_FLAGS.get(c)]
        total = len(flag_conds)
        for idx, cond in enumerate(flag_conds):
            flag_emoji = CONDITION_FLAGS[cond]
            flag_img = _render_flag(flag_emoji)
            if flag_img is None:
                continue
            has_data = any(p for p in points
                          if p["model"] == model and p["condition"] == cond
                          and (1 - p["wer"]) * 100 > 0)
            fy = mi + (idx - (total - 1) / 2) * flag_ystep
            im = OffsetImage(flag_img, zoom=0.3, alpha=1.0 if has_data else 0.2)
            ab = AnnotationBbox(im, (0.015, fy), frameon=False,
                                xycoords=flag_trans, box_alignment=(0.5, 0.5),
                                zorder=10, clip_on=False)
            ax.add_artist(ab)
            if cond == "English (noisy)" and has_data:
                ax.annotate("(noisy)", xy=(0.03, fy),
                            xycoords=flag_trans, fontsize=7,
                            fontweight="normal", color="#000000",
                            ha="left", va="center",
                            annotation_clip=False)

    add_captions(fig)
    fig.savefig(str(out_path), dpi=150, facecolor=DARK_BG,
                bbox_inches="tight", pad_inches=0.3)
    plt.close(fig)
    print(f"Chart: {out_path}")


def model_family(model_id: str) -> str:
    import re
    return re.sub(r"-?q\d+_\d+$", "", model_id)


def generate_speed_bar(results: dict, out_path: Path) -> None:
    points = extract_data(results)
    if not points:
        return

    models = list(dict.fromkeys(p["model"] for p in points))

    # Pooled, not averaged, and never across definitions. `sum(per-dataset RTF) / count`
    # weights a 5-clip condition like a 900-clip one; this is
    # `sum(speedV2.responseMs) / sum(speedV2.audioDurationSec)` over the same pair the
    # report pools, with the same inclusion rule, so the chart and report.md cannot print
    # two speeds. A row with no publishable v2 speed falls back to the **legacy** v1
    # quotient and is labelled `[legacy]` - it is never silently substituted, because
    # `meanRTF` is a different measurement.
    avg_speeds = []
    legacy_rows = []
    for model in models:
        model_points = [p for p in points if p["model"] == model]
        pooled = pooled_ms_per_audio_sec(model_points)
        if pooled is not None:
            avg_speeds.append(pooled)
            continue
        legacy, _leaves = pooled_legacy_ms_per_audio_sec(model_points)
        avg_speeds.append(legacy if legacy is not None else 0)
        if legacy is not None:
            legacy_rows.append(model)

    notes = []
    withheld, responded = pooled_speed_exclusions(points)
    if withheld:
        notes.append(
            f"{withheld} of {responded} responded Samples withheld from pooled speed for "
            f"want of timing provenance; they still count as attempted and their words "
            f"still count in the pooled WER."
        )
    unpoolable = unpoolable_v2_leaves(points)
    if unpoolable:
        notes.append(
            f"{unpoolable} v2 leaf/leaves carry no poolable speed sums and are excluded "
            f"from the pooled figure rather than weighted by their unfiltered audio; "
            f"their own per-condition wallRtf is unaffected."
        )
    if legacy_rows:
        notes.append(
            f"{len(legacy_rows)} row(s) marked [legacy] have no speedV2 and are shown as "
            f"the v1 wall-clock quotient, which is a different measurement (session wall "
            f"clock over audio, all scored Samples) and is not comparable to the rest."
        )

    # The secondary diagnostic, printed as a caption rather than as a second bar: it is
    # not the headline speed and must never sit in the same column as the wall-clock one.
    inference_rtf, inference_skipped = pooled_inference_rtf(points)
    if inference_rtf is not None:
        notes.append(
            f"Secondary diagnostic (Codictate only, not comparable to any UI-observed "
            f"number): pooled inference RTF {inference_rtf:.3f}"
            f"{f', {inference_skipped} leaf/leaves skipped for want of overhead.inferenceMs' if inference_skipped else ''}."
        )
    else:
        notes.append(
            "Secondary inference RTF: no leaf reports overhead.inferenceMs, so the "
            "diagnostic is empty. Skipped, not zero."
        )
    inference_note = " ".join(notes)

    families = list(dict.fromkeys(model_family(m) for m in models))
    family_colors = {f: COLORS[i % len(COLORS)] for i, f in enumerate(families)}
    bar_colors = [family_colors[model_family(m)] for m in models]

    y = np.arange(len(models))
    bar_height = 0.7

    fig_h = max(10, len(models) * 1.4)
    fig, ax = plt.subplots(figsize=(14, fig_h))
    fig.set_facecolor(DARK_BG)
    style_ax(ax)

    positive_speeds = [s for s in avg_speeds if s > 0]
    best_speed = min(positive_speeds) if positive_speeds else -1

    bars = ax.barh(y, avg_speeds, bar_height, color=bar_colors, zorder=3)
    for bar, val in zip(bars, avg_speeds):
        if val > 0:
            is_best = val == best_speed
            ax.text(bar.get_width() + 0.3, bar.get_y() + bar.get_height() / 2,
                    f"{val:.0f} ms", va="center", ha="left",
                    fontsize=11,
                    color=WINNER_COLOR if is_best else DARK_LABEL,
                    fontweight="bold" if is_best else "normal",
                    zorder=4)

    ax.set_xlabel("Transcribe Time (ms / sec audio) - lower is better", labelpad=4)
    ax.set_title("Speed by Model (pooled: total response time / total audio)",
                 fontweight="bold", pad=12)
    ax.set_yticks(y)
    ax.set_yticklabels(
        [
            f"{model_label(m)}\n[legacy]" if m in legacy_rows else model_label(m)
            for m in models
        ],
        fontsize=11,
    )
    ax.grid(axis="x", color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)
    ax.invert_yaxis()

    fig.tight_layout()
    add_captions(fig, inference_note)
    fig.savefig(str(out_path), dpi=150, facecolor=DARK_BG, bbox_inches="tight")
    plt.close(fig)
    print(f"Chart: {out_path}")


def _category_points(model_points: list, category: str, english_keys: set) -> list:
    """The points one summary category pools over.

    Split out because two places in the averages chart ask the same question - the bars
    and the per-row indicators - and they used to answer it with two copies of the same
    slicing, which is how one of them could keep averaging after the other was pooled.
    """
    if category.endswith("English"):
        return [p for p in model_points if p["condition"] in english_keys]
    if category.endswith("Multilingual"):
        return [p for p in model_points if p["condition"] not in english_keys]
    return model_points


def generate_averages_bar(results: dict, out_path: Path) -> None:
    points = extract_data(results)
    if not points:
        return

    models = list(dict.fromkeys(p["model"] for p in points))

    english_keys = {"English (clean)", "English (noisy)"}
    categories = ["Pooled Overall", "Pooled English", "Pooled Multilingual"]

    y = np.arange(len(models))
    bar_height = 0.9 / max(len(categories), 1)

    fig_h = max(10, len(models) * 1.4)
    fig, ax = plt.subplots(figsize=(14, fig_h))
    fig.set_facecolor(DARK_BG)
    style_ax(ax)

    has_negative = False
    for ci, cat in enumerate(categories):
        vals = []
        for model in models:
            model_points = [p for p in points if p["model"] == model]
            # Pooled, not a mean of per-condition accuracies. Defect 9 on the chart side:
            # the mean weights a 47-clip archived condition exactly like a 397-clip one.
            raw = pooled_accuracy_pct(_category_points(model_points, cat, english_keys))
            if raw is None:
                # No leaf in this category carried a denominator, so there is nothing to
                # pool. Drawn as a zero-length bar and labelled by the caption, never as
                # a 0% accuracy claim.
                vals.append(0)
                continue
            if raw < 0:
                has_negative = True
            vals.append(max(raw, 0))

        best = max(vals)
        offset = (ci - len(categories) / 2 + 0.5) * bar_height
        bars = ax.barh(y + offset, vals, bar_height * 0.9, label=cat,
                       color=COLORS[ci % len(COLORS)], zorder=3)
        for bar, val in zip(bars, vals):
            if val > 0:
                is_best = val == best and val > 0
                label_x = max(bar.get_width() + 0.3, 6)
                ax.text(label_x, bar.get_y() + bar.get_height() / 2,
                        f"{val:.1f}%", va="center", ha="left",
                        fontsize=11,
                        color=WINNER_COLOR if is_best else DARK_LABEL,
                        fontweight="bold" if is_best else "normal",
                        zorder=4)

    ax.set_xlabel("Accuracy %", labelpad=4)
    ax.set_title("Pooled Accuracy by Category", fontweight="bold", pad=12)
    ax.set_yticks(y)
    ax.set_yticklabels([model_label(m) for m in models], fontsize=11)
    ax.legend(facecolor="#2a2a2a", edgecolor=DARK_GRID, labelcolor=DARK_FG, fontsize=8,
              bbox_to_anchor=(0, -0.04), loc="upper left", borderaxespad=0,
              ncol=len(categories), framealpha=0.9, handlelength=1.2,
              handletextpad=0.4, columnspacing=1.0)
    ax.grid(axis="x", color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)
    ax.invert_yaxis()
    if has_negative:
        fig.text(0.5, -0.005, "* Negative accuracy values (WER > 100%) clamped to 0%",
                 ha="center", fontsize=7, color=DARK_LABEL)

    fig.tight_layout()
    fig.subplots_adjust(left=0.18)

    from matplotlib.offsetbox import OffsetImage, AnnotationBbox
    from matplotlib.transforms import blended_transform_factory
    flag_trans = blended_transform_factory(ax.transAxes, ax.transData)
    avg_indicators = [
        ("Pooled Overall", None, "(overall)"),
        ("Pooled English", "\U0001f1ec\U0001f1e7", None),
        ("Pooled Multilingual", "\U0001f30d", None),
    ]
    flag_ystep = 0.30
    for mi, model in enumerate(models):
        model_points = [p for p in points if p["model"] == model]
        total = len(avg_indicators)

        for idx, (cat, emoji, text_label) in enumerate(avg_indicators):
            raw = pooled_accuracy_pct(
                _category_points(model_points, cat, english_keys)
            )
            has_val = raw is not None and raw > 0
            fy = mi + (idx - (total - 1) / 2) * flag_ystep
            if text_label:
                ax.annotate(text_label, xy=(0.035, fy),
                            xycoords=flag_trans, fontsize=12,
                            color="#FFFFFF" if has_val else "#555555",
                            ha="center", va="center",
                            annotation_clip=False)
            elif emoji:
                flag_img = _render_flag(emoji)
                if flag_img is None:
                    continue
                im = OffsetImage(flag_img, zoom=0.3, alpha=1.0 if has_val else 0.2)
                ab = AnnotationBbox(im, (0.015, fy), frameon=False,
                                    xycoords=flag_trans, box_alignment=(0.5, 0.5),
                                    zorder=10, clip_on=False)
                ax.add_artist(ab)

    add_captions(fig)
    fig.savefig(str(out_path), dpi=150, facecolor=DARK_BG,
                bbox_inches="tight", pad_inches=0.3)
    plt.close(fig)
    print(f"Chart: {out_path}")


def generate_cer_bar(results: dict, out_path: Path) -> None:
    points = extract_cer_data(results)
    if not points:
        return

    conditions = list(dict.fromkeys(p["condition"] for p in points))
    models = list(dict.fromkeys(p["model"] for p in points))

    y = np.arange(len(models))
    bar_height = 0.9 / max(len(conditions), 1)

    fig_h = max(10, len(models) * 1.4)
    fig, ax = plt.subplots(figsize=(14, fig_h))
    fig.set_facecolor(DARK_BG)
    style_ax(ax)

    for ci, cond in enumerate(conditions):
        accs = []
        for model in models:
            match = [p for p in points if p["model"] == model and p["condition"] == cond]
            raw = (1 - match[0]["cer"]) * 100 if match else 0
            accs.append(max(raw, 0))
        best = max(accs)
        offset = (ci - len(conditions) / 2 + 0.5) * bar_height
        bars = ax.barh(y + offset, accs, bar_height * 0.9, label=cond,
                       color=COLORS[ci % len(COLORS)], zorder=3)
        for bar, val in zip(bars, accs):
            if val > 0:
                is_best = val == best and val > 0
                label_x = max(bar.get_width() + 0.3, 6)
                ax.text(label_x, bar.get_y() + bar.get_height() / 2,
                        f"{val:.1f}%", va="center", ha="left",
                        fontsize=11,
                        color=WINNER_COLOR if is_best else DARK_LABEL,
                        fontweight="bold" if is_best else "normal",
                        zorder=4)

    ax.set_xlabel("Character Accuracy % (case & punctuation sensitive)", labelpad=4)
    ax.set_title("Character Accuracy by Model (FLEURS)", fontweight="bold", pad=12)
    ax.set_yticks(y)
    ax.set_yticklabels([model_label(m) for m in models], fontsize=11)
    ax.grid(axis="x", color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)
    ax.invert_yaxis()

    ax.legend(facecolor="#2a2a2a", edgecolor=DARK_GRID, labelcolor=DARK_FG,
              fontsize=8, bbox_to_anchor=(0, -0.04), loc="upper left",
              borderaxespad=0, ncol=len(conditions), framealpha=0.9,
              handlelength=1.2, handletextpad=0.4, columnspacing=1.5)

    fig.tight_layout()
    fig.subplots_adjust(left=0.18)
    add_captions(fig)
    fig.savefig(str(out_path), dpi=150, facecolor=DARK_BG,
                bbox_inches="tight", pad_inches=0.3)
    plt.close(fig)
    print(f"Chart: {out_path}")


CHUNK_SIZE = 8


def chunk_list(lst: list, size: int) -> list[list]:
    return [lst[i:i + size] for i in range(0, len(lst), size)]


def filter_results(results: dict, model_subset: set[str]) -> dict:
    filtered = {**results}
    filtered["librispeech"] = {}
    for key, models in results.get("librispeech", {}).items():
        filtered["librispeech"][key] = {m: r for m, r in models.items() if m in model_subset}
    filtered["fleurs"] = {}
    for key, models in results.get("fleurs", {}).items():
        filtered["fleurs"][key] = {m: r for m, r in models.items() if m in model_subset}
    return filtered


def get_all_models(results: dict) -> list[str]:
    points = extract_data(results)
    return list(dict.fromkeys(p["model"] for p in points))


def self_check() -> None:
    """Assert the pooling arithmetic, in the file that does it. `charts.py --self-check`.

    There is no Python test runner in this repository, and the arithmetic these charts
    publish is exactly the arithmetic that was wrong: a mean of per-dataset rates is a
    plausible number that is not the rate of the combined sample. So the assertions live
    beside the functions and run on demand (`bun run bench:charts:check`), on fixtures
    chosen so that every wrong formula gives a *different* answer from the right one -
    a fixture where two formulas coincide tests nothing.
    """
    # One 1000-word condition at 1% WER and one 10-word condition at 90% WER, and - the
    # part that discriminates - an inference denominator that is deliberately NOT the
    # speed denominator on the first leaf: 100 s of inference audio against 400 s of
    # speed-compatible audio.
    unbalanced = [
        {"model": "m", "condition": "Danish", "wer": 0.01,
         "word_errors": 10.0, "reference_words": 1000,
         "has_v2_speed": True, "wall_rtf": 0.1,
         "poolable_speed": (40_000.0, 400.0),
         "responded": 100, "speed_excluded": 0,
         "inference_ms": 20_000.0, "inference_audio_sec": 100.0,
         "total_audio_sec": 400.0, "total_wall_sec": 600.0},
        {"model": "m", "condition": "Hungarian", "wer": 0.9,
         "word_errors": 9.0, "reference_words": 10,
         "has_v2_speed": True, "wall_rtf": 0.5,
         "poolable_speed": (5_000.0, 10.0),
         "responded": 10, "speed_excluded": 0,
         "inference_ms": 5_000.0, "inference_audio_sec": 10.0,
         "total_audio_sec": 10.0, "total_wall_sec": 30.0},
    ]
    rate, skipped = pooled_wer(unbalanced)
    assert skipped == 0, skipped
    assert abs(rate - 19 / 1010) < 1e-12, rate
    mean_of_means = (0.01 + 0.9) / 2
    assert abs(mean_of_means - 0.455) < 1e-12, mean_of_means
    # 1.88% pooled against 45.5% averaged. Not a rounding difference.
    assert abs(rate - mean_of_means) > 0.4, (rate, mean_of_means)
    assert abs(pooled_accuracy_pct(unbalanced) - (1 - 19 / 1010) * 100) < 1e-9

    # Pooled v2 speed: 45 s of response over 410 s of audio, not the mean of 100 and 500.
    speed = pooled_ms_per_audio_sec(unbalanced)
    assert abs(speed - 45_000 / 410) < 1e-9, speed
    mean_speed = (0.1 * 1000 + 0.5 * 1000) / 2
    assert abs(mean_speed - 300.0) < 1e-9, mean_speed
    assert abs(speed - mean_speed) > 190, (speed, mean_speed)

    # The inference diagnostic uses ITS OWN denominator. Correct: 25 s over 110 s.
    # The old formula reconstructed the numerator as `inferenceRtf * total_audio_sec`,
    # which is 0.2*400 + 0.5*10 = 85 s over 410 s. Both are plausible; only one is right.
    diag_rtf, diag_skipped = pooled_inference_rtf(unbalanced)
    assert diag_skipped == 0, diag_skipped
    assert abs(diag_rtf - 25 / 110) < 1e-12, diag_rtf
    wrong_denominator = (0.2 * 400 + 0.5 * 10) / (400 + 10)
    assert abs(diag_rtf - wrong_denominator) > 0.01, (diag_rtf, wrong_denominator)

    # A leaf with no denominator is skipped, never zero.
    no_denominator = [
        {"model": "m", "condition": "Danish", "wer": 0.2,
         "word_errors": None, "reference_words": None,
         "has_v2_speed": False, "wall_rtf": None,
         "poolable_speed": None,
         "inference_ms": None, "inference_audio_sec": None,
         "total_audio_sec": None, "total_wall_sec": 0.0},
    ]
    rate, skipped = pooled_wer(no_denominator)
    assert rate is None and skipped == 1, (rate, skipped)
    assert pooled_accuracy_pct(no_denominator) is None
    assert pooled_ms_per_audio_sec(no_denominator) is None
    assert pooled_legacy_ms_per_audio_sec(no_denominator) == (None, 0)

    # A sentinel leaf (Speech Model absent from disk) yields no error count.
    assert _leaf_word_errors({"wer": -1, "referenceWords": 10}) is None
    # An archived leaf's error count is `wer * referenceWords`, and it is a WHOLE number:
    # the derived value has to equal the integer a v2 leaf carries, not a float beside it.
    derived = _leaf_word_errors({"wer": 1 / 3, "referenceWords": 3})
    assert derived == 1.0 and float(derived).is_integer(), derived
    assert _leaf_word_errors({"wer": 0.05, "referenceWords": 200}) == 10.0
    assert _leaf_word_errors({"wer": 0.05, "referenceWords": 200, "wordErrors": 10}) == 10.0

    # NO CROSS-DEFINITION FALLBACK. A leaf with a v2 summary whose `wallRtf` is None has
    # no publishable speed, and its `meanRTF` is a different measurement. This is the
    # external Wispr Flow case: all clips legacy, so `wallRtf: None` and `meanRTF: 1.5`.
    all_legacy_clips = [
        {"model": "flow", "condition": "Danish", "wer": 0.1,
         "word_errors": 10.0, "reference_words": 100,
         "has_v2_speed": True, "wall_rtf": None,
         "poolable_speed": None,
         "responded": 4, "speed_excluded": 4,
         "inference_ms": None, "inference_audio_sec": None,
         "total_audio_sec": 20.0, "total_wall_sec": 30.0},
    ]
    assert pooled_ms_per_audio_sec(all_legacy_clips) is None
    # And it does not leak in through the legacy path either: the leaf HAS a v2 summary,
    # so its v1 sums are not the archive's, and mixing them would publish 1500 ms.
    assert pooled_legacy_ms_per_audio_sec(all_legacy_clips) == (None, 0)
    # What the operator sees instead: the exclusion count, out loud.
    assert pooled_speed_exclusions(all_legacy_clips) == (4, 4)

    # An archived leaf with no v2 summary at all is still displayable, as legacy.
    archived = [
        {"model": "large-v3-q5_0", "condition": "Danish", "wer": 0.12,
         "word_errors": 120.0, "reference_words": 1000,
         "has_v2_speed": False, "wall_rtf": None,
         "poolable_speed": None,
         "inference_ms": None, "inference_audio_sec": None,
         "total_audio_sec": 100.0, "total_wall_sec": 20.0},
    ]
    assert pooled_ms_per_audio_sec(archived) is None
    legacy, leaves = pooled_legacy_ms_per_audio_sec(archived)
    assert abs(legacy - 200.0) < 1e-9 and leaves == 1, (legacy, leaves)

    # The pooling accessor: `None` is exactly the cannot-pool case, and a leaf that
    # returns it must never be folded in by weighting `wallRtf` with `totalAudioSec`.
    assert poolable_speed_totals(
        {"speedV2": {"responseMs": 12_000.0, "audioDurationSec": 80.0}}
    ) == (12_000.0, 80.0)
    assert poolable_speed_totals({"speedV2": {"wallRtf": 0.15}}) is None
    # A present-but-zero denominator is returned, not rejected: the TypeScript accessor
    # does the same, and the two have to agree leaf for leaf. It contributes nothing.
    assert poolable_speed_totals(
        {"speedV2": {"responseMs": 0.0, "audioDurationSec": 0.0}}
    ) == (0.0, 0.0)
    assert poolable_speed_totals({"speed": {"responseMs": 1.0, "audioDurationSec": 1.0}}) is None
    assert poolable_speed_totals({"meanRTF": 1.5}) is None
    # The golden fixture's own trap: the filtered sums (12000 ms / 80 s = 150 ms/s) and
    # the legacy totals (18.5 s / 100 s = 185 ms/s) are different numbers, so no fixture
    # can be used to argue that reaching for `totalAudioSec` as a weight is harmless.
    filtered = 12_000.0 / 80.0
    legacy_weighted = 18.5 / 100.0 * 1000
    assert abs(filtered - legacy_weighted) > 30, (filtered, legacy_weighted)

    # A leaf with no poolable sums is counted, not weighted.
    mixed = [
        {"model": "m", "condition": "Danish", "has_v2_speed": True,
         "poolable_speed": (12_000.0, 80.0), "total_audio_sec": 100.0,
         "total_wall_sec": 18.5, "speed_excluded": 0, "responded": 6},
        {"model": "m", "condition": "Hungarian", "has_v2_speed": True,
         "poolable_speed": (0.0, 0.0), "total_audio_sec": 500.0,
         "total_wall_sec": 900.0, "speed_excluded": 0, "responded": 2},
    ]
    assert unpoolable_v2_leaves(mixed) == 1
    assert abs(pooled_ms_per_audio_sec(mixed) - 150.0) < 1e-9, pooled_ms_per_audio_sec(mixed)
    # The leaf without sums also does not leak in through the legacy path: it HAS a v2
    # summary, so its v1 sums are not the archive's.
    assert pooled_legacy_ms_per_audio_sec(mixed) == (None, 0)

    # The accessor never falls back, and reads only the canonical field name.
    assert LEAF_SPEED_V2_FIELD == "speedV2"
    assert publishable_wall_rtf({"speedV2": {"wallRtf": 0.1}, "meanRTF": 1.5}) == 0.1
    # `None` on the summary means "nothing publishable" - not "use meanRTF".
    assert publishable_wall_rtf({"speedV2": {"wallRtf": None}, "meanRTF": 1.5}) is None
    # No summary at all: still not meanRTF.
    assert publishable_wall_rtf({"meanRTF": 1.5}) is None
    # A summary under the wrong key is not a summary.
    assert publishable_wall_rtf({"speed": {"wallRtf": 0.1}, "meanRTF": 1.5}) is None
    # Non-finite is not a speed.
    assert publishable_wall_rtf({"speedV2": {"wallRtf": float("nan")}}) is None
    assert publishable_wall_rtf({"speedV2": {"wallRtf": float("inf")}}) is None

    # The asymmetry label, character for character. `report.test.ts` pins this literal
    # against INSTRUMENTATION_ASYMMETRY_LABEL in benchmarks/contract/timing.ts.
    assert INSTRUMENTATION_ASYMMETRY_LABEL.startswith(
        "Response times are not measured the same way for both products:"
    )
    assert INSTRUMENTATION_ASYMMETRY_LABEL.endswith("UI-observed paste.")

    print("charts.py self-check: pooling arithmetic OK")


def main() -> None:
    if "--self-check" in sys.argv:
        self_check()
        return

    if len(sys.argv) < 2:
        print("Usage: charts.py <results-dir> | charts.py --self-check", file=sys.stderr)
        sys.exit(1)

    load_plotting()

    results_dir = Path(sys.argv[1])
    no_chunks = "--no-chunks" in sys.argv
    json_path = results_dir / "stt.json"

    if not json_path.exists():
        print(f"No results at {json_path}", file=sys.stderr)
        sys.exit(1)

    with open(json_path) as f:
        results = flatten_harnesses(json.load(f))

    # Full charts (all models)
    generate_accuracy_bar(results, results_dir / "accuracy-comparison.png")
    generate_speed_bar(results, results_dir / "speed-comparison.png")
    generate_averages_bar(results, results_dir / "accuracy-averages.png")
    generate_cer_bar(results, results_dir / "cer-comparison.png")

    # Chunked charts
    all_models = get_all_models(results)
    if not no_chunks and len(all_models) > CHUNK_SIZE:
        chunks = chunk_list(all_models, CHUNK_SIZE)
        for ci, chunk in enumerate(chunks, 1):
            subset = set(chunk)
            filtered = filter_results(results, subset)
            generate_accuracy_bar(filtered, results_dir / f"accuracy-comparison-{ci}.png")
            generate_speed_bar(filtered, results_dir / f"speed-comparison-{ci}.png")
            generate_averages_bar(filtered, results_dir / f"accuracy-averages-{ci}.png")
            generate_cer_bar(filtered, results_dir / f"cer-comparison-{ci}.png")


if __name__ == "__main__":
    main()
