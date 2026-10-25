// Weekly digest: load the built dashboard headlessly and write window.buildDigest() as JSON.
// It is the input for the written read on the Conclusions tab (data/conclusions.json).
// Usage: node tools/digest.js SITE_DIR OUT.json
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const [site, out] = process.argv.slice(2);
if (!site || !out) {
  console.error('usage: node tools/digest.js SITE_DIR OUT.json');
  process.exit(2);
}
const root = path.resolve(site);
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const browser = await chromium.launch();
  let code = 0;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // the digest needs no charts or fonts: answer every external request with an empty body
    await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => r.fulfill({ status: 200, body: '' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/#notes`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.buildDigest === 'function' && typeof META !== 'undefined' && META, null, { timeout: 60000 });
    const digest = await page.evaluate(() => window.buildDigest());
    fs.writeFileSync(out, JSON.stringify(digest, null, 1));
    console.log(`digest for ${digest.report_date} (prices to ${digest.prices_to}): ${digest.signals.length} signals -> ${out}`);
    if (errors.length) console.error('page errors:\n' + [...new Set(errors)].join('\n'));
  } catch (e) {
    console.error(e);
    code = 1;
  } finally {
    await browser.close();
    server.close();
    process.exitCode = code;
  }
});
