// 暗号化した wiki を開いて表示する。ページの切り替えは #/ページ名 で、読み直しはしない。
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let key;       // AES-GCM の鍵
let site;      // 復号した wiki 全体
let editor = null; // 編集機能（edit.js）。[編集] → 編集キー → 中継（Cloudflare Worker）経由で GitHub に保存
const pageById = new Map();
const blobUrls = new Map(); // asset id -> Promise<blob URL>
const textCache = new Map(); // page id -> 本文の文字だけ（検索用）

// ---------- 鍵と復号 ----------
const meta = await (await fetch(`meta.json`, { cache: "no-store" })).json();
const STORE = `ca-wiki-key:${meta.salt}`;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: unb64(meta.salt), iterations: meta.iterations },
    base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
}
async function decrypt(buf) {
  const bytes = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}
async function loadSite() {
  const enc = await (await fetch(`site.bin`, { cache: "no-store" })).arrayBuffer();
  const gz = await decrypt(enc); // パスワード違いはここで例外になる
  const json = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(json);
}
function assetUrl(id, mime) {
  if (!blobUrls.has(id)) {
    blobUrls.set(id, (async () => {
      const enc = await (await fetch(`a/${id}.bin`)).arrayBuffer();
      return URL.createObjectURL(new Blob([await decrypt(enc)], { type: mime }));
    })());
  }
  return blobUrls.get(id);
}

async function unlockWithStoredKey() {
  let raw = null;
  try { raw = localStorage.getItem(STORE); } catch { return false; }
  if (!raw) return false;
  key = await crypto.subtle.importKey("raw", unb64(raw), "AES-GCM", true, ["decrypt"]);
  try { site = await loadSite(); } catch { localStorage.removeItem(STORE); return false; }
  return true;
}

function showLock() {
  const form = $("#lock");
  form.hidden = false;
  $("#lock-input").focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "確認中…";
    $("#lock-error").hidden = true;
    key = await deriveKey($("#lock-input").value);
    try {
      site = await loadSite();
    } catch {
      $("#lock-error").textContent = "パスワードが違います。";
      $("#lock-error").hidden = false;
      btn.disabled = false;
      btn.textContent = "開く";
      $("#lock-input").select();
      return;
    }
    if ($("#lock-remember").checked) {
      try { localStorage.setItem(STORE, b64(await crypto.subtle.exportKey("raw", key))); } catch { /* 保存できない環境では毎回入力 */ }
    }
    form.hidden = true;
    await start();
  });
}

// ---------- 左メニュー ----------
function renderMenu() {
  const out = [`<h2><a href="#/">トップページ</a></h2>`];
  for (const sec of site.menu) {
    out.push(`<h3>${esc(sec.name)}</h3><ul>`);
    for (const id of sec.pages) out.push(`<li><a href="#/${encodeURIComponent(id)}" data-id="${esc(id)}">${esc(pageById.get(id).title)}</a></li>`);
    out.push("</ul>");
    sec.groups.forEach((g, i) => {
      if (g.name) out.push(`<h4>${esc(g.name)}</h4>`);
      else if (i > 0) out.push(`<hr class="menu-sep">`);
      out.push("<ul>");
      for (const id of g.pages) out.push(`<li><a href="#/${encodeURIComponent(id)}" data-id="${esc(id)}">${esc(pageById.get(id).title)}</a></li>`);
      out.push("</ul>");
    });
    if (sec.files.length) {
      out.push(`<ul class="files">`);
      for (const f of sec.files) out.push(`<li><a class="file" href="#" data-asset="${f.asset}" data-mime="${f.mime}">${esc(f.title)}</a></li>`);
      out.push("</ul>");
    }
  }
  const nav = $("#menubar");
  nav.innerHTML = out.join("");
  nav.hidden = false;
  hydrateAssets(nav);
}
function markCurrent(id) {
  for (const a of document.querySelectorAll("#menubar a[data-id]")) a.classList.toggle("current", a.dataset.id === id);
  const cur = $("#menubar a.current");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

// 画像と PDF は、表示した後で1つずつ復号して差し込む
// PDF は大きいので、押したときに初めて復号する（先に空のタブを開き、復号が済んだら中身を入れる）
function hydrateAssets(root) {
  for (const el of root.querySelectorAll("[data-asset]")) {
    if (el.tagName !== "IMG") {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const tab = window.open("", "_blank");
        assetUrl(el.dataset.asset, el.dataset.mime).then((url) => { tab.location.href = url; });
      });
      continue;
    }
    assetUrl(el.dataset.asset, el.dataset.mime).then((url) => {
      el.src = url;
      if (el.classList.contains("portrait") || el.classList.contains("embed")) {
        el.addEventListener("click", () => window.open(url, "_blank"));
      }
    });
  }
}

// ---------- 画面 ----------
const view = () => $("#view");
function crumbs(parts) {
  return `<div class="breadcrumbs">${parts.map((x) => x).join(" &gt; ")}</div>`;
}
function renderTop() {
  document.title = site.title;
  const recent = site.pages.filter((p) => !p.char).sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 10);
  view().innerHTML = `
    <h1 class="title">${esc(site.title)}</h1>
    <p>ChronoAbyss の世界観・キャラクター・ストーリーの設定資料です。左のメニューから各ページへ移動できます。右上の検索で全ページの本文を探せます。</p>
    <h2>ページ一覧</h2>
    <div class="table-wrap"><table class="index-table"><tbody>
    ${site.menu.map((s) => `<tr><th>${esc(s.name)}</th><td>${s.pages.map((id) => `<a href="#/${encodeURIComponent(id)}">${esc(pageById.get(id).title)}</a>`).join(" / ")}${s.files.map((f) => ` / <a class="file" href="#" data-asset="${f.asset}" data-mime="${f.mime}">${esc(f.title)}</a>`).join("")}</td></tr>`).join("")}
    </tbody></table></div>
    <h2>最近の更新</h2>
    <ul class="recent">${recent.map((p) => `<li><span class="date">${p.mtime}</span> <a href="#/${encodeURIComponent(p.id)}">${esc(p.title)}</a></li>`).join("")}</ul>
    <p class="built">最終公開：${site.built}　全 ${site.pages.length} ページ</p>`;
  hydrateAssets(view());
  markCurrent(null);
}
function renderPage(p, anchor) {
  document.title = `${p.title} - ${site.title}`;
  const parts = [`<a href="#/">トップ</a>`, esc(p.section)];
  if (p.group) parts.push(esc(p.group));
  parts.push(esc(p.title));
  const toc = p.toc.length >= 3 ? `<div class="contents"><div class="contents-title">目次</div><ul>${p.toc.map((h) => `<li class="lv${h.level}"><a href="#/${encodeURIComponent(p.id)}#${esc(h.id)}">${esc(h.text)}</a></li>`).join("")}</ul></div>` : "";
  view().innerHTML = `${crumbs(parts)}<h1 class="title">${esc(p.title)}</h1><div class="lastmodified">最終更新：${p.mtime}</div>${toc}<div class="page">${p.html}</div>`;
  hydrateAssets(view());
  markCurrent(p.id);
  editor?.afterPage(p);
  if (anchor) document.getElementById(anchor)?.scrollIntoView();
  else window.scrollTo(0, 0);
}
function renderNotFound(id) {
  document.title = site.title;
  view().innerHTML = `<h1 class="title">ページが見つかりません</h1><p>「${esc(id)}」というページはありません。<a href="#/">トップページ</a>へ戻る。</p>`;
  markCurrent(null);
}

// ---------- 検索 ----------
function plainText(p) {
  if (!textCache.has(p.id)) {
    const d = document.createElement("div");
    d.innerHTML = p.html;
    textCache.set(p.id, d.textContent.replace(/\s+/g, " "));
  }
  return textCache.get(p.id);
}
function search(q) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const p of site.pages) {
    const title = p.title.toLowerCase();
    const text = plainText(p);
    const lower = text.toLowerCase();
    if (!words.every((w) => title.includes(w) || lower.includes(w))) continue;
    const titleHit = words.some((w) => title.includes(w));
    const at = lower.indexOf(words[0]);
    const snippet = at >= 0 ? text.slice(Math.max(0, at - 40), at + 80) : text.slice(0, 120);
    const count = words.reduce((n, w) => n + lower.split(w).length - 1, 0);
    hits.push({ p, titleHit, count, snippet });
  }
  return hits.sort((a, b) => (b.titleHit - a.titleHit) || (b.count - a.count));
}
function highlight(s, words) {
  let h = esc(s);
  for (const w of words) h = h.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
  return h;
}
function renderSearch(q) {
  document.title = `検索：${q} - ${site.title}`;
  const words = q.trim().split(/\s+/).filter(Boolean);
  const hits = search(q);
  view().innerHTML = `${crumbs([`<a href="#/">トップ</a>`, "検索"])}<h1 class="title">「${esc(q)}」の検索結果</h1>
    <p>${hits.length} ページ見つかりました。</p>
    <ul class="results">${hits.map((h) => `<li><a href="#/${encodeURIComponent(h.p.id)}">${esc(h.p.title)}</a> <span class="result-section">${esc(h.p.section)}</span><div class="snippet">…${highlight(h.snippet, words)}…</div></li>`).join("")}</ul>`;
  markCurrent(null);
}

// ---------- 道順 ----------
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  document.body.classList.remove("menu-open", "editing");
  if (h.startsWith("search/")) return renderSearch(h.slice(7));
  if (editor && h.startsWith("edit/")) return editor.open(h.slice(5));
  if (!h) return renderTop();
  const [id, anchor] = h.split("#");
  const p = pageById.get(id);
  return p ? renderPage(p, anchor) : renderNotFound(id);
}

function indexPages() {
  pageById.clear();
  textCache.clear();
  for (const p of site.pages) pageById.set(p.id, p);
}
// 保存後：組み立て直した wiki を読み直して、今の画面を描き直す
async function reloadSite() {
  site = await loadSite();
  indexPages();
  renderMenu();
}

async function start() {
  indexPages();
  {
    editor = (await import("./edit.js?v=6cfeca0811")).install({ site: () => site, $, esc, view, crumbs, markCurrent, pageById, reloadSite, route, hydrateAssets });
  }
  $("#site-title").textContent = site.title;
  $("#footer").textContent = `${site.title}　最終公開 ${site.built}`;
  renderMenu();
  const form = $("#search");
  form.hidden = false;
  const input = $("#search-input");
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (input.value.trim()) location.hash = `#/search/${encodeURIComponent(input.value.trim())}`; }, 250);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const hits = search(input.value);
    if (hits.length) location.hash = `#/${encodeURIComponent(hits[0].p.id)}`;
  });
  const toggle = $("#menu-toggle");
  toggle.hidden = false;
  toggle.addEventListener("click", () => document.body.classList.toggle("menu-open"));
  window.addEventListener("hashchange", route);
  route();
}

if (await unlockWithStoredKey()) await start();
else showLock();
