"""Render simstream-results.md to a typeset HTML page (printed to PDF by print.mjs)."""
import re
import sys

import markdown

src, out = sys.argv[1], sys.argv[2]
md = open(src).read()

# Title block: the first H1 and the italic line under it become a cover header.
title = re.search(r"^# (.+)$", md, re.M).group(1)
md = md.replace(f"# {title}\n", "", 1)
sub = re.search(r"^_(.+)_$", md, re.M)
subtitle = sub.group(1) if sub else ""
if sub:
    md = md.replace(sub.group(0), "", 1)

body = markdown.markdown(md, extensions=["tables", "sane_lists", "smarty"])
title_html = title.replace(" vs ", ' <span class="vs">vs</span> ').replace(": ", ":<br>")
subtitle_html = markdown.markdown(subtitle)[3:-4]

html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
@page {{ size: Letter; margin: 0.85in 0.9in 0.95in 0.9in; }}
:root {{
  --ink: #1b1d21; --soft: #5b606b; --rule: #d9dce1; --accent: #0a6b5c; --accent-bg: #eef6f4;
}}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
body {{
  font-family: "Charter", "New York", Georgia, serif; font-size: 10.6pt; line-height: 1.5;
  color: var(--ink); margin: 0; hyphens: auto; font-kerning: normal;
  font-variant-ligatures: common-ligatures;
}}
header.cover {{ margin: 0 0 22pt; padding-bottom: 14pt; border-bottom: 1.5pt solid var(--ink); }}
header.cover .kicker {{
  font: 600 8pt/1 "SF Pro Text", -apple-system, sans-serif; letter-spacing: .14em;
  text-transform: uppercase; color: var(--accent); margin-bottom: 9pt;
}}
header.cover h1 {{
  font: 700 24pt/1.12 "SF Pro Display", -apple-system, sans-serif; letter-spacing: -.02em; margin: 0;
}}
header.cover h1 .vs {{ font-weight: 400; color: var(--soft); }}
header.cover .sub {{ font: 9pt/1.4 "SF Pro Text", -apple-system, sans-serif; color: var(--soft); margin-top: 10pt; }}
header.cover .sub code {{ font-size: 8.4pt; }}
h2 {{
  font: 700 13.5pt/1.25 "SF Pro Display", -apple-system, sans-serif; letter-spacing: -.01em;
  margin: 22pt 0 7pt; break-after: avoid;
}}
h2 + p, h2 + ul {{ break-before: avoid; }}
p {{ margin: 0 0 8pt; text-align: justify; text-wrap: pretty; orphans: 3; widows: 3; }}
ul {{ margin: 0 0 9pt; padding-left: 15pt; }}
li {{ margin: 0 0 4.5pt; text-align: left; text-wrap: pretty; hyphens: manual; }}
li::marker {{ color: var(--accent); }}
strong {{ font-weight: 700; }}
code {{
  font-family: "SF Mono", "SFNSMono", Menlo, monospace; font-size: 8.8pt; background: #f2f3f5;
  padding: .5pt 3pt; border-radius: 2.5pt; hyphens: none; white-space: nowrap;
}}
a {{ color: var(--accent); text-decoration: none; word-break: break-all; }}
table {{
  width: 100%; border-collapse: collapse; margin: 6pt 0 14pt; break-inside: avoid;
  font: 8.9pt/1.35 "SF Pro Text", -apple-system, sans-serif; font-variant-numeric: tabular-nums;
}}
thead th {{
  text-align: right; font-weight: 600; font-size: 8pt; color: var(--soft);
  padding: 0 7pt 5pt; border-bottom: 1pt solid var(--ink); vertical-align: bottom;
}}
thead th:first-child {{ text-align: left; color: var(--ink); font-size: 8.9pt; }}
td {{ padding: 4.2pt 7pt; border-bottom: .5pt solid var(--rule); text-align: right; }}
td:first-child {{ text-align: left; color: var(--ink); padding-left: 0; }}
thead th:first-child {{ padding-left: 0; }}
tbody tr:last-child td {{ border-bottom: 1pt solid var(--ink); }}
.ours {{ background: var(--accent-bg); }}
thead th.ours {{ color: var(--accent); }}
td strong {{ font-weight: 650; }}
td.ours strong {{ color: var(--accent); }}
</style></head>
<body>
<header class="cover">
  <div class="kicker">Simulator streaming benchmark</div>
  <h1>{title_html}</h1>
  <div class="sub">{subtitle_html}</div>
</header>
{body}
<script>
// Keep the network section (heading, setup, table) together on a fresh page.
for (const h of document.querySelectorAll('h2')) if (/Over the network/.test(h.textContent)) h.style.breakBefore = 'page';
// Shade the "serve-sim + simstream" column in every table.
for (const table of document.querySelectorAll('table')) {{
  const heads = [...table.querySelectorAll('thead th')];
  const col = heads.findIndex((th) => /simstream/.test(th.textContent));
  if (col < 0) continue;
  for (const row of table.querySelectorAll('tr')) row.children[col]?.classList.add('ours');
}}
</script>
</body></html>"""
open(out, "w").write(html)
print(out)
