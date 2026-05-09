#!/usr/bin/env python3
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

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

_TAB20 = plt.cm.tab20(np.linspace(0, 1, 20))
_TAB20B = plt.cm.tab20b(np.linspace(0, 1, 20))
COLORS = [matplotlib.colors.to_hex(c) for c in np.vstack((_TAB20, _TAB20B))]

DARK_BG = "#1a1a1a"
DARK_FG = "#eeeeee"
DARK_GRID = "#333333"
DARK_LABEL = "#999999"
WINNER_COLOR = "#ffd700"


def model_name(model_id: str) -> str:
    import re
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
    return " ".join(parts)


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


def model_label(model_id: str) -> str:
    name = model_name(model_id)
    size = MODEL_SIZES_MB.get(model_id)
    if size:
        return f"{name}\n({fmt_size(size)})"
    return name


def condition_label(key: str) -> str:
    return CONDITION_LABELS.get(key, key)


def extract_data(results: dict) -> list[dict]:
    points = []
    for dataset, models in results.get("librispeech", {}).items():
        for model, r in models.items():
            if r["wer"] < 0:
                continue
            points.append({
                "model": model,
                "condition": condition_label(dataset),
                "wer": r["wer"],
                "rtf": r["meanRTF"],
            })
    for lang, models in results.get("fleurs", {}).items():
        for model, r in models.items():
            if r["wer"] < 0:
                continue
            points.append({
                "model": model,
                "condition": condition_label(lang),
                "wer": r["wer"],
                "rtf": r["meanRTF"],
            })
    return points


def style_ax(ax: plt.Axes) -> None:
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

    avg_speeds = []
    for model in models:
        rtfs = [p["rtf"] for p in points if p["model"] == model]
        avg_speeds.append(sum(rtfs) / len(rtfs) * 1000 if rtfs else 0)

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
    ax.set_title("Speed by Model", fontweight="bold", pad=12)
    ax.set_yticks(y)
    ax.set_yticklabels([model_label(m) for m in models], fontsize=11)
    ax.grid(axis="x", color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)
    ax.invert_yaxis()

    fig.tight_layout()
    fig.savefig(str(out_path), dpi=150, facecolor=DARK_BG, bbox_inches="tight")
    plt.close(fig)
    print(f"Chart: {out_path}")


def generate_averages_bar(results: dict, out_path: Path) -> None:
    points = extract_data(results)
    if not points:
        return

    models = list(dict.fromkeys(p["model"] for p in points))

    english_keys = {"English (clean)", "English (noisy)"}
    categories = ["Avg Overall", "Avg English", "Avg Multilingual"]

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
            if cat == "Avg English":
                accs = [(1 - p["wer"]) * 100 for p in model_points if p["condition"] in english_keys]
            elif cat == "Avg Multilingual":
                accs = [(1 - p["wer"]) * 100 for p in model_points if p["condition"] not in english_keys]
            else:
                accs = [(1 - p["wer"]) * 100 for p in model_points]
            raw = sum(accs) / len(accs) if accs else 0
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
    ax.set_title("Average Accuracy by Category", fontweight="bold", pad=12)
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
        ("Avg Overall", None, "(overall)"),
        ("Avg English", "\U0001f1ec\U0001f1e7", None),
        ("Avg Multilingual", "\U0001f30d", None),
    ]
    flag_ystep = 0.30
    for mi, model in enumerate(models):
        model_points = [p for p in points if p["model"] == model]
        total = len(avg_indicators)
        def avg_acc(subset):
            accs = [(1 - p["wer"]) * 100 for p in subset]
            return sum(accs) / len(accs) if accs else 0

        for idx, (cat, emoji, text_label) in enumerate(avg_indicators):
            if cat == "Avg English":
                raw = avg_acc([p for p in model_points if p["condition"] in english_keys])
            elif cat == "Avg Multilingual":
                raw = avg_acc([p for p in model_points if p["condition"] not in english_keys])
            else:
                raw = avg_acc(model_points)
            has_val = raw > 0
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


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: charts.py <results-dir>", file=sys.stderr)
        sys.exit(1)

    results_dir = Path(sys.argv[1])
    no_chunks = "--no-chunks" in sys.argv
    json_path = results_dir / "stt.json"

    if not json_path.exists():
        print(f"No results at {json_path}", file=sys.stderr)
        sys.exit(1)

    with open(json_path) as f:
        results = json.load(f)

    # Full charts (all models)
    generate_accuracy_bar(results, results_dir / "accuracy-comparison.png")
    generate_speed_bar(results, results_dir / "speed-comparison.png")
    generate_averages_bar(results, results_dir / "accuracy-averages.png")

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


if __name__ == "__main__":
    main()
