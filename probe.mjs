// POCKET — design probe. No vision model: geometry, contrast, and a coarse
// luminance map decoded from the real screenshots so composition is verifiable.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const url = process.env.APP_URL || 'http://localhost:8772/';
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

const report = [];
const line = (s) => {
  report.push(s);
  console.log(s);
};

async function analyse(page, file, label) {
  const b64 = (await readFile(file)).toString('base64');
  const stats = await page.evaluate(async ({ b64, cols, rows }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = cols;
    c.height = rows;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, cols, rows);
    const data = ctx.getImageData(0, 0, cols, rows).data;
    const lum = [];
    const colors = new Set();
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      lum.push((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
      colors.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx - mn > 40 && mx > 90) colored++;
    }
    return { lum, colors: colors.size, colored, pixels: cols * rows, w: img.width, h: img.height };
  }, { b64, cols: 96, rows: 40 });

  const ramp = ' .:-=+*#%@';
  line(`\n--- ${label} (${stats.w}x${stats.h}) · ${stats.colors} distinct colors · ${((stats.colored / stats.pixels) * 100).toFixed(1)}% saturated pixels`);
  let art = '';
  for (let y = 0; y < 40; y++) {
    let row = '';
    for (let x = 0; x < 96; x++) {
      const v = stats.lum[y * 96 + x];
      row += ramp[Math.min(9, Math.floor(v * 12))];
    }
    art += row + '\n';
  }
  line(art);
}

for (const [label, viewport, isMobile] of [
  ['desktop', { width: 1600, height: 900 }, false],
  ['mobile', { width: 375, height: 812 }, true],
]) {
  const ctx = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: isMobile ? 2 : 1 });
  const page = await ctx.newPage();
  await page.goto(url + '?probe=' + label, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.pocket);
  await page.evaluate(() => {
    window.pocket.loadPreset('two-step');
    window.pocket.selectVoice('kick');
    window.pocket.stop();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    document.querySelectorAll('.ph').forEach((p) => (p.style.transform = 'translateX(0%)'));
  });

  const geo = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) };
    };
    const rail = box('.rail');
    const cells = box('.rail .cells');
    const first = document.querySelector('.rail .cells .cell').getBoundingClientRect();
    const last = document.querySelector('.rail .cells .cell:nth-child(32)').getBoundingClientRect();
    const ph = document.querySelector('.rail .ph').getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll('.rail')).map((r) => Math.round(r.getBoundingClientRect().height));
    const cut = [];
    const inScroller = (el) => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const o = getComputedStyle(node).overflowX;
        if (o === 'auto' || o === 'scroll') return true;
        node = node.parentElement;
      }
      return false;
    };
    document.querySelectorAll('.rack .ghost, .rack .note, .rack h2, .topbar *, .gutter *').forEach((el) => {
      const r = el.getBoundingClientRect();
      const parent = el.parentElement.getBoundingClientRect();
      if (r.width > 0 && !inScroller(el) && (r.right > parent.right + 1.5 || r.left < parent.left - 1.5))
        cut.push(el.className + ' ' + el.textContent.slice(0, 18).trim());
    });
    const style = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    const contrast = (fgSel, bgSel) => {
      const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const lum = (c) => {
        const a = c.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
      };
      const f = lum(parse(style(fgSel, 'color')));
      const b = lum(parse(style(bgSel, 'backgroundColor')));
      const ratio = (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
      return Math.round(ratio * 100) / 100;
    };
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      page: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight },
      rail,
      rows,
      cells: { w: Math.round(cells.w), h: Math.round(cells.h) },
      firstCell: { w: Math.round(first.width), h: Math.round(first.height), x: Math.round(first.x) },
      lastCell: { right: Math.round(last.right), x: Math.round(last.x) },
      playhead: { x: Math.round(ph.x), w: Math.round(ph.width), h: Math.round(ph.height) },
      playheadAligned: Math.abs(ph.x - first.x) < 1.5 && Math.abs(ph.width - first.width) < 1.5,
      playheadCovered: ph.width >= first.width - 1 && ph.height >= cells.h - 2,
      stageBox: box('.stage'),
      rackBox: box('.rack'),
      railScroll: (() => {
        const s = document.getElementById('railscroll');
        return { sw: s.scrollWidth, cw: s.clientWidth, canScroll: s.scrollWidth > s.clientWidth + 1 };
      })(),
      clippedText: cut,
      contrast: {
        bodyOnBg: contrast('body', 'body'),
        dimOnPanel: contrast('.note', '.rack'),
      },
      railColorPixels: Array.from(document.querySelectorAll('.cell.on')).length,
      hiddenControls: Array.from(document.querySelectorAll('.rack button, .rack input, .rack select')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 1 || r.height < 1;
      }).length,
    };
  });

  line(`\n===== ${label} ${geo.viewport.w}x${geo.viewport.h} =====`);
  line(`page scroll ${geo.page.sw}x${geo.page.sh} · page overflow: ${geo.page.sw > geo.viewport.w + 1 ? 'YES' : 'no'}`);
  line(`stage ${JSON.stringify(geo.stageBox)} · rack ${JSON.stringify(geo.rackBox)}`);
  line(`rails heights ${JSON.stringify(geo.rows)} · cells ${JSON.stringify(geo.cells)}`);
  line(`first cell ${JSON.stringify(geo.firstCell)} · last cell right ${geo.lastCell.right}`);
  line(`playhead ${JSON.stringify(geo.playhead)} aligned=${geo.playheadAligned} spansHeight=${geo.playheadCovered}`);
  line(`rail scroller ${JSON.stringify(geo.railScroll)}`);
  line(`lit cells ${geo.railColorPixels} · hidden rack controls ${geo.hiddenControls}`);
  line(`text overflow/clipping: ${geo.clippedText.length ? JSON.stringify(geo.clippedText.slice(0, 6)) : 'none'}`);
  line(`contrast body/bg ${geo.contrast.bodyOnBg} · note/rack ${geo.contrast.dimOnPanel}`);

  const shot = `qa/probe-${label}.png`;
  await page.screenshot({ path: shot, fullPage: false });
  if (isMobile) {
    await page.screenshot({ path: `qa/probe-${label}-full.png`, fullPage: true });
    await analyse(page, `qa/probe-${label}.png`, `${label} viewport`);
    await analyse(page, `qa/probe-${label}-full.png`, `${label} full page`);
  } else {
    await analyse(page, shot, label);
  }
  await ctx.close();
}

await browser.close();
