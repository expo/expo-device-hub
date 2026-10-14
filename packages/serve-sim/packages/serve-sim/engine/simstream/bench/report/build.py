"""Render simstream-results.md to a typeset HTML page (printed to PDF by print.mjs).

    python3 build.py simstream-results.md out.html

Markdown conventions beyond the basics:
  - The first H1 is the title (" vs " becomes an italic "versus" on its own line); the italic line under it
    the subtitle; the next paragraph the date line.
  - "## N. Title" becomes a numbered section with a "Section N" kicker.
  - A ```tiles block holds stat tiles, one per line: "value | unit | caption".
  - A ```bars block holds a bar chart as JSON: {title, series: [{name, color}], panels: [{title, note,
    unit, values, max?}], shared?}. color indexes PALETTE; shared puts every panel on one scale.
  - "**Setup:**" followed by a list of "**Label:** text" items becomes a setup box.
  - "Table: Caption" right before a table captions it ("Table N · Caption"). A header cell in **bold**
    marks the simstream column, which is tinted.
  - A blockquote whose first line is bold becomes a callout with that line as its kicker.
"""
import html
import json
import re
import sys

import markdown

# Categorical order, validated with the dataviz palette checker against the page surface (light mode):
# simstream (WebSocket), stock WebRTC, stock HTTP/AVCC, simstream over WebRTC (RTP).
PALETTE = ["#2b6fd6", "#ee6a39", "#1f9e74", "#8a4fd8"]

src, out = sys.argv[1], sys.argv[2]
md = open(src).read()

title = re.search(r"^# (.+)$", md, re.M).group(1)
md = md.replace(f"# {title}\n", "", 1)
sub = re.search(r"^_(.+)_$", md, re.M)
subtitle = sub.group(1) if sub else ""
if sub:
    md = md.replace(sub.group(0), "", 1)
meta = re.search(r"^\s*(\S.*)$", md, re.M)
md = md.replace(meta.group(0), "", 1)


def tiles(block: str) -> str:
    cells = []
    for line in block.strip().splitlines():
        value, unit, caption = (part.strip() for part in line.split("|", 2))
        unit_html = f'<span class="unit">{html.escape(unit)}</span>' if unit else ""
        cells.append(f'<div class="tile"><div class="value">{html.escape(value)}{unit_html}</div>'
                     f'<div class="caption">{html.escape(caption)}</div></div>')
    return f'\n<div class="tiles">{"".join(cells)}</div>\n'


def bars(block: str) -> str:
    spec = json.loads(block)
    series = spec["series"]
    shared_max = max(v for p in spec["panels"] for v in p["values"]) if spec.get("shared") else None
    legend = "".join(f'<span><i style="background:{PALETTE[s["color"]]}"></i>{html.escape(s["name"])}</span>'
                     for s in series)
    panels = []
    for panel in spec["panels"]:
        top = panel.get("max") or shared_max or max(panel["values"])
        rows = "".join(
            f'<div class="bar-row"><div class="track"><div class="bar" style="width:{max(0.6, 100 * v / top):.2f}%;'
            f'background:{PALETTE[s["color"]]}"></div></div><div class="num">{v}{html.escape(panel["unit"])}</div></div>'
            for s, v in zip(series, panel["values"]))
        note = f'<div class="note">{html.escape(panel["note"])}</div>' if panel.get("note") else '<div class="note">&nbsp;</div>'
        panels.append(f'<div class="panel"><div class="ptitle">{html.escape(panel["title"])}</div>{note}{rows}'
                      f'<div class="axis">0 — {top}{html.escape(panel["unit"])}</div></div>')
    return (f'\n<figure class="chart"><div class="chart-head"><div class="ctitle">{html.escape(spec["title"])}</div>'
            f'<div class="legend">{legend}</div></div><div class="panels" style="grid-template-columns:repeat({len(panels)},1fr)">'
            f'{"".join(panels)}</div></figure>\n')


md = re.sub(r"```tiles\n(.*?)```", lambda m: tiles(m.group(1)), md, flags=re.S)
md = re.sub(r"```bars\n(.*?)```", lambda m: bars(m.group(1)), md, flags=re.S)

body = markdown.markdown(md, extensions=["tables", "sane_lists", "smarty"])

# Numbered sections get a kicker.
body = re.sub(r"<h2>(\d+)\. (.+?)</h2>", r'<div class="sechead"><div class="kicker">Section \1</div><h2 class="section">\2</h2></div>', body)
# Keep each direction arrow with its label.
body = body.replace(" ↑", "&nbsp;↑").replace(" ↓", "&nbsp;↓")
# Table captions.
count = 0
def caption(m: re.Match) -> str:
    global count
    count += 1
    return f'<div class="tcaption">Table {count} · {m.group(1)}</div>\n<table>'
body = re.sub(r"<p>Table: (.+?)</p>\s*<table>", caption, body)
# Callouts.
body = re.sub(r"<blockquote>\s*<p><strong>(.+?)</strong></p>(.*?)</blockquote>",
              r'<aside class="callout"><div class="ckicker">\1</div>\2</aside>', body, flags=re.S)

title_html = html.escape(title).replace(" vs ", '<br><em>versus</em> ')
meta_html = markdown.markdown(meta.group(1))[3:-4]
footer = html.escape(title.replace(" vs ", " — "))

page = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{html.escape(title)} — results</title>
<style>
@page {{ size: Letter; margin: 0.7in 0.8in 0.8in; }}
:root {{
  --ink: #1b1d21; --soft: #5b606b; --faint: #8a8f98; --rule: #dcdad3; --paper: #faf9f6; --box: #f1efe9;
  --accent: #2b6fd6; --accent-bg: #ebf2fc;
  --sans: "SF Pro Text", -apple-system, "Helvetica Neue", sans-serif; --serif: "Charter", "New York", Georgia, serif;
}}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; background: var(--paper); }}
body {{
  font: 10.4pt/1.55 var(--serif); color: var(--ink); margin: 0; background: var(--paper);
  hyphens: auto; font-kerning: normal; font-variant-ligatures: common-ligatures;
}}
.smallcaps, .kicker, .tcaption, .ctitle, .ptitle, .ckicker, .label, .meta, .footer, thead th {{
  font-family: var(--sans); text-transform: uppercase; letter-spacing: .14em;
}}
header.cover .kicker {{ font-size: 7.5pt; font-weight: 600; color: var(--accent); margin-bottom: 10pt; }}
header.cover h1 {{ font: 700 30pt/1.08 var(--serif); letter-spacing: -.015em; margin: 0; }}
header.cover h1 em {{ font-weight: 400; color: var(--soft); }}
header.cover .sub {{ font: italic 11.5pt/1.45 var(--serif); color: var(--soft); margin: 12pt 0 16pt; max-width: 5in; }}
.meta {{ font-size: 7pt; color: var(--faint); border-top: 1.2pt solid var(--ink); border-bottom: .5pt solid var(--rule);
  padding: 7pt 0; margin-bottom: 18pt; }}
.meta code {{ text-transform: none; letter-spacing: 0; }}
h2 {{ font: 700 15pt/1.25 var(--serif); margin: 20pt 0 8pt; padding-top: 10pt; border-top: .5pt solid var(--rule); break-after: avoid; }}
.sechead {{ margin-top: 22pt; padding-top: 10pt; border-top: .5pt solid var(--rule); break-inside: avoid; break-after: avoid; }}
.sechead .kicker {{ font-size: 7.5pt; font-weight: 600; color: var(--accent); }}
.sechead h2.section {{ margin: 4pt 0 8pt; padding-top: 0; border-top: 0; }}
p:has(+ .tiles), p:has(+ .setup), p:has(+ figure), p:has(+ .tcaption) {{ break-after: avoid; }}
p {{ margin: 0 0 8pt; text-wrap: pretty; orphans: 3; widows: 3; }}
ul, ol {{ margin: 0 0 9pt; padding-left: 15pt; }}
li {{ margin: 0 0 4.5pt; text-wrap: pretty; hyphens: manual; }}
li::marker {{ color: var(--accent); }}
code {{ font: 8.4pt "SF Mono", Menlo, monospace; background: #eceae4; padding: .5pt 3pt; border-radius: 2.5pt; white-space: nowrap; }}
.tiles {{ display: grid; grid-template-columns: repeat(4, 1fr); border-top: .5pt solid var(--rule); border-bottom: .5pt solid var(--rule);
  margin: 4pt 0 14pt; break-inside: avoid; }}
.tile {{ padding: 9pt 10pt 10pt; border-left: .5pt solid var(--rule); }}
.tile:first-child {{ border-left: 0; padding-left: 0; }}
.tile .value {{ font: 500 20pt/1.1 var(--sans); letter-spacing: -.01em; }}
.tile .unit {{ font-size: 10pt; color: var(--soft); margin-left: 2pt; }}
.tile .caption {{ font: 7.4pt/1.35 var(--sans); color: var(--faint); margin-top: 5pt; }}
.setup {{ display: grid; grid-template-columns: 1.35in 1fr; gap: 5pt 12pt; background: var(--box); border-radius: 4pt;
  padding: 11pt 14pt; margin: 6pt 0 14pt; break-inside: avoid; }}
.setup .label {{ font-size: 7pt; color: var(--faint); padding-top: 2.5pt; }}
.setup ol {{ margin: 4pt 0 4pt; }}
.setup p {{ margin: 0 0 4pt; }}
figure.chart {{ background: #fff; border: .5pt solid var(--rule); border-radius: 6pt; padding: 12pt 14pt 10pt; margin: 8pt 0 14pt; break-inside: avoid; }}
.chart-head {{ display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; margin-bottom: 10pt; }}
.ctitle {{ font-size: 7.6pt; font-weight: 700; }}
.legend {{ font: 7.4pt var(--sans); color: var(--soft); display: flex; gap: 10pt; white-space: nowrap; }}
.legend i {{ display: inline-block; width: 7pt; height: 7pt; border-radius: 2pt; margin-right: 4pt; vertical-align: -.5pt; }}
.panels {{ display: grid; gap: 18pt; }}
.ptitle {{ font-size: 6.8pt; font-weight: 700; }}
.note {{ font: 7pt var(--sans); color: var(--faint); margin: 2pt 0 7pt; padding-bottom: 5pt; border-bottom: .5pt solid var(--rule); }}
.bar-row {{ display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 6pt; margin: 5pt 0; }}
.track {{ height: 9pt; }}
.bar {{ height: 100%; border-radius: 0 4pt 4pt 0; }}
.num {{ font: 600 8pt var(--sans); font-variant-numeric: tabular-nums; min-width: 34pt; text-align: right; }}
.axis {{ font: 6.8pt var(--sans); color: var(--faint); margin-top: 7pt; padding-top: 5pt; border-top: .5pt solid var(--rule); }}
.tcaption {{ font-size: 7.4pt; font-weight: 700; margin: 12pt 0 4pt; break-after: avoid; }}
table {{ width: 100%; border-collapse: collapse; margin: 0 0 12pt; break-inside: avoid;
  font: 8.6pt/1.35 var(--sans); font-variant-numeric: tabular-nums; }}
thead th {{ text-align: right; font-weight: 500; font-size: 6.8pt; color: var(--faint); padding: 0 7pt 5pt;
  border-bottom: 1.2pt solid var(--ink); vertical-align: bottom; }}
thead th:first-child {{ text-align: left; padding-left: 0; }}
td {{ padding: 5pt 7pt; border-bottom: .5pt solid var(--rule); text-align: right; }}
td:first-child {{ text-align: left; padding-left: 0; }}
td:not(:first-child) {{ white-space: nowrap; }}
tbody tr:last-child td {{ border-bottom: 1.2pt solid var(--ink); }}
td strong {{ font-weight: 650; }}
.ours {{ background: var(--accent-bg); }}
thead th.ours {{ color: var(--ink); font-weight: 600; }}
thead th.ours::before {{ content: "● "; color: var(--accent); }}
thead th strong {{ font-weight: inherit; }}
table.wide td {{ text-align: left; vertical-align: top; white-space: normal; }}
table.wide td:not(:first-child) {{ color: var(--soft); font-size: 8pt; }}
table.wide td:last-child {{ color: var(--faint); font-size: 7.6pt; }}
table.wide thead th {{ text-align: left; }}
aside.callout {{ background: var(--accent-bg); border-left: 2.5pt solid var(--accent); padding: 10pt 14pt 4pt; margin: 6pt 0 14pt; break-inside: avoid; }}
.ckicker {{ font-size: 7pt; font-weight: 600; color: var(--accent); margin-bottom: 6pt; }}
.ckicker code {{ background: none; padding: 0; font: inherit; }}
.legendnote {{ font: 7pt var(--sans); color: var(--faint); margin: -8pt 0 12pt; }}
.footer {{ font-size: 6.8pt; color: var(--faint); border-top: 1.2pt solid var(--ink); padding-top: 7pt; margin-top: 18pt;
  display: flex; justify-content: space-between; }}
</style></head>
<body>
<header class="cover">
  <div class="kicker">Results</div>
  <h1>{title_html}</h1>
  <div class="sub">{html.escape(subtitle)}</div>
</header>
<div class="meta">{meta_html}</div>
{body}
<div class="footer"><span>{footer}</span><span>2026-10-01</span></div>
<script>
// Setup boxes: "Setup:" and a list of "Label: text" items become a labelled grid.
for (const p of [...document.querySelectorAll('p')]) {{
  const ul = p.nextElementSibling;
  if (p.textContent.trim() !== 'Setup:' || ul?.tagName !== 'UL') continue;
  const box = document.createElement('div');
  box.className = 'setup';
  for (const li of [...ul.children]) {{
    const label = document.createElement('div');
    label.className = 'label';
    const lead = li.querySelector(':scope > strong, :scope > p:first-child > strong');
    if (lead && /:$/.test(lead.textContent)) {{ label.textContent = lead.textContent.slice(0, -1); lead.remove(); }}
    const content = document.createElement('div');
    content.append(...li.childNodes);
    box.append(label, content);
  }}
  ul.replaceWith(box);
  p.remove();
}}
// Tint the simstream column (the bold header) in comparison tables; text-heavy tables read left-aligned.
for (const table of document.querySelectorAll('table')) {{
  const heads = [...table.querySelectorAll('thead th')];
  if (heads.some((th) => th.textContent.length > 12) && !heads.some((th) => /↑|↓/.test(th.textContent)) && heads.length === 3) table.classList.add('wide');
  const col = heads.findIndex((th) => th.querySelector('strong'));
  if (col < 1) continue;
  for (const row of table.querySelectorAll('tr')) row.children[col]?.classList.add('ours');
  const note = document.createElement('div');
  note.className = 'legendnote';
  note.textContent = '↓ lower is better · ↑ higher is better. Tinted column is the simstream path.';
  table.after(note);
}}
</script>
</body></html>"""
open(out, "w").write(page)
print(out)
