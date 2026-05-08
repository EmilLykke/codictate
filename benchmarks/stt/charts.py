#!/usr/bin/env python3
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

MODEL_NAMES = {
    "small-q5_1": "Whisper Small",
    "large-v3-turbo-q5_0": "Whisper Large Turbo",
    "large-v3-q5_0": "Whisper Large",
    "parakeet-tdt-0.6b-v3": "Parakeet 0.6B",
}

CONDITION_LABELS = {
    "test-clean": "English (clean)",
    "test-other": "English (noisy)",
    "es_419": "Spanish",
    "da_dk": "Danish",
    "hu_hu": "Hungarian",
}

COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948"]

DARK_BG = "#1a1a1a"
DARK_FG = "#eeeeee"
DARK_GRID = "#333333"
DARK_LABEL = "#999999"


def model_name(model_id: str) -> str:
    return MODEL_NAMES.get(model_id, model_id)


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

    x = np.arange(len(conditions))
    bar_width = 0.8 / max(len(models), 1)

    fig, ax = plt.subplots(figsize=(max(8, len(conditions) * 2.5), 5))
    fig.set_facecolor(DARK_BG)
    style_ax(ax)

    for i, model in enumerate(models):
        accs = []
        has_data = []
        for cond in conditions:
            match = [p for p in points if p["model"] == model and p["condition"] == cond]
            accs.append((1 - match[0]["wer"]) * 100 if match else 0)
            has_data.append(bool(match))
        offset = (i - len(models) / 2 + 0.5) * bar_width
        bars = ax.bar(x + offset, accs, bar_width * 0.9, label=model_name(model),
                       color=COLORS[i % len(COLORS)], zorder=3)
        for bar, a, present in zip(bars, accs, has_data):
            if present:
                ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.15,
                        f"{a:.1f}%", ha="center", va="bottom", fontsize=8, color=DARK_LABEL)

    ax.set_ylabel("Accuracy %")
    ax.set_title("Accuracy by Model and Condition", fontweight="bold", pad=12)
    ax.set_xticks(x)
    ax.set_xticklabels(conditions, rotation=20, ha="right", fontsize=9)
    ax.legend(facecolor="#2a2a2a", edgecolor=DARK_GRID, labelcolor=DARK_FG, fontsize=9)
    ax.grid(axis="y", color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)

    fig.tight_layout()
    fig.savefig(str(out_path), dpi=150, facecolor=DARK_BG)
    plt.close(fig)
    print(f"Chart: {out_path}")


def generate_scatter(results: dict, out_path: Path) -> None:
    points = extract_data(results)
    if not points:
        return

    models = list(dict.fromkeys(p["model"] for p in points))
    conditions = list(dict.fromkeys(p["condition"] for p in points))
    markers = ["o", "s", "D", "^", "v", "p"]

    fig, ax = plt.subplots(figsize=(10, 6))
    fig.set_facecolor(DARK_BG)
    style_ax(ax)

    plotted_models = set()

    for p in points:
        mi = models.index(p["model"])
        ci = conditions.index(p["condition"])
        color = COLORS[mi % len(COLORS)]
        marker = markers[ci % len(markers)]
        accuracy = (1 - p["wer"]) * 100
        speed_ms = p["rtf"] * 1000

        ax.scatter(speed_ms, accuracy, c=color, marker=marker, s=100,
                   zorder=3, alpha=0.85, edgecolors="none")

        if p["model"] not in plotted_models:
            ax.scatter([], [], c=color, marker="o", s=60, label=model_name(p["model"]))
            plotted_models.add(p["model"])

    for ci, cond in enumerate(conditions):
        ax.scatter([], [], c=DARK_LABEL, marker=markers[ci % len(markers)], s=60, label=cond)

    ax.set_xlabel("Transcribe Time (ms / sec audio) - lower is better")
    ax.set_ylabel("Accuracy % - higher is better")
    ax.set_title("Accuracy vs Speed", fontweight="bold", pad=12)
    ax.legend(facecolor="#2a2a2a", edgecolor=DARK_GRID, labelcolor=DARK_FG, fontsize=9,
              bbox_to_anchor=(1.02, 1), loc="upper left", borderaxespad=0)
    ax.grid(color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)

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
    categories = ["Avg English", "Avg Multilingual", "Avg Overall"]

    x = np.arange(len(categories))
    bar_width = 0.8 / max(len(models), 1)

    fig, ax = plt.subplots(figsize=(8, 5))
    fig.set_facecolor(DARK_BG)
    style_ax(ax)

    for i, model in enumerate(models):
        model_points = [p for p in points if p["model"] == model]
        en_accs = [(1 - p["wer"]) * 100 for p in model_points if p["condition"] in english_keys]
        multi_accs = [(1 - p["wer"]) * 100 for p in model_points if p["condition"] not in english_keys]
        all_accs = [(1 - p["wer"]) * 100 for p in model_points]

        avgs = [
            sum(en_accs) / len(en_accs) if en_accs else 0,
            sum(multi_accs) / len(multi_accs) if multi_accs else 0,
            sum(all_accs) / len(all_accs) if all_accs else 0,
        ]

        offset = (i - len(models) / 2 + 0.5) * bar_width
        bars = ax.bar(x + offset, avgs, bar_width * 0.9, label=model_name(model),
                       color=COLORS[i % len(COLORS)], zorder=3)
        for bar, a in zip(bars, avgs):
            if a > 0:
                ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.15,
                        f"{a:.1f}%", ha="center", va="bottom", fontsize=8, color=DARK_LABEL)

    ax.set_ylabel("Accuracy %")
    ax.set_title("Average Accuracy by Category", fontweight="bold", pad=12)
    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=10)
    ax.legend(facecolor="#2a2a2a", edgecolor=DARK_GRID, labelcolor=DARK_FG, fontsize=9)
    ax.grid(axis="y", color=DARK_GRID, linestyle="--", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)

    fig.tight_layout()
    fig.savefig(str(out_path), dpi=150, facecolor=DARK_BG)
    plt.close(fig)
    print(f"Chart: {out_path}")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: charts.py <results-dir>", file=sys.stderr)
        sys.exit(1)

    results_dir = Path(sys.argv[1])
    json_path = results_dir / "stt.json"

    if not json_path.exists():
        print(f"No results at {json_path}", file=sys.stderr)
        sys.exit(1)

    with open(json_path) as f:
        results = json.load(f)

    generate_accuracy_bar(results, results_dir / "accuracy-comparison.png")
    generate_scatter(results, results_dir / "speed-accuracy.png")
    generate_averages_bar(results, results_dir / "accuracy-averages.png")


if __name__ == "__main__":
    main()
