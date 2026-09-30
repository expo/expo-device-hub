// serve-sim's token form (`unauthorized-page.ts`), titled for the Hub and styled like its
// dashboard. No caller-controlled value reaches this HTML, so nothing here is escaped.

// The dashboard's theme: light by default, dark when the system prefers it, as the dashboard
// does. The page loads before the gate passes, so it cannot load the dashboard's stylesheet. It
// copies the variables it uses, and `unauthorized-page.test.ts` keeps each copy equal to the
// dashboard's value. Text sizes follow `heading['2xl']`, `textSize.sm`, and `textSize.base`.
const STYLE = `
:root{
  color-scheme:light;
  --expo-color-white:#fff;--expo-color-black:#000;
  --expo-font-sans:'Inter',-apple-system,'system-ui',sans-serif;
  --expo-radius-md:6px;--expo-radius-lg:8px;
  --expo-theme-background-default:#fff;--expo-theme-background-subtle:#f9f9fb;
  --expo-theme-background-element:#f0f0f3;
  --expo-theme-border-default:#d9d9e0;--expo-theme-border-danger:#f4a9aa;
  --expo-theme-text-default:#1c2024;--expo-theme-text-secondary:#60646c;
  --expo-theme-text-danger:#ce2c31;
  --expo-theme-button-primary-background:#000;--expo-theme-button-primary-border:transparent;
  --expo-theme-button-primary-hover:#60646c;--expo-theme-button-primary-text:#fff
}
@media (prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --expo-theme-background-default:#111113;--expo-theme-background-subtle:#18191b;
    --expo-theme-background-element:#212225;
    --expo-theme-border-default:#363a3f;--expo-theme-border-danger:#8c333a;
    --expo-theme-text-default:#edeef0;--expo-theme-text-secondary:#b0b4ba;
    --expo-theme-text-danger:#ff9592;
    --expo-theme-button-primary-background:#fff;
    --expo-theme-button-primary-hover:hsl(from #fff h s calc(l - 20));
    --expo-theme-button-primary-text:#111113
  }
}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:40px 16px;
  background:var(--expo-theme-background-subtle);color:var(--expo-theme-text-default);
  font:14px/1.6 var(--expo-font-sans);-webkit-font-smoothing:antialiased}
main{width:100%;max-width:400px;padding:28px 24px 24px;background:var(--expo-theme-background-default);
  border:1px solid var(--expo-theme-border-default);border-radius:var(--expo-radius-lg);
  display:flex;flex-direction:column;gap:20px}
.badge{display:flex;width:44px;height:44px;align-items:center;justify-content:center;margin:0 auto;
  border-radius:var(--expo-radius-lg);background:var(--expo-color-black);color:var(--expo-color-white)}
.titles{text-align:center}
h1{margin:0;font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.5px}
.lead{margin:8px 0 0;color:var(--expo-theme-text-secondary)}
form{display:flex;flex-direction:column;gap:8px}
label{font-weight:500}
input{width:100%;height:44px;padding:0 12px;border-radius:var(--expo-radius-md);
  border:1px solid var(--expo-theme-border-default);background:var(--expo-theme-background-default);
  color:var(--expo-theme-text-default);caret-color:var(--expo-theme-text-default);
  font:inherit;font-size:16px;outline:none}
input:focus{box-shadow:0 0 0 3px var(--expo-theme-background-element)}
input[aria-invalid="true"]{border-color:var(--expo-theme-border-danger)}
.field-error{margin:0;padding:0 8px;color:var(--expo-theme-text-danger)}
button{height:44px;margin-top:4px;padding:0 24px;border:1px solid var(--expo-theme-button-primary-border);
  border-radius:var(--expo-radius-lg);background:var(--expo-theme-button-primary-background);
  color:var(--expo-theme-button-primary-text);font:inherit;font-size:16px;font-weight:500;cursor:pointer;
  transition:background-color 150ms ease,transform 100ms ease}
button:hover{background:var(--expo-theme-button-primary-hover)}
button:active{transform:scale(.98)}
`.trim();

const EXPO_MARK = `<svg width="26" height="22" viewBox="0 0 26 22" fill="none" aria-hidden="true">
  <path d="m13.7431 0h-2.1422c-.9888 0-1.8954.528587-2.35103 1.37085l-9.079617 16.78415c-.2108052.3897-.2266421.8499-.043082 1.2521l.751794 1.6472c.467825 1.025 1.940765 1.1283 2.558855.1794l8.60688-13.21307c.1352-.20753.3723-.3336.6273-.3336s.4921.12607.6273.3336l8.6069 13.21307c.6181.9489 2.091.8456 2.5588-.1794l.7518-1.6472c.1836-.4022.1678-.8624-.0431-1.2521l-9.0796-16.78415c-.4556-.842263-1.3622-1.37085-2.351-1.37085z" fill="currentColor"/>
</svg>`;

// A plain GET submit would drop the rest of the query, such as ?device=.
const TOKEN_FORM_SCRIPT = `
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
    var url = new URL(window.location.href);
    url.searchParams.set("token", token);
    // Assigning the full URL keeps a "//" path from resolving to another origin.
    window.location.assign(url.href);
  });
})();
`.trim();

export function unauthorizedPage({ rejectedToken = false }: { rejectedToken?: boolean } = {}): string {
  const invalidAttrs = rejectedToken ? ` aria-invalid="true" aria-describedby="token-error"` : '';
  const fieldError = rejectedToken
    ? `<p class="field-error" id="token-error" role="alert">This token isn't valid.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Expo Device Hub</title>
<style>${STYLE}</style>
</head><body>
<main>
  <div class="badge">${EXPO_MARK}</div>
  <div class="titles">
    <h1>This session is protected</h1>
    <p class="lead">Expo Device Hub only opens with a token.</p>
  </div>
  <form method="get">
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required autofocus${invalidAttrs}>
    ${fieldError}
    <button type="submit">Submit</button>
  </form>
</main>
<script>${TOKEN_FORM_SCRIPT}</script>
</body></html>
`;
}
