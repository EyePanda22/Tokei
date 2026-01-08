"""Render the dashboard HTML for a single report using Jinja2.

This script is intended to be called from the Node report generator.

Usage (from the Tokei root):

    python src/tokei/render_dashboard_html.py stats.json output.html

Where "stats.json" is a JSON file with a single object matching the
structure expected by the Jinja2 template in:

    design/templates/report.html.j2

The Node script is responsible for computing all statistics; this
renderer only:
- Loads that JSON
- Adds a few convenience fields (preformatted time strings)
- Renders the HTML template with Jinja2
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

try:
    from tokei_errors import CONFIG, OUTPUT
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from tokei_errors import CONFIG, OUTPUT

def format_hms(total_seconds: int) -> str:
    sign = "-" if total_seconds < 0 else ""
    s = abs(int(round(total_seconds)))
    h = s // 3600
    m = (s % 3600) // 60
    sec = s % 60
    return f"{sign}{h:d}:{m:02d}:{sec:02d}"


def format_k(value: int) -> str:
    if value is None:
        return "?"
    try:
        v = int(value)
    except (TypeError, ValueError):
        return "?"
    if v >= 1000:
        return f"{v/1000:.1f}k"
    return str(v)


def format_chars(value: int) -> str:
    """Format large character counts.

    - >= 1,000,000: millions with up to 2 decimals, trimmed
      (1M, 1.8M, 1.85M)
    - otherwise: k-format
    """

    if value is None:
        return "?"
    try:
        v = int(value)
    except (TypeError, ValueError):
        return "?"

    if v >= 1_000_000:
        millions = v / 1_000_000.0
        text = f"{millions:.2f}".rstrip("0").rstrip(".")
        return f"{text}M"
    return format_k(v)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            "Usage: python src/tokei/render_dashboard_html.py stats.json output.html",
            file=sys.stderr,
        )
        return CONFIG.exit_code

    stats_path = Path(argv[1])
    out_path = Path(argv[2])

    if not stats_path.is_file():
        print(f"stats JSON not found: {stats_path}", file=sys.stderr)
        return OUTPUT.exit_code

    try:
        with stats_path.open("r", encoding="utf-8") as f:
            stats = json.load(f)
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to load stats JSON: {exc}", file=sys.stderr)
        return OUTPUT.exit_code

    if not isinstance(stats, dict):
        print("Stats JSON must be an object", file=sys.stderr)
        return OUTPUT.exit_code

    # Add convenience fields expected by the template.
    today = stats.get("today_immersion") or {}
    total_today_seconds = today.get("total_seconds") or 0
    today["total_hms"] = format_hms(total_today_seconds)
    stats["today_immersion"] = today

    avg_seconds = int(stats.get("avg_immersion_seconds") or 0)
    stats["avg_immersion_hms"] = format_hms(avg_seconds)

    delta_avg_seconds = int(stats.get("avg_immersion_delta_seconds") or 0)
    stats["avg_immersion_delta_hms"] = format_hms(delta_avg_seconds)

    # Set up Jinja2 environment pointing at the design template.
    root = Path(__file__).resolve().parents[2]
    templates_dir = root / "design" / "templates"

    env = Environment(
        loader=FileSystemLoader(str(templates_dir)),
        autoescape=select_autoescape(["html", "xml"]),
    )

    # Register filters used in the template.
    env.filters["format_k"] = format_k
    env.filters["format_chars"] = format_chars

    template = env.get_template("report.html.j2")

    html = template.render(stats=stats, format_hms=format_hms, format_k=format_k)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv))
