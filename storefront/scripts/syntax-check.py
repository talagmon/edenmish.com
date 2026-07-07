#!/usr/bin/env python3
"""Syntax-check all inline <script> blocks in the storefront HTML pages."""
import re, subprocess, sys, pathlib

PUB = pathlib.Path(__file__).parent.parent / "public"
errors = 0
for html_file in sorted(PUB.glob("*.html")):
    content = html_file.read_text(encoding="utf-8")
    scripts = re.findall(r"<script>(.*?)</script>", content, re.S)
    for i, script in enumerate(scripts):
        if not script.strip():
            continue
        tmp = f"/tmp/_sc_{html_file.stem}_{i}.js"
        pathlib.Path(tmp).write_text(script)
        result = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        if result.returncode != 0:
            errors += 1
            print(f"  ✗ {html_file.name} script[{i}]: {result.stderr.strip()}")
        else:
            print(f"  ✓ {html_file.name} script[{i}]")
if errors:
    print(f"\n{errors} syntax error(s) found — FIX BEFORE DEPLOY")
    sys.exit(1)
else:
    print("\n✓ All scripts pass syntax check")
