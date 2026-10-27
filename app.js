/* PDF Compress — pages rendered by pdf.js (Mozilla, Apache-2.0), rebuilt as JPEG pages by pdf-lib (MIT). Everything runs in this tab. */
import * as pdfjsLib from "./lib/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

const { $, $$, h } = S3;
const { PDFDocument, PDFName, degrees } = PDFLib;
const PRESETS = { email: { dpi: 96, q: 55 }, balanced: { dpi: 144, q: 72 }, high: { dpi: 220, q: 85 } };
const MAX_PX = 25e6; // per page, keeps phones from running out of memory at 300 DPI on huge pages

// ---------- core (pure, testable) ----------
function openJs(bytes) { return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise; }
function scaleFor(vp1, dpi) { let s = dpi / 72; const px = vp1.width * vp1.height * s * s; if (px > MAX_PX) s *= Math.sqrt(MAX_PX / px); return s; }
async function renderCanvas(page, scale, hooks) {
  const vp = page.getViewport({ scale }), c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
  const task = page.render({ canvasContext: x, viewport: vp, background: "#ffffff" });
  if (hooks) hooks.task = task;
  await task.promise;
  return c;
}
function toGray(c) {
  const x = c.getContext("2d"), im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = g; }
  x.putImageData(im, 0, 0);
}
function jpeg(c, q) { return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("JPEG encoding failed (page too large?)")), "image/jpeg", q / 100)); }
// opt: {dpi, q (30-95), gray}. hooks: {progress(i, n), cancelled() -> bool}
async function compress(js, opt, hooks) {
  hooks = hooks || {};
  const out = await PDFDocument.create();
  for (let i = 1; i <= js.numPages; i++) {
    if (hooks.cancelled && hooks.cancelled()) throw new Error("cancelled");
    const page = await js.getPage(i), vp1 = page.getViewport({ scale: 1 });
    const c = await renderCanvas(page, scaleFor(vp1, opt.dpi), hooks);
    if (opt.gray) toGray(c);
    const img = await out.embedJpg(new Uint8Array(await (await jpeg(c, opt.q)).arrayBuffer()));
    out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    c.width = c.height = 0; page.cleanup();
    if (hooks.progress) hooks.progress(i, js.numPages);
  }
  try { const m = await js.getMetadata(); if (m.info && m.info.Title) out.setTitle(String(m.info.Title)); if (m.info && m.info.Author) out.setAuthor(String(m.info.Author)); } catch (e) { /* no info */ }
  out.setProducer("S3eidat Tools PDF Compress"); out.setCreator("S3eidat Tools");
  return out.save();
}
function verdict(before, after) { return after >= before ? "bigger" : 1 - after / before < 0.05 ? "same" : "smaller"; }

// ---------- UI ----------
const st = { file: null, base: "", bytes: null, js: null, pv: 0, out: null, running: false, cancel: false, hooks: null };
const saved = S3.store("compress.opt") || {};
const opt = { dpi: saved.dpi || 144, q: saved.q || 72, gray: !!saved.gray };
function syncControls() {
  $("#dpi").value = opt.dpi; $("#q").value = opt.q; $("#gray").checked = opt.gray;
  $("#dpiVal").textContent = opt.dpi + " DPI"; $("#qVal").textContent = opt.q + "%";
  const p = Object.keys(PRESETS).find(k => PRESETS[k].dpi === opt.dpi && PRESETS[k].q === opt.q);
  $$("#preset button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === p)));
}
function changed() { S3.store("compress.opt", opt); syncControls(); stale(); preview(); }
$$("#preset button").forEach(b => b.addEventListener("click", () => { Object.assign(opt, PRESETS[b.dataset.v]); changed(); }));
$("#dpi").addEventListener("input", () => { opt.dpi = +$("#dpi").value; syncControls(); });
$("#q").addEventListener("input", () => { opt.q = +$("#q").value; syncControls(); });
["#dpi", "#q"].forEach(s => $(s).addEventListener("change", changed));
$("#gray").addEventListener("change", () => { opt.gray = $("#gray").checked; changed(); });
syncControls();
function stale() { if (st.out) { $("#result").classList.add("cp-stale"); $("#verdict").textContent = "Settings changed. Compress again to apply them."; $("#verdict").className = "cp-verdict mt"; } }

// preview: original (sharp) vs the exact JPEG this page would become
let pvGen = 0, pvUrl = null;
const preview = S3.debounce(async () => {
  if (!st.js) return;
  const g = ++pvGen, i = st.pv, A = $("#paneA"), B = $("#paneB");
  $("#pvPage").textContent = "page " + (i + 1) + " of " + st.js.numPages;
  $("#pvPrev").disabled = i === 0; $("#pvNext").disabled = i >= st.js.numPages - 1;
  try {
    const page = await st.js.getPage(i + 1), vp1 = page.getViewport({ scale: 1 }), s = scaleFor(vp1, opt.dpi);
    const sharp = await renderCanvas(page, Math.max(s, Math.min(3, scaleFor(vp1, 216))));
    const c = await renderCanvas(page, s); if (opt.gray) toGray(c);
    const blob = await jpeg(c, opt.q);
    if (g !== pvGen) return;
    if (pvUrl) URL.revokeObjectURL(pvUrl);
    pvUrl = URL.createObjectURL(blob);
    const img = h("img", { src: pvUrl, alt: "Page " + (i + 1) + " after compression" });
    const dpr = window.devicePixelRatio || 1, zw = Math.round(c.width / dpr) + "px";
    img.dataset.zw = zw; sharp.dataset.zw = zw; sharp.setAttribute("aria-label", "Page " + (i + 1) + " original");
    A.innerHTML = ""; B.innerHTML = ""; A.appendChild(sharp); B.appendChild(img); applyZoom();
    $("#capB").textContent = "Compressed · " + c.width + "×" + c.height + " px";
    const n = st.js.numPages;
    $("#estimate").textContent = "This page at these settings: " + S3.fmtBytes(blob.size) + (n > 1 ? ". Rough total for " + n + " pages: ≈ " + S3.fmtBytes(blob.size * n) + " (pages differ)." : ".");
    c.width = c.height = 0;
  } catch (e) { if (g === pvGen) { B.innerHTML = ""; B.appendChild(h("span", { "class": "faint", text: "Preview unavailable for this page" })); } }
}, 250);
function applyZoom() {
  const z = $("#zoom").checked; $("#compare").classList.toggle("zoomed", z);
  $$(".cp-pane > img, .cp-pane > canvas").forEach(el => { el.style.width = z ? el.dataset.zw : ""; });
}
$("#zoom").addEventListener("change", applyZoom);
let syncing = false;
[["#paneA", "#paneB"], ["#paneB", "#paneA"]].forEach(([a, b]) => $(a).addEventListener("scroll", () => {
  if (syncing) { syncing = false; return; }
  syncing = true; $(b).scrollTop = $(a).scrollTop; $(b).scrollLeft = $(a).scrollLeft;
}));
$("#pvPrev").addEventListener("click", () => { if (st.pv > 0) { st.pv--; preview(); } });
$("#pvNext").addEventListener("click", () => { if (st.js && st.pv < st.js.numPages - 1) { st.pv++; preview(); } });

async function openFile(file) {
  try {
    const bytes = new Uint8Array(await S3.readFile(file));
    let js;
    try { js = await openJs(bytes); }
    catch (e) { throw new Error(e && e.name === "PasswordException" ? "This PDF needs a password to open. Remove the protection first." : "This file couldn't be read as a PDF."); }
    if (st.js) st.js.destroy();
    Object.assign(st, { file, base: file.name.replace(/\.pdf$/i, "") || "document", bytes, js, pv: 0, out: null });
    $("#fname").textContent = file.name;
    $("#fmeta").textContent = js.numPages + " page" + (js.numPages > 1 ? "s" : "") + " · " + S3.fmtBytes(file.size);
    $("#dropCard").hidden = true; $("#work").hidden = false; $("#result").hidden = true;
    preview();
  } catch (e) { S3.toast(e.message, "error"); }
}
const fileInput = S3.drop($("#drop"), files => openFile(files[0]), { accept: ".pdf,application/pdf", multiple: false });
$("#change").addEventListener("click", () => { if (!st.running) fileInput.click(); });

async function run() {
  if (!st.js || st.running) return;
  st.running = true; st.cancel = false; st.out = null;
  const go = $("#go"), t0 = performance.now(); go.disabled = true; $("#cancel").hidden = false; $("#progress").hidden = false; $("#result").hidden = true;
  $("#bar").style.width = "0%"; $("#ptext").textContent = "Starting…";
  st.hooks = { progress: (i, n) => { $("#bar").style.width = (i / n * 100) + "%"; $("#ptext").textContent = "Page " + i + " of " + n; }, cancelled: () => st.cancel };
  try {
    const out = await compress(st.js, { dpi: opt.dpi, q: opt.q, gray: opt.gray }, st.hooks);
    st.out = out; showResult(out.length, (performance.now() - t0) / 1000);
  } catch (e) {
    if (st.cancel || /cancel/i.test(e && (e.message || e.name))) S3.toast("Cancelled");
    else S3.toast("Compression failed: " + (e && e.message || e), "error");
  }
  st.running = false; go.disabled = false; $("#cancel").hidden = true; $("#progress").hidden = true;
}
function showResult(after, secs) {
  const before = st.bytes.length, v = verdict(before, after), pct = Math.round((1 - after / before) * 100);
  const stat = (label, value, hi) => h("div", { "class": "stat" + (hi ? " cp-hi" : "") }, [h("b", { text: value }), h("span", { text: label })]);
  const s = $("#stats"); s.innerHTML = "";
  [stat("before", S3.fmtBytes(before)), stat("after", S3.fmtBytes(after), v !== "bigger"), stat(v === "bigger" ? "bigger" : "smaller", (v === "bigger" ? "+" + Math.abs(pct) : pct) + "%"), stat("seconds", secs.toFixed(1))].forEach(x => s.appendChild(x));
  const vt = $("#verdict"); vt.innerHTML = "";
  if (v === "bigger") {
    vt.className = "cp-verdict mt bad";
    vt.append(h("b", { text: "The result is bigger than your original. " }), "Your PDF is already efficient (probably mostly text or vector drawings), so keep the original. Lower the resolution or quality if you still want to try.");
  } else if (v === "same") {
    vt.className = "cp-verdict mt bad";
    vt.append(h("b", { text: "Only " + pct + "% smaller. " }), "The original is already compact; it may not be worth losing selectable text for this.");
  } else {
    vt.className = "cp-verdict mt good";
    vt.append(h("b", { text: pct + "% smaller. " }), "Check the preview to make sure the text is still easy to read.");
  }
  $("#dlOrig").hidden = v === "smaller";
  $("#dlOutLbl").textContent = v === "bigger" ? "Download anyway" : "Download compressed";
  $("#dlOut").className = "btn" + (v === "bigger" ? "" : " primary");
  $("#dlOrig").className = "btn" + (v === "bigger" ? " primary" : "");
  $("#result").hidden = false; $("#result").classList.remove("cp-stale");
}
$("#go").addEventListener("click", run);
$("#cancel").addEventListener("click", () => { st.cancel = true; if (st.hooks && st.hooks.task) try { st.hooks.task.cancel(); } catch (e) { /* done already */ } });
$("#dlOut").addEventListener("click", () => { if (st.out) { S3.download(new Blob([st.out], { type: "application/pdf" }), st.base + "-compressed.pdf"); S3.done(); } });
$("#dlOrig").addEventListener("click", () => { if (st.bytes) S3.download(new Blob([st.bytes], { type: "application/pdf" }), st.file.name); });

// ---------- sample (a fake scan, drawn here) + self-test ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function scanPage(k) {
  const c = document.createElement("canvas"); c.width = 1000; c.height = 1414;
  const x = c.getContext("2d"), r = rng(7 + k), words = "the site survey shows that the north wall needs new drainage before the winter rains and the roof tiles on the east side should be replaced within two months".split(" ");
  x.fillStyle = "#f2eee4"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#2a2723"; x.font = "bold 40px Georgia, serif"; x.fillText(["Site inspection report", "Photos and findings", "Cost estimate"][k % 3], 80, 140);
  x.font = "21px Georgia, serif";
  const para = (y0, rows) => { for (let l = 0; l < rows; l++) { let s = "", n = 9 + Math.floor(r() * 4); for (let w = 0; w < n; w++) s += words[Math.floor(r() * words.length)] + " "; x.fillText(s.trim(), 80, y0 + l * 34); } };
  para(210, 9);
  const g = x.createLinearGradient(0, 540, 0, 900); g.addColorStop(0, "#9cc3d9"); g.addColorStop(1, "#e6dcc4");
  x.fillStyle = g; x.fillRect(80, 540, 840, 360);
  x.fillStyle = "#6d8a5a"; x.beginPath(); x.moveTo(80, 900); for (let i = 0; i <= 20; i++) x.lineTo(80 + i * 42, 780 - Math.sin(i * 0.7 + k) * 60 - r() * 30); x.lineTo(920, 900); x.fill();
  x.fillStyle = "#b5523b"; x.fillRect(420 + k * 40, 700, 160, 130); x.fillStyle = "#7a2f22"; x.beginPath(); x.moveTo(400 + k * 40, 705); x.lineTo(500 + k * 40, 630); x.lineTo(600 + k * 40, 705); x.fill();
  x.fillStyle = "#2a2723"; para(960, 10);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(im, 0, 0);
  return c;
}
const pngBytes = c => new Promise(res => c.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), "image/png"));
async function samplePdf() {
  const d = await PDFDocument.create();
  for (let k = 0; k < 3; k++) { const img = await d.embedPng(await pngBytes(scanPage(k))), p = d.addPage([595.28, 841.89]); p.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 }); }
  return d.save();
}
window.S3_DEMO = async () => {
  await openFile(new File([await samplePdf()], "Site inspection (scan).pdf", { type: "application/pdf" }));
  Object.assign(opt, PRESETS.balanced, { gray: false }); syncControls();
  await run();
  await new Promise(r => setTimeout(r, 900));
};

function xobj(page) { // first image XObject on a pdf-lib page: {filter, w, h}
  const xo = page.node.Resources().lookup(PDFName.of("XObject")), key = xo && xo.keys()[0], s = key && xo.lookup(key);
  return s ? { filter: String(s.dict.get(PDFName.of("Filter"))), w: s.dict.get(PDFName.of("Width")).asNumber(), h: s.dict.get(PDFName.of("Height")).asNumber() } : null;
}
window.S3_SELFTEST = async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  // 3 pages: a noisy photo page (compressible), a red page, a rotated page
  const d = await PDFDocument.create(), noise = document.createElement("canvas"); noise.width = noise.height = 500;
  const nx = noise.getContext("2d"), im = nx.createImageData(500, 500), r = rng(1);
  for (let i = 0; i < im.data.length; i += 4) { im.data[i] = r() * 255; im.data[i + 1] = r() * 255; im.data[i + 2] = r() * 255; im.data[i + 3] = 255; }
  nx.putImageData(im, 0, 0);
  const p1 = d.addPage([595.28, 841.89]); p1.drawImage(await d.embedPng(await pngBytes(noise)), { x: 0, y: 0, width: 595.28, height: 841.89 });
  const p2 = d.addPage([300, 500]); p2.drawRectangle({ x: 0, y: 0, width: 300, height: 500, color: PDFLib.rgb(1, 0, 0) });
  const p3 = d.addPage([400, 300]); p3.setRotation(degrees(90));
  const bytes = await d.save();
  const js = await openJs(bytes); let seen = 0;
  const out = await compress(js, { dpi: 72, q: 60, gray: false }, { progress: i => { seen = i; } });
  const o = await PDFDocument.load(out), pages = o.getPages();
  ok(pages.length === 3 && seen === 3, "3 pages out, progress reported");
  const sz = pages.map(p => Math.round(p.getWidth()) + "x" + Math.round(p.getHeight())).join();
  ok(sz === "595x842,300x500,300x400", "original page sizes kept, rotation baked in: " + sz);
  ok(pages.every(p => p.getRotation().angle === 0), "no leftover rotation");
  const x1 = xobj(pages[0]), x2 = xobj(pages[1]);
  ok(x1 && /DCTDecode/.test(x1.filter) && x1.w === 595 && x1.h === 842, "page 1 is a JPEG at 72 DPI " + JSON.stringify(x1));
  ok(x2 && x2.w === 300 && x2.h === 500, "page 2 pixel size at 72 DPI");
  ok(out.length < bytes.length / 2, "noisy scan got much smaller (" + bytes.length + " -> " + out.length + ")");
  const oj = await openJs(out), pg = await oj.getPage(2), c = await renderCanvas(pg, 1), px = c.getContext("2d").getImageData(150, 250, 1, 1).data;
  ok(px[0] > 200 && px[1] < 60, "colour kept");
  const hi = await PDFDocument.load(await compress(js, { dpi: 150, q: 80, gray: true }, {}));
  const x2b = xobj(hi.getPage(1));
  ok(x2b && x2b.w === 625 && x2b.h === 1042, "150 DPI pixel size " + JSON.stringify(x2b));
  const gj = await openJs(await hi.save()), gc = await renderCanvas(await gj.getPage(2), 1), gp = gc.getContext("2d").getImageData(150, 250, 1, 1).data;
  ok(Math.abs(gp[0] - gp[1]) < 8 && Math.abs(gp[1] - gp[2]) < 8, "grayscale has no colour " + Array.from(gp).join());
  let cancelled = false; try { await compress(js, { dpi: 72, q: 60 }, { cancelled: () => true }); } catch (e) { cancelled = e.message === "cancelled"; }
  ok(cancelled, "cancel stops the job");
  const t = await PDFDocument.create(); t.addPage([300, 300]).drawText("tiny", { x: 20, y: 20 });
  const tb = await t.save(), tj = await openJs(tb), tout = await compress(tj, { dpi: 150, q: 85 }, {});
  ok(verdict(tb.length, tout.length) === "bigger" && verdict(1000, 400) === "smaller" && verdict(1000, 980) === "same", "bigger-than-original detected");
  ok(Math.abs(scaleFor({ width: 595, height: 842 }, 300) - 300 / 72) < 1e-9 && scaleFor({ width: 5000, height: 5000 }, 300) * 5000 <= 5001, "pixel budget");
  [js, oj, gj, tj].forEach(x => x.destroy());
  return fails.length ? fails : true;
};
