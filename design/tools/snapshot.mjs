// Snapshot a screen of the real Patch web UI (dev harness) into one
// self-contained HTML file, so a design starts from what Patch actually looks like.
// usage: node snapshot.mjs <harness-url> <chat-name|-> <out.html> [width] [height]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [url, chat, out, w = '1400', h = '900'] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: +w, height: +h } });
await p.goto(url); await p.waitForTimeout(3000);
if (chat && chat !== '-') { await p.getByText(chat, { exact: true }).first().click(); await p.waitForTimeout(1500); }
for (const d of await p.getByRole('button', { name: 'Dismiss' }).all()) await d.click().catch(() => {});
await p.waitForTimeout(300);
const html = await p.evaluate(async () => {
  let css = '';
  for (const s of document.styleSheets) { try { for (const r of s.cssRules) css += r.cssText + '\n'; } catch {} }
  const urls = [...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m => m[1]).filter(u => !u.startsWith('data:')))];
  for (const u of urls) {
    try {
      const res = await fetch(new URL(u, location.href)); const buf = new Uint8Array(await res.arrayBuffer());
      let bin = ''; for (const x of buf) bin += String.fromCharCode(x);
      css = css.split(u).join(`data:${res.headers.get('content-type') || 'application/octet-stream'};base64,${btoa(bin)}`);
    } catch {}
  }
  const doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('script,style,link[rel=stylesheet],link[rel=modulepreload]').forEach(n => n.remove());
  const st = document.createElement('style'); st.textContent = css; doc.querySelector('head').appendChild(st);
  return '<!doctype html>\n' + doc.outerHTML;
});
writeFileSync(out, html); console.log(out, html.length);
await b.close();
