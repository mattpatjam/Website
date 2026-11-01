import { esc } from "./charts";

const CSS = `
:root{
  color-scheme:dark;
  --page:#0d0d0d; --surface:#1a1a19; --surface-2:#232321;
  --text:#ffffff; --text-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
  padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
main{max-width:640px;margin:0 auto;padding:12px 16px 48px}
.menu{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:8px 16px;background:var(--page);border-bottom:1px solid var(--border)}
.menu::-webkit-scrollbar{display:none}
.menu a{flex:none;font-size:13px;padding:6px 12px;border-radius:999px;color:var(--text-2);text-decoration:none;background:var(--surface);border:1px solid var(--border)}
.menu a:focus-visible{outline:2px solid var(--s1);outline-offset:2px}
.card[id],.tiles[id]{scroll-margin-top:60px}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
header.top{display:flex;align-items:center;justify-content:space-between;gap:8px;max-width:640px;margin:0 auto;padding:12px 16px 0}
header.top a{color:var(--text-2);text-decoration:none;font-size:14px}
header.top nav{display:flex;gap:14px}
h1{font-size:17px;margin:0;font-weight:600}
h2{font-size:15px;margin:0 0 2px;font-weight:600}
.sub{color:var(--muted);font-size:13px;margin:0 0 10px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin:12px 0}
.hero{display:grid;grid-template-columns:128px 1fr;gap:14px;align-items:center}
.ring{width:128px;height:128px}
.ringwrap{position:relative;width:128px;height:128px}
.ringwrap .num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ringwrap .num b{font-size:38px;line-height:1;font-weight:650}
.ringwrap .num span{font-size:12px;color:var(--text-2);margin-top:4px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text);padding:2px 8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.limiter{margin:8px 0 0;color:var(--text-2);font-size:14px}
.comps{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:8px}
.comps li{display:grid;grid-template-columns:96px 1fr 34px;gap:8px;align-items:center;font-size:13px}
.comps .bar{height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
.comps .bar i{display:block;height:100%;border-radius:3px;background:var(--s1)}
.comps .detail{grid-column:1/-1;color:var(--muted);font-size:12px;margin-top:-6px}
.comps .val{text-align:right;font-variant-numeric:tabular-nums;color:var(--text-2)}
.recs{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:10px}
.recs li{padding:10px 12px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)}
.recs b{display:block;font-size:14px}
.recs span{color:var(--text-2);font-size:14px}
.cat{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.kv{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0 4px}
.kv div{background:var(--surface-2);border-radius:10px;padding:8px 10px;border:1px solid var(--border)}
.kv small{display:block;color:var(--muted);font-size:11px}
.kv b{font-size:17px;font-weight:600}
.kv em{font-style:normal;font-size:12px;color:var(--text-2)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:10px}
.tile small{display:block;color:var(--muted);font-size:11px}
.tile b{font-size:19px;font-weight:600}
.tile em{font-style:normal;font-size:12px;color:var(--text-2)}
.spark{width:100%;height:26px;margin-top:4px}
.chart{width:100%;height:auto;display:block;overflow:visible}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{stroke:var(--axis);stroke-width:1}
.chart .ref{stroke:var(--text-2);stroke-width:1;stroke-dasharray:4 3;opacity:.7}
.chart .tick{fill:var(--muted);font-size:9.5px;font-variant-numeric:tabular-nums}
.chart .flag{fill:var(--warning);font-size:11px;font-weight:700}
.chart .hit{fill:transparent;cursor:pointer}
.chart .hit:hover,.chart .hit.on{fill:rgba(255,255,255,.05)}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--text-2);margin:6px 0 2px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.legend i.line{height:2px;border-radius:1px;vertical-align:3px}
.legend i.dash{height:0;border-top:1px dashed var(--text-2);background:none!important;vertical-align:3px}
.empty{color:var(--muted);font-size:13px;margin:8px 0}
.events{list-style:none;padding:0;margin:8px 0 0;font-size:13px}
.events li{display:flex;gap:8px;padding:5px 0;border-top:1px solid var(--grid)}
.events li:first-child{border-top:0}
.events time{color:var(--muted);min-width:92px;font-variant-numeric:tabular-nums}
.tag{font-size:11px;padding:1px 6px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);margin-left:auto;white-space:nowrap;align-self:flex-start}
.warnline{display:flex;gap:6px;align-items:center;color:var(--text);font-size:13px}
form.inline{display:inline}
button,.btn{font:inherit;font-size:14px;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:8px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--s1);border-color:var(--s1)}
input[type=password],textarea{width:100%;font:inherit;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px}
textarea{min-height:320px;font-size:14px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.muted{color:var(--muted)}
.foot{color:var(--muted);font-size:12px;margin-top:20px;line-height:1.6}
.note{font-size:13px;color:var(--text-2)}
.ok{color:var(--good)} .bad{color:var(--critical)}
#tip{position:fixed;z-index:10;pointer-events:none;background:#2c2c2a;color:var(--text);border:1px solid var(--border);border-radius:8px;
  padding:6px 8px;font-size:12px;white-space:pre;display:none;box-shadow:0 4px 16px rgba(0,0,0,.4)}
table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:4px 4px;border-top:1px solid var(--grid);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{color:var(--muted);font-weight:500}
details summary{cursor:pointer;color:var(--text-2);font-size:13px;margin-top:8px}
.tablewrap{overflow-x:auto}
`;

export function layout(title: string, body: string, opts: { nav?: boolean } = {}): string {
  const nav = opts.nav !== false
    ? `<header class="top"><h1>${esc(title)}</h1><nav><a href="/">Today</a><a href="/history">History</a><a href="/settings">Settings</a></nav></header>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0d0d0d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='none' stroke='%233987e5' stroke-width='5'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head><body>
${nav}
<main>${body}</main>
<div id="tip" role="status"></div>
<script src="/app.js" defer></script>
</body></html>`;
}

/** Tooltip script, served from /app.js (CSP forbids inline scripts). */
export const APP_JS = `
(function(){
  var tip=document.getElementById('tip'); var on=null; var sy=0;
  function show(el,x,y){ if(on) on.classList.remove('on'); on=el; el.classList.add('on');
    tip.textContent=el.getAttribute('data-tip'); tip.style.display='block'; sy=window.scrollY;
    var r=tip.getBoundingClientRect(); var left=Math.min(window.innerWidth-r.width-8,Math.max(8,x-r.width/2));
    var top=y-r.height-14; if(top<8) top=y+16; tip.style.left=left+'px'; tip.style.top=top+'px'; }
  function hide(){ tip.style.display='none'; if(on){on.classList.remove('on'); on=null;} }
  document.addEventListener('pointermove',function(e){ var t=e.target.closest&&e.target.closest('[data-tip]');
    if(e.pointerType==='mouse'){ if(t) show(t,e.clientX,e.clientY); else hide(); } });
  document.addEventListener('click',function(e){ var t=e.target.closest&&e.target.closest('[data-tip]');
    if(t) show(t,e.clientX,e.clientY); else hide(); });
  window.addEventListener('scroll',function(){ if(Math.abs(window.scrollY-sy)>40) hide(); },{passive:true});
})();
`;
