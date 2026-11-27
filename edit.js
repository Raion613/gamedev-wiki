// 編集機能。各ページの題名の右に [編集] を出す。押すと編集キーを聞き（覚えさせれば次からは聞かない）、
// 元の文章（Markdown）を中継（Cloudflare Worker）経由で GitHub から読み、保存すると GitHub が組み立てて公開版に出す。
// 中継の場所は暗号化した site の editApi（閲覧パスワードを知らない人には見えない）。
// 編集画面：上にツールバー、左に文字の欄（CodeMirror 6）、右に公開版と同じ規則のプレビュー（打つたびに描き直す）。
// 「記法」で早見を開く。部品は editor.js（build.mjs が src/editor/main.mjs からまとめる）を編集を開いたときだけ読む。
const KEY_STORE = "ca-wiki-editkey";
const MODE_STORE = "ca-wiki-editmode";

const CSS = `
.edit-link { float: right; font-size: 14px; font-weight: 400; margin-top: 2px; padding: 2px 14px; border: 1px solid #999; border-radius: 2px; background: #f4f4f4; color: #333; text-decoration: none; }
.edit-link:hover { background: #e8e8e8; }
.edit-error { color: #b00; white-space: pre-wrap; }
#edit-notice { position: fixed; right: 12px; bottom: 12px; z-index: 50; background: #fff8d8; border: 1px solid #c9b458; padding: 6px 10px; font-size: 13px; box-shadow: 0 1px 4px rgba(0,0,0,.2); }
#edit-notice[hidden] { display: none; }

body.editing .container-wrapper { max-width: none; }
body.editing #columns { grid-template-columns: 1fr; }
body.editing #menubar, body.editing #menu-toggle { display: none !important; }
body.editing #body { padding-bottom: 0; }

.ed-toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 5px 6px; background: #f5f5f5; border: 1px solid #ccc; border-bottom: 0; }
.ed-group { display: flex; gap: 2px; }
.ed-group + .ed-group { padding-left: 10px; border-left: 1px solid #d4d4d4; }
.ed-toolbar button { font: 13px/1 Verdana, Arial, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; letter-spacing: 0; min-width: 30px; height: 28px; padding: 0 8px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: #222; cursor: pointer; white-space: nowrap; }
.ed-toolbar button:hover { background: #fff; border-color: #bbb; }
.ed-toolbar button:active { background: #e6e6e6; }
.ed-toolbar button[aria-pressed="true"] { background: #fff; border-color: #888; font-weight: 700; }
.ed-toolbar .b { font-weight: 700; }
.ed-right { margin-left: auto; }
.ed-mode button { border-color: #ccc; border-radius: 0; margin-left: -1px; background: #fafafa; }
.ed-mode button:first-child { border-radius: 3px 0 0 3px; }
.ed-mode button:last-child { border-radius: 0 3px 3px 0; }

.ed-main { display: grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 150px); min-height: 420px; border: 1px solid #ccc; }
.ed-main[data-mode="src"] { grid-template-columns: 1fr; }
.ed-main[data-mode="src"] .ed-preview { display: none; }
.ed-main[data-mode="preview"] { grid-template-columns: 1fr; }
.ed-main[data-mode="preview"] .ed-src { display: none; }
.ed-main.help-open { grid-template-columns: 1fr 1fr 300px; }
.ed-main.help-open[data-mode="src"], .ed-main.help-open[data-mode="preview"] { grid-template-columns: 1fr 300px; }
.ed-src { min-width: 0; min-height: 0; }
.ed-preview { min-width: 0; overflow-y: auto; padding: 4px 20px 40px; border-left: 1px solid #ccc; background: #fff; }
.ed-preview-label { position: sticky; top: 0; margin: 0 -20px 8px; padding: 2px 20px; font-size: 11px; color: #888; background: #fafafa; border-bottom: 1px solid #eee; letter-spacing: .1em; }
.ed-main[data-mode="preview"] .ed-preview { border-left: 0; }
.ed-help { display: none; min-width: 0; overflow-y: auto; border-left: 1px solid #ccc; background: #fbfbfb; font-size: 12.5px; line-height: 1.6; padding: 6px 12px 30px; }
.ed-main.help-open .ed-help { display: block; }
.ed-help h3 { font-size: 13px; margin: 14px 0 4px; padding: 0 0 2px; border-bottom: 1px solid #ddd; background: none; border-left: 0; }
.ed-help table { border-collapse: collapse; width: 100%; }
.ed-help td { padding: 3px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
.ed-help td:first-child { width: 48%; }
.ed-help code { display: inline-block; font: 12px/1.5 Consolas, "BIZ UDGothic", monospace; background: #fff; border: 1px solid #ddd; padding: 0 4px; white-space: pre; cursor: pointer; }
.ed-help code:hover { border-color: #2f6db5; }
.ed-help .note { color: #666; margin: 6px 0; }
.ed-help pre { font: 12px/1.5 Consolas, "BIZ UDGothic", monospace; background: #fff; border: 1px solid #ddd; padding: 4px 6px; margin: 4px 0; }

.ed-foot { position: sticky; bottom: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 8px 0 10px; background: #fff; }
.ed-foot .save { font: 700 14px Verdana, Arial, Meiryo, sans-serif; padding: 6px 22px; border: 1px solid #1f5a96; border-radius: 3px; background: #2f6db5; color: #fff; cursor: pointer; }
.ed-foot .save:hover { background: #255d9c; }
.ed-foot .save:disabled { background: #9db6d3; border-color: #9db6d3; cursor: default; }
.ed-foot .status { color: #666; font-size: 12px; }
.ed-foot .warn { color: #b33; font-size: 12px; }

@media (max-width: 900px) {
  .ed-main, .ed-main.help-open { grid-template-columns: 1fr !important; height: calc(100vh - 210px); }
  .ed-main:not([data-mode="preview"]) .ed-preview { display: none; }
  .ed-main[data-mode="preview"] .ed-src { display: none; }
  .ed-main.help-open .ed-src, .ed-main.help-open .ed-preview { display: none; }
  .ed-mode [data-mode="split"] { display: none; }
}
`;

// 記法の早見。[書くこと, 表示]。書くことを押すと、カーソルの所に入る
const HELP = [
  ["見出し", [["## 大見出し", "目次に出る（題名の次の大きさ）"], ["### 中見出し", "目次に出る"], ["#### 小見出し", "目次に出ない"]]],
  ["文字", [["**太字**", "<b>太字</b>"], ["行を変える", "そのまま改行になる"], ["（空の行）", "段落が分かれる"], ["---", "横線（1行に単独で）"]]],
  ["箇条書き", [["- 項目", "・項目"], ["  - 下の項目", "字下げした項目（Tab）"], ["1. 番号の項目", "1. 番号の項目"], ["> 引用", "引用の枠"]]],
  ["リンク", [["[[ページ名]]", "そのページへ（[[ と打つと候補が出る）"], ["[[ページ名|表示する文字]]", "文字を変えたリンク"], ["[[ページ名#見出し]]", "その見出しへ直接"]]],
  ["画像・PDF", [["![[画像.webp]]", "画像を載せる（![[ で候補）"], ["![[画像.webp|300]]", "幅300ピクセルで載せる"], ["[[資料.pdf]]", "PDF を開くリンク"]]],
  ["注釈", [["本文[^1]", "注釈の番号"], ["[^1]: 中身", "ページの下にまとめて出る"]]],
];
const HELP_KEYS = `
<h3>キー</h3>
<table>
<tr><td>Enter</td><td>箇条・番号・引用の印を次の行にも付ける。空の項目で押すと印が外れる</td></tr>
<tr><td>Tab / Shift+Tab</td><td>行を字下げ／字下げを戻す（箇条なら下の階層へ）</td></tr>
<tr><td>Ctrl+B / Ctrl+K</td><td>太字／リンク</td></tr>
<tr><td>Ctrl+Z / Ctrl+Y</td><td>元に戻す／やり直す</td></tr>
<tr><td>Ctrl+S</td><td>保存</td></tr>
</table>
<h3>表</h3>
<pre>| 見出し1 | 見出し2 |
|---|---|
| 中身 | 中身 |</pre>
<p class="note">2行目の |---| が見出しの区切り。数字を右寄せする列は ---: にする。表の中の | は \\| と書く。</p>
<h3>キャラのページ</h3>
<p class="note">一番上の「性別：」「年齢：」「身長：」の行は右上の基本情報の表へ移る。「項目：値」の行だけの塊は2列の表になる。</p>`;

export function install(app) {
  const { site, $, esc, view, crumbs, markCurrent, pageById, reloadSite, route, hydrateAssets } = app;
  const API = site().editApi;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const notice = document.createElement("div");
  notice.id = "edit-notice";
  notice.hidden = true;
  document.body.append(notice);

  let dirty = false;
  window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

  const readKey = () => { try { return localStorage.getItem(KEY_STORE) ?? sessionStorage.getItem(KEY_STORE); } catch { return null; } };
  const call = async (path, body) => {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: readKey(), ...body }) });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
    return data;
  };
  const pageBySrc = (src) => [...pageById.values()].find((p) => p.src === src);
  const head = (p) => `${crumbs([`<a href="#/">トップ</a>`, `<a href="#/${encodeURIComponent(p.id)}">${esc(p.title)}</a>`, "編集"])}<h1 class="title">「${esc(p.title)}」を編集</h1>`;

  function afterPage(p) {
    dirty = false;
    $("h1.title", view()).insertAdjacentHTML("afterbegin", `<a class="edit-link" href="#/edit/${encodeURIComponent(p.id)}">編集</a>`);
  }

  // 編集キーを聞く（合っていれば保存して次へ）
  function askKey(p, message = "") {
    view().innerHTML = `${head(p)}
      <form id="edit-key-form">
        <p>編集キーを入れてください。</p>
        <p><input id="edit-key" type="password" autocomplete="off" aria-label="編集キー"> <button type="submit">確認</button></p>
        <p><label><input id="edit-key-remember" type="checkbox" checked> このブラウザで覚える</label></p>
        <p class="edit-error" id="edit-key-error">${esc(message)}</p>
      </form>`;
    $("#edit-key").focus();
    $("#edit-key-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = $("#edit-key").value.trim();
      const store = $("#edit-key-remember").checked ? localStorage : sessionStorage;
      localStorage.removeItem(KEY_STORE);
      sessionStorage.removeItem(KEY_STORE);
      store.setItem(KEY_STORE, key);
      try {
        await call("/check", {});
      } catch (err) {
        store.removeItem(KEY_STORE);
        $("#edit-key-error").textContent = err.message;
        return;
      }
      open(p.id);
    });
  }

  async function open(id) {
    const p = pageById.get(id);
    if (!p) return route();
    markCurrent(p.id);
    document.title = `${p.title} を編集`;
    if (!readKey()) return askKey(p);
    document.body.classList.add("editing");
    view().innerHTML = `${head(p)}<p>読み込み中…</p>`;
    let source, ed;
    try {
      [source, ed] = await Promise.all([call("/source", { src: p.src }), import("./editor.js?v=6cfeca0811")]);
    } catch (err) {
      if (err.status === 403) { localStorage.removeItem(KEY_STORE); sessionStorage.removeItem(KEY_STORE); return askKey(p, err.message); }
      throw err;
    }
    let mode = "split";
    try { mode = localStorage.getItem(MODE_STORE) ?? mode; } catch { /* 覚えられない環境では毎回「左右」 */ }
    const btn = (cmd, label, title, cls = "") => `<button type="button" data-cmd="${cmd}" title="${title}" class="${cls}">${label}</button>`;
    view().innerHTML = `${head(p)}
      <div class="ed-toolbar" role="toolbar" aria-label="書式">
        <div class="ed-group">${btn("h2", "見出し2", "大見出し ## （目次に出る）")}${btn("h3", "見出し3", "中見出し ### （目次に出る）")}${btn("h4", "見出し4", "小見出し ####")}</div>
        <div class="ed-group">${btn("bold", "B", "太字 **文字**（Ctrl+B）", "b")}${btn("link", "リンク", "他のページへのリンク [[ページ名]]（Ctrl+K）")}${btn("image", "画像", "画像を載せる ![[ファイル名]]")}</div>
        <div class="ed-group">${btn("ul", "・箇条", "箇条書き - 項目")}${btn("ol", "1.番号", "番号付き 1. 項目")}${btn("indent", "→字下げ", "下の階層へ（Tab）")}${btn("outdent", "←戻す", "上の階層へ（Shift+Tab）")}${btn("quote", "引用", "引用 > 文")}</div>
        <div class="ed-group">${btn("table", "表", "表を入れる")}${btn("footnote", "注釈", "注釈 [^1] を入れる")}${btn("hr", "横線", "横線 ---")}</div>
        <div class="ed-group ed-right">
          <span class="ed-group ed-mode">${["src:編集", "split:左右", "preview:プレビュー"].map((s) => { const [m, l] = s.split(":"); return `<button type="button" data-mode="${m}" aria-pressed="${m === mode}">${l}</button>`; }).join("")}</span>
          <button type="button" id="ed-help-btn" aria-pressed="false" title="記法の早見を開く">記法</button>
        </div>
      </div>
      <div class="ed-main" data-mode="${mode}">
        <div class="ed-src"></div>
        <div class="ed-preview"><div class="ed-preview-label">プレビュー（保存すると公開版がこの表示になる）</div><div class="page" id="ed-preview-body"></div></div>
        <div class="ed-help">
          ${HELP.map(([h, rows]) => `<h3>${h}</h3><table>${rows.map(([src, out]) => `<tr><td><code data-insert="${esc(src)}" title="押すと入る">${esc(src)}</code></td><td>${out}</td></tr>`).join("")}</table>`).join("")}
          ${HELP_KEYS}
          ${site().manual ? `<p class="note"><a href="#/${encodeURIComponent(site().manual)}" target="_blank">書き方の全部（別のタブ）</a></p>` : ""}
        </div>
      </div>
      <div class="ed-foot">
        <button type="button" class="save" id="edit-save">保存（Ctrl+S）</button>
        <a href="#/${encodeURIComponent(p.id)}">取り消して戻る</a>
        <span class="status" id="edit-status"></span>
        <span class="warn" id="edit-warn"></span>
        <span class="edit-error" id="edit-error"></span>
      </div>`;
    window.scrollTo(0, 0);
    const main = $(".ed-main");
    const preview = $(".ed-preview");
    const render = ed.createPreview(site());
    let timer = 0;
    const draw = (text) => {
      const r = render(text, p);
      const toc = r.toc.length >= 3 ? `<div class="contents"><div class="contents-title">目次</div><ul>${r.toc.map((h) => `<li class="lv${h.level}">${esc(h.text)}</li>`).join("")}</ul></div>` : "";
      const body = $("#ed-preview-body");
      body.innerHTML = toc + r.html;
      for (const img of body.querySelectorAll('img[data-asset=""]')) img.replaceWith(Object.assign(document.createElement("span"), { className: "nolink", textContent: `${img.alt}（公開版にまだ無い画像。保存すると組み立てで入る）` }));
      hydrateAssets(body);
      $("#edit-warn").textContent = r.unresolved.length ? `行き先の無いリンク：${[...new Set(r.unresolved)].join("、")}` : "";
    };
    const cm = ed.createEditor({
      parent: $(".ed-src"),
      doc: source.text,
      pageNames: ed.pageCompletions(site()),
      mediaNames: ed.mediaCompletions(site()),
      onChange: (text) => {
        dirty = true;
        $("#edit-status").textContent = "未保存";
        clearTimeout(timer);
        timer = setTimeout(() => draw(text), 120);
      },
      onSave: () => save(),
      // 文字の欄を動かしたら、プレビューも同じ割合の所へ
      onScroll: () => {
        const s = cm.scrollDOM;
        const ratio = s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight);
        preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      },
    });
    draw(source.text);
    dirty = false;
    cm.focus();

    $(".ed-toolbar").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.cmd) return ed.COMMANDS[b.dataset.cmd](cm);
      if (b.dataset.mode) {
        mode = b.dataset.mode;
        main.dataset.mode = mode;
        for (const x of document.querySelectorAll(".ed-mode button")) x.setAttribute("aria-pressed", String(x === b));
        try { localStorage.setItem(MODE_STORE, mode); } catch { /* 覚えられない環境では毎回「左右」 */ }
        if (mode !== "preview") cm.focus();
        return;
      }
      if (b.id === "ed-help-btn") b.setAttribute("aria-pressed", String(main.classList.toggle("help-open")));
    });
    $(".ed-help").addEventListener("click", (e) => {
      const c = e.target.closest("code[data-insert]");
      if (!c) return;
      const r = cm.state.selection.main;
      cm.dispatch({ changes: { from: r.from, to: r.to, insert: c.dataset.insert }, selection: { anchor: r.from + c.dataset.insert.length } });
      cm.focus();
    });
    $("#edit-save").addEventListener("click", save);

    async function save() {
      const b = $("#edit-save");
      if (b.disabled) return;
      b.disabled = true;
      $("#edit-status").textContent = "保存中…";
      $("#edit-error").textContent = "";
      let r;
      try {
        r = await call("/save", { src: p.src, text: cm.state.doc.toString(), sha: source.sha });
      } catch (err) {
        $("#edit-status").textContent = "";
        $("#edit-error").textContent = `保存できませんでした：${err.message}`;
        b.disabled = false;
        return;
      }
      dirty = false;
      location.hash = `#/${encodeURIComponent(p.id)}`;
      waitPublish(r.commit, p.src);
    }
  }

  // 保存した版の組み立てが終わるのを待ち、終わったら読み直して表示し直す
  async function waitPublish(commit, src) {
    notice.hidden = false;
    notice.textContent = "保存しました。公開版に反映中…（1〜2分）";
    for (;;) {
      await new Promise((r) => setTimeout(r, 8000));
      const st = await call("/status", {});
      if (st.sha !== commit || st.status !== "completed") continue;
      if (st.conclusion !== "success") { notice.textContent = "組み立てに失敗しました。書き方を確かめて直してください。"; return; }
      break;
    }
    // GitHub Pages の配信が新しい版に替わるまで少し待つ
    await new Promise((r) => setTimeout(r, 20000));
    await reloadSite();
    const p = pageBySrc(src);
    notice.textContent = "反映しました。";
    setTimeout(() => { notice.hidden = true; }, 4000);
    if (p && location.hash === `#/${encodeURIComponent(p.id)}`) route();
  }

  return { afterPage, open };
}
