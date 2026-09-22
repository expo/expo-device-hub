// No caller-controlled value reaches this HTML, so nothing here is escaped.

const STYLE = `
:root{
  color-scheme:dark;
  --slate-1:#111113;--slate-2:#18191b;--slate-6:#363a3f;
  --slate-11:#b0b4ba;--slate-12:#edeef0;
  --blue-10:#3b9eff;--red-7:#8c333a;--red-11:#ff9592
}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:40px 16px;
  background:var(--slate-2);color:var(--slate-12);
  font:14px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
main{width:100%;max-width:400px;padding:28px 24px 24px;background:var(--slate-1);
  border:1px solid var(--slate-6);border-radius:8px;display:flex;flex-direction:column;gap:20px}
.badge{display:flex;width:44px;height:44px;align-items:center;justify-content:center;margin:0 auto;
  border-radius:8px;background:#000}
.titles{text-align:center}
h1{margin:0;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.02em}
.lead{margin:8px 0 0;font-size:14px;font-weight:500;line-height:1.45;color:var(--slate-11)}
form{display:flex;flex-direction:column;gap:8px}
label{font-size:14px;font-weight:500}
input{width:100%;height:44px;padding:0 12px;border-radius:8px;border:1px solid var(--slate-6);
  background:var(--slate-2);color:var(--slate-12);font:inherit;font-size:16px}
input:focus{outline:2px solid var(--blue-10);outline-offset:1px}
input[aria-invalid="true"]{border-color:var(--red-7)}
.field-error{margin:0;padding:0 8px;font-size:14px;line-height:1.45;color:var(--red-11)}
button{height:44px;margin-top:4px;border:0;border-radius:8px;background:#fff;
  color:var(--slate-1);font:inherit;font-size:16px;font-weight:500;cursor:pointer}
button:hover{background:#ccc}
`.trim();

const EXPO_MARK = `<svg width="26" height="22" viewBox="0 0 26 22" fill="none" aria-hidden="true">
  <path d="m13.7431 0h-2.1422c-.9888 0-1.8954.528587-2.35103 1.37085l-9.079617 16.78415c-.2108052.3897-.2266421.8499-.043082 1.2521l.751794 1.6472c.467825 1.025 1.940765 1.1283 2.558855.1794l8.60688-13.21307c.1352-.20753.3723-.3336.6273-.3336s.4921.12607.6273.3336l8.6069 13.21307c.6181.9489 2.091.8456 2.5588-.1794l.7518-1.6472c.1836-.4022.1678-.8624-.0431-1.2521l-9.0796-16.78415c-.4556-.842263-1.3622-1.37085-2.351-1.37085z" fill="#fff"/>
</svg>`;

export const TOKEN_FORM_SCRIPT = `
(function () {
  var form = document.forms[0];
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var token = form.token.value.trim();
    if (!token) {
      // Whitespace passes the required check, so ask the browser to say what is wrong.
      form.token.value = "";
      form.token.reportValidity();
      return;
    }
    // A plain GET submit would drop the rest of the query, such as ?device=.
    var url = new URL(window.location.href);
    url.searchParams.set("token", token);
    // Assigning the full URL keeps a "//" path from resolving to another origin.
    window.location.assign(url.href);
  });
})();
`.trim();

export function unauthorizedPreviewPage(opts: { rejectedToken?: boolean } = {}): string {
  const rejected = !!opts.rejectedToken;
  const invalidAttrs = rejected ? ` aria-invalid="true" aria-describedby="token-error"` : "";
  const fieldError = rejected
    ? `<p class="field-error" id="token-error" role="alert">This token isn't valid.</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Simulator Preview</title>
<style>${STYLE}</style>
</head><body>
<main>
  <div class="badge">${EXPO_MARK}</div>
  <div class="titles">
    <h1>This session is protected</h1>
    <p class="lead">This preview only opens with a token.</p>
  </div>
  <form method="get">
    <label for="token">Security token</label>
    <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required autofocus${invalidAttrs}>
    ${fieldError}
    <button type="submit">Submit</button>
  </form>
</main>
<script>${TOKEN_FORM_SCRIPT}</script>
</body></html>
`;
}
