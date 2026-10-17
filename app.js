"use strict";
/* ============================================================
   洋書リーダー（Project Gutenberg）
   ・目録：このリポジトリの GitHub Actions が毎週作る catalog.json
   ・本文：Project Gutenberg（Cloudflare Worker の中継経由）
   ・翻訳・語句の意味・要約・解説・おすすめ：ユーザー自身のAIのAPIキー
   ============================================================ */

const CATALOG_TTL = 7 * 24 * 3600 * 1000;
function catalogURLs() {
  const urls = ["catalog.json"];
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  if (m && repo) urls.push(`https://raw.githubusercontent.com/${m[1]}/${repo}/main/catalog.json`);
  return urls;
}

/* ---------- IndexedDB ---------- */
const idb = {
  _db: null,
  open() {
    return this._db ||= new Promise((res, rej) => {
      const q = indexedDB.open("gutenberg-reader", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("kv");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  },
  async get(k) { try { const db = await this.open(); return await new Promise(res => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const db = await this.open(); return await new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); } catch (e) { return false; } },
  async clear() { try { const db = await this.open(); return await new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").clear(); t.oncomplete = () => res(true); }); } catch (e) { return false; } },
};

/* ---------- 設定・本棚など ---------- */
const KEY = "gutenberg-reader-v1";
const defaults = () => ({
  shelf: {}, phrases: [], tags: [], recs: null, ai: {}, downloaded: {},
  reader: { size: 18, lh: 1.75, theme: "paper", font: "serif", showTr: true },
  trStyle: "literary", proxy: "",
  aiProvider: "gemini", aiKeys: {}, aiModels: {},
});
let S = defaults();
try { const raw = localStorage.getItem(KEY); if (raw) S = Object.assign(defaults(), JSON.parse(raw)); S.reader = Object.assign(defaults().reader, S.reader); } catch (e) {}
let saveWarned = false;
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { if (!saveWarned) { saveWarned = true; toast("この端末に保存できませんでした"); } } }

/* ============================================================
   ユーティリティ
   ============================================================ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]+/g, " ").trim();
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2400); }
const STATUS = { want: "読みたい", reading: "読んでいる", finished: "読んだ" };
function ensureShelf(w, status = "want") {
  if (!S.shelf[w.id]) S.shelf[w.id] = { status, progress: 0, rating: 0, added: Date.now(), opened: 0, t: w.t, a: w.a };
  return S.shelf[w.id];
}
const LANGS = { en: "英語", fr: "フランス語", de: "ドイツ語", es: "スペイン語", it: "イタリア語", pt: "ポルトガル語", nl: "オランダ語", fi: "フィンランド語", la: "ラテン語", ja: "日本語", zh: "中国語", el: "ギリシャ語", ru: "ロシア語", sv: "スウェーデン語", da: "デンマーク語", pl: "ポーランド語", hu: "ハンガリー語" };
const langLabel = l => String(l || "").split(";").filter(Boolean).map(x => LANGS[x] || x).join("・");
const shortTitle = t => String(t).split(/[:;]|\$/)[0].trim();

/* ジャンル（好みタグ）→ 書棚・件名のキーワード */
const ALL_TAGS = ["短く読める", "ミステリ", "SF・幻想", "ホラー・ゴシック", "冒険", "恋愛", "ユーモア", "児童文学", "詩", "戯曲", "哲学・思想", "歴史"];
const TAG_RE = {
  "短く読める": /short stor/i, "ミステリ": /detective|mystery|crime/i, "SF・幻想": /science fiction|fantasy/i,
  "ホラー・ゴシック": /horror|gothic|ghost|supernatural/i, "冒険": /adventure/i, "恋愛": /romance|love stor/i,
  "ユーモア": /humor|humour/i, "児童文学": /children|juvenile|fairy tale/i, "詩": /poetry|poems/i,
  "戯曲": /drama|plays|tragedies|comedies/i, "哲学・思想": /philosophy|ethics/i, "歴史": /history|historical/i,
};
const QUALITY_RE = /best books ever|classics of literature|harvard classics|banned books|general fiction/i;

/* ============================================================
   目録
   ============================================================ */
let CAT = [], BY_ID = {}, BY_AUTHOR = {}, KEYS = [], TOP = [];
let catState = { status: "idle", msg: "" };
function applyCatalog(c) {
  CAT = c.works; TOP = c.top || []; BY_ID = {}; BY_AUTHOR = {};
  for (const w of CAT) { BY_ID[w.id] = w; (BY_AUTHOR[w.a] ||= []).push(w); }
  KEYS = CAT.map(w => [norm(w.t), norm(w.a)]);
}
async function fetchCatalog() {
  let last;
  for (const u of catalogURLs()) {
    try {
      const r = await fetch(u, { cache: "no-cache" });
      if (!r.ok) { last = new Error("HTTP " + r.status); continue; }
      const j = await r.json();
      if (!j.rows || j.rows.length < 100) { last = new Error("目録の中身が空です"); continue; }
      const works = j.rows.map(row => Object.fromEntries(j.cols.map((c, i) => [c, row[i] ?? ""])));
      return { at: Date.parse(j.at) || Date.now(), fetched: Date.now(), works, top: j.top || [] };
    } catch (e) { last = e; }
  }
  throw last || new Error("目録を取得できませんでした");
}
async function loadCatalog(force = false) {
  if (catState.status === "loading") return;
  catState = { status: "loading", msg: "目録を読み込み中…" }; refreshBanner();
  let cached = await idb.get("catalog");
  if (force || !cached || Date.now() - (cached.fetched || 0) > CATALOG_TTL) {
    try {
      catState.msg = cached ? "目録を更新中…" : "作品目録をダウンロード中…（初回のみ・数MB）"; refreshBanner();
      cached = await fetchCatalog();
      await idb.set("catalog", cached);
    } catch (e) {
      if (!cached) {
        catState = { status: "error", msg: `作品目録（catalog.json）がまだありません。GitHubのリポジトリで「Actions」→「目録を更新」を実行し、緑のチェックが付いてから再試行してください。（${e.message}）` };
        refreshBanner(); render(); return;
      }
      if (force) toast("目録を更新できなかったため、保存済みの目録を使います");
    }
  }
  applyCatalog(cached);
  catState = { status: "ready", msg: "", at: cached.at };
  refreshBanner(); render();
}
let searchLang = "en";
function search(q, limit = 120) {
  q = norm(q); if (!q) return [];
  const words = q.split(" ");
  const topSet = new Set(TOP);
  const hits = [];
  for (let i = 0; i < CAT.length; i++) {
    const w = CAT[i];
    if (searchLang !== "all" && !(w.lang || "").split(";").includes(searchLang)) continue;
    const [t, a] = KEYS[i];
    const hay = t + " " + a;
    if (!words.every(x => hay.includes(x))) continue;
    let s = 1;
    if (t === q) s += 100; else if (t.startsWith(q)) s += 60; else if (t.includes(q)) s += 40;
    if (a === q || a.endsWith(" " + q)) s += 50; else if (a.includes(q)) s += 20;
    if (topSet.has(w.id)) s += 30;
    if (QUALITY_RE.test(w.sh)) s += 15;
    hits.push([s, w]);
  }
  return hits.sort((x, y) => y[0] - x[0] || x[1].t.length - y[1].t.length).slice(0, limit).map(h => h[1]);
}
function workOf(id) { return BY_ID[id] || (S.shelf[id] && { id, t: S.shelf[id].t, a: S.shelf[id].a, ad: "", lang: "", sh: "", sub: "" }) || null; }

/* ============================================================
   本文：取得と整形
   ============================================================ */
function isHeading(lines, j) {
  if (lines.length > 3 || j.length > 80) return false;
  if (/^(chapter|book|part|volume|act|scene|letter|stave|canto|section|prologue|epilogue|preface|introduction|contents|appendix)\b/i.test(j)) return true;
  if (/^[IVXLC]+\.?$/.test(j)) return true;
  if (j.length < 60 && j === j.toUpperCase() && /[A-Z]{2}/.test(j) && !/["“”‘’']/.test(j) && !/[,;:\-—]$/.test(j)) return true;
  return false;
}
/* Project Gutenberg のテキスト → 段落の配列（見出し h / 段落 p / 韻文 v） */
function parseGutenberg(raw) {
  let t = String(raw).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const s = t.search(/^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*$/mi);
  if (s >= 0) t = t.slice(t.indexOf("\n", s) + 1);
  const ends = [t.search(/^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG/mi), t.search(/^End of (the )?Project Gutenberg/mi)].filter(x => x >= 0);
  if (ends.length) t = t.slice(0, Math.min(...ends));
  const blocks = [];
  for (const p of t.split(/\n[ \t]*\n+/)) {
    if (!p.trim()) continue;
    const lines = p.split("\n").filter(l => l.trim());
    const trimmed = lines.map(l => l.trim());
    if (blocks.length < 4 && /^(produced by|e-?text prepared|transcriber|this e-?book was produced|updated editions)/i.test(trimmed[0])) continue;
    const joined = trimmed.join(" ").replace(/\s+/g, " ").trim();
    if (isHeading(trimmed, joined)) { blocks.push({ k: "h", s: joined }); continue; }
    const avg = trimmed.reduce((a, l) => a + l.length, 0) / trimmed.length;
    const indented = lines.filter(l => /^\s{2,}/.test(l)).length >= lines.length / 2;
    const maxLen = Math.max(...trimmed.map(l => l.length));
    if ((lines.length >= 3 && avg < 42 && maxLen < 56) || (lines.length >= 2 && indented && maxLen < 64)) blocks.push({ k: "v", s: trimmed.join("\n") });
    else blocks.push({ k: "p", s: joined });
  }
  return blocks;
}
const blocksToPlain = blocks => blocks.map(b => b.s).join("\n\n");
async function loadText(w) {
  const cached = await idb.get("text:" + w.id);
  if (cached) return cached;
  const tries = [];
  if (S.proxy) tries.push(S.proxy.replace(/\/+$/, "") + "/?id=" + encodeURIComponent(w.id));
  tries.push(`https://www.gutenberg.org/cache/epub/${w.id}/pg${w.id}.txt`);
  let raw = null, lastStatus = 0;
  for (const u of tries) {
    try { const r = await fetch(u); lastStatus = r.status; if (r.ok) { raw = await r.text(); break; } } catch (e) {}
  }
  if (!raw) {
    if (!S.proxy) throw { code: "noproxy", message: "本文を読むには、最初に一度だけ「本文の取得先」の設定が必要です。" };
    throw { code: "fetch", message: lastStatus === 404 ? "この作品のテキスト版が見つかりませんでした（画像や音声だけの作品かもしれません）。" : "本文を取得できませんでした。通信状況と「本文の取得先」のURLを確かめてください。" };
  }
  const blocks = parseGutenberg(raw);
  if (blocks.length < 3) throw { code: "parse", message: "本文を読み取れませんでした。" };
  const t = { blocks, at: Date.now() };
  await idb.set("text:" + w.id, t);
  S.downloaded[w.id] = Date.now(); save();
  return t;
}
const inlineHTML = s => esc(s).replace(/_([^_\n]{1,200})_/g, "<i>$1</i>").replace(/\n/g, "<br>");

/* ============================================================
   AI
   ============================================================ */
const PROVIDERS = {
  anthropic: { label: "Anthropic（Claude）", model: "claude-sonnet-5-5", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { label: "OpenAI（GPT）", model: "gpt-5-mini", keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { label: "Google（Gemini）", model: "gemini-3.6-flash", keyUrl: "https://aistudio.google.com/apikey" },
};
const aiReady = () => !!(S.aiKeys[S.aiProvider] || "").trim();
const aiModel = () => (S.aiModels[S.aiProvider] || "").trim() || PROVIDERS[S.aiProvider].model;
const AI_BASE = "あなたは英米文学・西洋文学に精通した、親切な読書案内人であり、文芸翻訳家です。Project Gutenberg で古典を原書で読む日本の読者を助けます。日本語で、平易かつ正確に答えてください。確証のない事実（成立年、初出、逸話、研究者名や論文名など）は断定せず「〜とされる」「要確認」と明記してください。";

async function callAI(prompt, { maxTokens = 2000, signal } = {}) {
  const p = S.aiProvider, key = (S.aiKeys[p] || "").trim(), model = aiModel();
  if (!key) throw { code: "nokey" };
  let url, headers = { "content-type": "application/json" }, body;
  if (p === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
    body = { model, max_tokens: maxTokens, system: AI_BASE, messages: [{ role: "user", content: prompt }] };
  } else if (p === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    headers.authorization = "Bearer " + key;
    body = { model, messages: [{ role: "system", content: AI_BASE }, { role: "user", content: prompt }] };
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = key;
    // Gemini 3 系は内部で考える分も出力上限に数えるため、上限は指定しない
    body = { systemInstruction: { parts: [{ text: AI_BASE }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] };
  }
  let r;
  try { r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal }); }
  catch (e) { if (e.name === "AbortError") throw { code: "cancelled" }; throw { code: "network" }; }
  const txt = await r.text();
  if (!r.ok) throw { code: "http", status: r.status, body: txt };
  const j = JSON.parse(txt);
  let out = "";
  if (p === "anthropic") out = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  else if (p === "openai") out = j.choices?.[0]?.message?.content || "";
  else out = (j.candidates?.[0]?.content?.parts || []).filter(x => !x.thought).map(x => x.text || "").join("");
  if (!out.trim()) throw { code: "empty", detail: p === "gemini" ? (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "") : "" };
  return out.trim();
}
function apiMessage(body) { try { const j = JSON.parse(body); return (j.error && (j.error.message || j.error.type)) || j.message || ""; } catch (_) { return ""; } }
function aiError(e) {
  const m = aiErrorBase(e), d = e && (e.body ? apiMessage(e.body) : e.detail);
  return m && d ? `${m}（${String(d).slice(0, 160)}）` : m;
}
function aiErrorBase(e) {
  if (!e) return "AIの呼び出しに失敗しました。";
  switch (e.code) {
    case "nokey": return "AIを使うには「設定」でAPIキーを登録してください。";
    case "cancelled": return "";
    case "network": return "AIのサーバーに接続できませんでした。通信状況を確かめてください。";
    case "empty": return "AIから空の応答が返りました。もう一度お試しください。";
    case "http":
      if (e.status === 401 || e.status === 403) return "APIキーが無効か、権限がありません。設定を確かめてください。";
      if (e.status === 404) return "このモデルは使えません。設定のモデル名を空欄にするか、別のモデル名を入れてください。";
      if (e.status === 400) return "リクエストが受け付けられませんでした。APIキーとモデル名を確かめてください。";
      if (e.status === 429) return "利用上限かレート制限に達しました。少し待ってからお試しください。";
      return `AIの呼び出しに失敗しました（${e.status}）。`;
  }
  return "AIの呼び出しに失敗しました。";
}
async function runAI(box, cacheKey, prompt, opts = {}) {
  if (!aiReady()) { box.innerHTML = needKeyHTML(); return null; }
  box.innerHTML = '<div class="thinking">考えています…（10〜40秒ほど）</div>';
  try {
    const text = await callAI(prompt, opts);
    box.innerHTML = md(text);
    if (cacheKey) { S.ai[cacheKey] = text; save(); }
    return text;
  } catch (e) {
    const m = aiError(e);
    box.innerHTML = m ? `<p class="hint" style="color:var(--danger)">${esc(m)}</p>` : "";
    return null;
  }
}
const needKeyHTML = () => `<div class="hint">AIを使うにはAPIキーが必要です。<button class="btn small" data-tab="settings" style="margin-left:6px">設定を開く</button></div>`;
function jsonArray(text) {
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (_) { return null; }
}
function md(text) {
  const lines = esc(text).split("\n"); let out = "", inList = false;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<i>$2</i>");
  for (const raw of lines) {
    const l = raw.trim();
    if (/^(?:[-・]|\*\s)/.test(l) && l.length > 1) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(l.replace(/^(?:[-・]\s?|\*\s)/, ""))}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    if (!l) continue;
    out += /^#{1,4}\s/.test(l) ? `<h4>${inline(l.replace(/^#+\s/, ""))}</h4>` : `<p>${inline(l)}</p>`;
  }
  return out + (inList ? "</ul>" : "");
}

/* ============================================================
   表紙・行
   ============================================================ */
const COVER_COLORS = [["#23403A", "#EAF1EE"], ["#6B2A2A", "#F5EAE7"], ["#2D3E5C", "#E9EEF6"], ["#5C4A1F", "#F7F1E2"], ["#3F2F55", "#F0ECF6"], ["#2F4F2A", "#EDF3E9"], ["#30343A", "#EEEEEE"], ["#6A3D20", "#F6ECE3"]];
function cover(w, width = 92) {
  const [bg, fg] = COVER_COLORS[parseInt(hash(w.t), 36) % COVER_COLORS.length];
  const ts = Math.max(10, Math.round(width * 0.14)), as = Math.max(8, Math.round(width * 0.095));
  return `<div class="cover" style="width:${width}px;height:${Math.round(width * 1.42)}px;--c-bg:${bg};--c-fg:${fg}" aria-hidden="true">
    <span class="ct" style="font-size:${ts}px">${esc(shortTitle(w.t))}</span><span class="ca" style="font-size:${as}px">${esc(w.a)}</span></div>`;
}
const tagsLine = w => `${w.lang ? `<span class="tag">${esc(langLabel(w.lang))}</span>` : ""}${(w.sh || "").split("|").filter(Boolean).slice(0, 1).map(s => `<span class="tag">${esc(s)}</span>`).join("")}${S.downloaded[w.id] ? '<span class="tag read">保存済み</span>' : ""}`;
const bookCard = (w, extra = "", act = "open") => `<button class="card-book" data-${act}="${w.id}">${cover(w)}<span class="t">${esc(shortTitle(w.t))}</span><span class="a">${esc(w.a)}</span>${extra}</button>`;
const listItem = (w, sub = "") => `<button class="item" data-open="${w.id}">${cover(w, 52)}<span class="body"><span class="title">${esc(w.t)}</span><span class="meta">${esc(w.a)}${w.ad ? ` <small>(${esc(w.ad)})</small>` : ""}</span><span>${tagsLine(w)}</span>${sub}</span></button>`;

/* ============================================================
   画面
   ============================================================ */
let tab = "home";
function setTab(t) { tab = t; $("#detail").hidden = true; render(); $("#view").scrollTop = 0; }
function refreshBanner() {
  const b = $("#banner"); if (!b) return;
  if (catState.status === "loading") { b.hidden = false; b.innerHTML = `<div class="thinking">${esc(catState.msg)}</div>`; }
  else if (catState.status === "error") { b.hidden = false; b.innerHTML = `<div style="flex:1">${esc(catState.msg)}</div><button class="btn small" data-act="reload-catalog">再試行</button>`; }
  else b.hidden = true;
}
function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-current", String(b.dataset.tab === tab)));
  $("#vtitle").textContent = { home: "洋書リーダー", search: "さがす", shelf: "本棚", phrases: "ことば", settings: "設定" }[tab];
  $("#view").innerHTML = ({ home: viewHome, search: viewSearch, shelf: viewShelf, phrases: viewPhrases, settings: viewSettings })[tab]();
  if (tab === "search") $("#q").value = searchQ;
  refreshBanner();
}

/* ---- ホーム ---- */
function viewHome() {
  const reading = Object.entries(S.shelf).filter(([, s]) => s.status === "reading").sort((a, b) => (b[1].opened || 0) - (a[1].opened || 0));
  let h = "";
  if (!S.proxy) h += `<div class="panel notice"><b>はじめに：</b>本文を読むには「本文の取得先」の登録が一度だけ必要です。<button class="btn small" data-tab="settings" style="margin-left:6px">設定を開く</button></div>`;
  if (reading.length) {
    h += `<h2 class="sec">続きから読む</h2><div class="hscroll">` + reading.map(([id, s]) => {
      const w = workOf(id); if (!w) return "";
      return `<button class="card-book" data-read="${id}">${cover(w)}<span class="t">${esc(shortTitle(w.t))}</span><div class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></div><span class="a">${Math.round(s.progress * 100)}%</span></button>`;
    }).join("") + `</div>`;
  }
  h += `<h2 class="sec">あなたへのおすすめ ${S.recs && S.recs.byAI ? '<span class="badge-ai">✦ AI</span>' : ""}</h2>`;
  h += `<div class="chips" style="margin-bottom:10px">` + ALL_TAGS.map(t => `<button class="chip" data-tag="${t}" aria-pressed="${S.tags.includes(t)}">${t}</button>`).join("") + `</div>`;
  h += `<div class="row" style="margin-bottom:4px"><span class="hint" style="flex:1">好み・本棚・評価・保存したことばから選びます。</span><button class="btn small ai" data-act="recommend" id="rec-btn" ${catState.status !== "ready" ? "disabled" : ""}>✦ AIに選んでもらう</button></div>`;
  h += `<div id="rec-status"></div><div class="list" id="rec-list">${catState.status === "ready" ? recList() : ""}</div>`;
  if (catState.status === "ready" && TOP.length) {
    h += `<h2 class="sec">いまよく読まれている本</h2><div class="hscroll">${TOP.slice(0, 30).map(id => BY_ID[id]).filter(Boolean).map(w => bookCard(w)).join("")}</div>`;
  }
  if (catState.status === "ready") h += `<p class="hint">収録 ${CAT.length.toLocaleString()} 作品（Project Gutenberg）</p>`;
  return h;
}
function candidates(limit = 80) {
  const owned = new Set(Object.keys(S.shelf)), score = {}, topSet = new Set(TOP);
  const langs = new Set(["en", ...Object.keys(S.shelf).map(id => (BY_ID[id] || {}).lang).filter(Boolean).flatMap(l => l.split(";"))]);
  const okLang = w => (w.lang || "").split(";").some(l => langs.has(l));
  const add = (w, s) => { if (!w || owned.has(w.id) || !okLang(w)) return; score[w.id] = (score[w.id] || 0) + s + (topSet.has(w.id) ? 1.5 : 0) + (QUALITY_RE.test(w.sh) ? 1 : 0); };
  const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
  const words = {};
  for (const [id, s] of Object.entries(S.shelf)) {
    const w = BY_ID[id]; if (!w) continue;
    const v = s.status === "finished" ? 1 + Math.max(0, (s.rating || 0) - 3) : s.status === "reading" ? 1.2 : 0.6;
    shuffle(BY_AUTHOR[w.a] || []).slice(0, 10).forEach(x => add(x, 2 * v));
    for (const k of (w.sh + "|" + w.sub).split("|").filter(x => x && !QUALITY_RE.test(x))) words[k] = (words[k] || 0) + v;
  }
  const curated = CAT.filter(w => QUALITY_RE.test(w.sh) || topSet.has(w.id));
  for (const [k, v] of Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    shuffle(curated.filter(w => (w.sh + "|" + w.sub).includes(k))).slice(0, 12).forEach(w => add(w, v));
  }
  for (const t of S.tags) shuffle(curated.filter(w => TAG_RE[t].test(w.sh + " " + w.sub))).slice(0, 15).forEach(w => add(w, 1.5));
  shuffle(TOP.map(id => BY_ID[id]).filter(Boolean)).slice(0, 25).forEach(w => add(w, 0.6));
  return Object.entries(score).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => BY_ID[id]);
}
let fbCache = null;
function fallbackRecs() {
  const key = S.tags.join() + Object.keys(S.shelf).length;
  if (fbCache && fbCache.key === key) return fbCache.items;
  const per = {}, out = [];
  for (const w of candidates()) {
    if (out.length >= 6) break;
    if ((per[w.a] = (per[w.a] || 0) + 1) > 2) continue;
    out.push({ id: w.id, reason: `${w.a}の作品。${(w.sh || "").split("|").filter(Boolean)[0] || ""}` });
  }
  fbCache = { key, items: out };
  return out;
}
function recList() {
  const recs = (S.recs && S.recs.items) || fallbackRecs();
  return recs.filter(r => BY_ID[r.id]).map(r => listItem(BY_ID[r.id], `${r.level ? `<span class="tag lv">英語：${esc(r.level)}</span>` : ""}<span class="reason">${esc(r.reason)}</span>`)).join("");
}
async function recommend() {
  const st = $("#rec-status"), btn = $("#rec-btn");
  if (!aiReady()) { st.innerHTML = needKeyHTML(); return; }
  btn.disabled = true; st.innerHTML = '<div class="thinking" style="margin:8px 0">本棚とことばを読んで選書しています…</div>';
  const prof = [];
  if (S.tags.length) prof.push("好み: " + S.tags.join("、"));
  const fmt = k => Object.entries(S.shelf).filter(([, s]) => s.status === k).map(([, s]) => `${s.t}（${s.a}）${s.rating ? `★${s.rating}` : ""}`).join("、");
  if (fmt("finished")) prof.push("読んだ: " + fmt("finished"));
  if (fmt("reading")) prof.push("読んでいる: " + fmt("reading"));
  if (fmt("want")) prof.push("読みたい: " + fmt("want"));
  if (S.phrases.length) prof.push("保存したことば:\n" + S.phrases.slice(0, 10).map(p => `・"${p.text.slice(0, 100)}"（${p.title}）`).join("\n"));
  const cands = candidates();
  const prompt = `次の読者に、候補の中から次に原書で読む本を6冊選んでください。読者は日本語話者で、英語などの原文を翻訳機能の助けを借りながら読みます。

# 読者の読書プロフィール
${prof.join("\n") || "（まだ履歴なし。原書入門に向く名作を幅広く）"}

# 候補（ID|題名|作者|言語|書棚）
${cands.map(w => `${w.id}|${w.t}|${w.a}|${w.lang}|${(w.sh || "").replace(/\|/g, ", ")}`).join("\n")}

# 条件
・必ず候補にあるIDだけを使う
・好みに近いものを中心に、新しい出会いになる意外な一冊を1冊まぜる
・同じ作家は最大2冊
・reason は日本語で読者に語りかける40〜70字。邦題があれば『』で添える
・level は原文の読みやすさ（「やさしい」「ふつう」「難しい」のどれか）

# 出力
JSON配列のみ: [{"id":"1342","reason":"…","level":"ふつう"}]`;
  try {
    const arr = jsonArray(await callAI(prompt, { maxTokens: 1500 }));
    const valid = new Set(cands.map(w => w.id));
    const items = (arr || []).map(r => ({ id: String(r && r.id || ""), reason: String(r && r.reason || ""), level: String(r && r.level || "") })).filter(r => valid.has(r.id) && r.reason);
    if (!items.length) throw { code: "empty" };
    S.recs = { byAI: true, items, at: Date.now() }; save();
    if (tab === "home") render();
  } catch (e) {
    st.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(aiError(e))}</p>`;
    btn.disabled = false;
  }
}

/* ---- さがす ---- */
let searchQ = "";
function viewSearch() {
  const opts = [["en", "英語"], ["fr", "フランス語"], ["de", "ドイツ語"], ["all", "すべて"]];
  return `<input type="search" id="q" placeholder="題名・作家名（英語で）" autocomplete="off" autocapitalize="off" aria-label="検索" enterkeyhint="search">
  <div class="seg" style="margin:10px 0 4px">${opts.map(([k, l]) => `<button data-lang="${k}" aria-pressed="${searchLang === k}">${l}</button>`).join("")}</div>
  <div id="results">${searchResults()}</div>`;
}
function searchResults() {
  if (catState.status !== "ready") return `<div class="empty"><b>目録を準備しています</b>初回は作品目録をダウンロードします。</div>`;
  if (!norm(searchQ)) {
    const authors = [];
    for (const id of TOP) { const w = BY_ID[id]; if (w && !authors.includes(w.a) && w.a !== "Anonymous") authors.push(w.a); if (authors.length >= 24) break; }
    return `<h2 class="sec">よく読まれている作家</h2><div class="chips">${authors.map(a => `<button class="chip" data-author="${esc(a)}">${esc(a)}</button>`).join("")}</div>
      <h2 class="sec">ジャンル</h2><div class="chips">${ALL_TAGS.map(t => `<button class="chip" data-genre="${t}">${t}</button>`).join("")}</div>
      <p class="hint" style="margin-top:18px">Project Gutenberg の ${CAT.length.toLocaleString()} 作品から、題名・作家名（英語表記）で探せます。例：pride, sherlock, dickens</p>`;
  }
  const hits = search(searchQ);
  return hits.length ? `<div class="list">${hits.map(w => listItem(w)).join("")}</div>${hits.length >= 120 ? '<p class="hint">上位120件を表示しています。</p>' : ""}`
    : `<div class="empty"><b>見つかりませんでした</b>英語表記で探してください（例：Dostoyevsky, Crime and Punishment）。言語の絞り込みも確かめてください。</div>`;
}
function genreResults(tag) {
  const topSet = new Set(TOP);
  const list = CAT.filter(w => (searchLang === "all" || (w.lang || "").split(";").includes(searchLang)) && TAG_RE[tag].test(w.sh + " " + w.sub))
    .map(w => [(topSet.has(w.id) ? 2 : 0) + (QUALITY_RE.test(w.sh) ? 1 : 0), w]).sort((a, b) => b[0] - a[0]).slice(0, 80).map(x => x[1]);
  return `<h2 class="sec">${esc(tag)}</h2><div class="list">${list.map(w => listItem(w)).join("")}</div>`;
}

/* ---- 本棚 ---- */
let shelfFilter = "all";
function viewShelf() {
  const all = Object.entries(S.shelf);
  const count = st => all.filter(([, s]) => st === "all" || s.status === st).length;
  let h = `<div class="seg">${["all", "want", "reading", "finished"].map(k => `<button data-shelf="${k}" aria-pressed="${shelfFilter === k}">${k === "all" ? "すべて" : STATUS[k]} ${count(k)}</button>`).join("")}</div>`;
  const shown = all.filter(([, s]) => shelfFilter === "all" || s.status === shelfFilter).sort((a, b) => (b[1].opened || b[1].added) - (a[1].opened || a[1].added));
  if (!shown.length) return h + `<div class="empty"><b>本棚は空です</b>作品ページの「本棚に追加」から加えられます。</div>`;
  return h + `<div class="grid-shelf">` + shown.map(([id, s]) => {
    const w = workOf(id);
    const extra = (s.status === "reading" ? `<div class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : "") +
      (s.rating ? `<span class="a" style="color:#C88A2E">${"★".repeat(s.rating)}</span>` : "") + `<span class="a">${STATUS[s.status]}</span>`;
    return bookCard(w, extra);
  }).join("") + `</div>`;
}

/* ---- ことば ---- */
let phraseQ = "";
function viewPhrases() {
  if (!S.phrases.length) return `<div class="empty"><b>保存したことばはまだありません</b>読書中に文を選んで「保存」を押すと、訳と一緒にここに集まります。</div>`;
  const q = phraseQ.trim().toLowerCase();
  const list = S.phrases.filter(p => !q || [p.text, p.tr, p.title, p.author, p.note].some(x => (x || "").toLowerCase().includes(q)));
  return `<input type="search" id="pq" placeholder="ことば・訳・作品・メモを検索" value="${esc(phraseQ)}" aria-label="ことばを検索" style="margin-bottom:12px">` +
    list.map(p => `<div class="panel">
      <div class="quote-en">${esc(p.text)}</div>
      ${p.tr ? `<div class="quote-ja">${esc(p.tr)}</div>` : ""}
      <div class="row hint" style="margin-top:6px"><span>${esc(p.author)}『${esc(shortTitle(p.title))}』</span><span class="spacer"></span><span>${new Date(p.at).toLocaleDateString("ja-JP")}</span></div>
      ${p.note ? `<div class="ai-out" style="margin-top:8px;font-size:13px">${md(p.note)}</div>` : ""}
      <div class="row" style="margin-top:10px;gap:6px;flex-wrap:wrap">
        <button class="btn small" data-share="${p.id}">共有</button>
        <button class="btn small" data-note="${p.id}">メモ</button>
        <button class="btn small" data-jump="${p.id}">本文へ</button>
        <span class="spacer"></span>
        <button class="btn small" data-delphrase="${p.id}" style="color:var(--danger)">削除</button>
      </div></div>`).join("");
}

/* ---- 設定 ---- */
function viewSettings() {
  const p = S.aiProvider;
  return `<h2 class="sec">本文の取得先</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:8px">
    <p style="margin:0">Project Gutenberg は、ほかのサイトから本文を直接読み込むことを許可していないため、中継用のURLを一度だけ登録します（Cloudflareの無料アカウントで作れます。手順はREADMEにあります）。</p>
    <label class="hint" for="proxy">中継URL（例：https://gutenberg-proxy.あなたの名前.workers.dev）</label>
    <input type="url" id="proxy" value="${esc(S.proxy)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…workers.dev">
    <div class="row"><button class="btn primary" data-act="proxy-test">保存して確認</button></div>
    <div id="proxy-out" class="hint"></div>
  </div>
  <h2 class="sec">AI</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:10px">
    <div class="seg">${Object.entries(PROVIDERS).map(([k, v]) => `<button data-provider="${k}" aria-pressed="${p === k}">${v.label.replace(/（.*）/, "")}</button>`).join("")}</div>
    <label class="hint" for="ai-key">${esc(PROVIDERS[p].label)} のAPIキー</label>
    <input type="password" id="ai-key" value="${esc(S.aiKeys[p] || "")}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="APIキーを貼り付け">
    <label class="hint" for="ai-model">モデル名（空欄なら ${esc(PROVIDERS[p].model)}）</label>
    <input type="text" id="ai-model" value="${esc(S.aiModels[p] || "")}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="row"><button class="btn primary" data-act="ai-test">保存して接続テスト</button><a href="${PROVIDERS[p].keyUrl}" target="_blank" rel="noopener" class="hint">キーを取得する</a></div>
    <div id="ai-test-out" class="hint"></div>
    <p class="hint" style="margin:0">キーはこの端末の中にだけ保存され、選んだサービスへ直接送られます。</p>
  </div>
  <h2 class="sec">翻訳</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:8px">
    <div class="seg"><button data-trstyle="literary" aria-pressed="${S.trStyle === "literary"}">自然な文芸訳</button><button data-trstyle="literal" aria-pressed="${S.trStyle === "literal"}">原文に忠実（学習向け）</button></div>
    <p class="hint" style="margin:0">訳した段落はこの端末に保存され、次からはAIを呼ばずに表示します。</p>
  </div>
  <h2 class="sec">読書画面の既定</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:10px">${styleControls(S.reader)}</div>
  <h2 class="sec">作品目録と保存データ</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:8px">
    <div class="hint">目録 ${CAT.length.toLocaleString()}作品${catState.at ? `（${new Date(catState.at).toLocaleDateString("ja-JP")} 時点・毎週自動更新）` : ""}・保存済みの本文 ${Object.keys(S.downloaded).length}冊・本棚 ${Object.keys(S.shelf).length}冊・ことば ${S.phrases.length}件</div>
    <div class="row" style="flex-wrap:wrap;gap:8px"><button class="btn small" data-act="reload-catalog">目録を読み込み直す</button><button class="btn small" data-act="paste">テキストを貼り付けて読む</button></div>
    <div id="reset-area"><button class="btn small" data-act="reset-ask" style="color:var(--danger)">すべて消去する</button></div>
  </div>
  <h2 class="sec">ホーム画面に追加</h2>
  <div class="panel"><p style="margin:0">iPhoneのSafariで、共有ボタン →「ホーム画面に追加」を選ぶと、アプリとして起動できます。一度開いた本文と訳は端末に保存されるので、通信がなくても読めます。</p></div>
  <p class="hint" style="margin-top:18px">作品は<a href="https://www.gutenberg.org/" target="_blank" rel="noopener">Project Gutenberg</a>の公開データです。米国でパブリックドメインの作品です。お住まいの国の著作権法もご確認ください。</p>`;
}
function styleControls(r) {
  const seg = (name, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button data-style="${name}" data-val="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join("")}</div>`;
  return `${seg("showTr", [[true, "訳を表示"], [false, "原文のみ"]], r.showTr)}
    ${seg("font", [["serif", "セリフ体"], ["sans", "サンセリフ体"]], r.font)}
    ${seg("theme", [["paper", "生成り"], ["white", "白"], ["dark", "夜"]], r.theme)}
    ${seg("size", [[16, "小"], [18, "中"], [21, "大"], [24, "特大"]], r.size)}
    ${seg("lh", [[1.55, "行間 狭"], [1.75, "標準"], [2, "広"]], r.lh)}`;
}

/* ============================================================
   作品ページ
   ============================================================ */
let detailId = null, detailPane = "about", paperCache = {};
function openDetail(id) { detailId = id; detailPane = "about"; renderDetail(); $("#detail").hidden = false; const b = $("#detail .layer-body"); if (b) b.scrollTop = 0; }
function renderDetail() {
  const w = workOf(detailId); if (!w) return;
  const s = S.shelf[w.id];
  const others = (BY_AUTHOR[w.a] || []).filter(x => x.id !== w.id && x.a !== "Anonymous");
  let h = `<div class="layer-head"><button class="icon-btn" data-act="close-detail" aria-label="戻る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg></button><span class="spacer"></span></div>
  <div class="layer-body">
  <div class="detail-head">${cover(w, 104)}<div class="info">
    <h3>${esc(w.t)}</h3><div>${esc(w.a)}${w.ad ? ` <span class="hint">(${esc(w.ad)})</span>` : ""}</div><div>${tagsLine(w)}</div>
    <button class="btn primary" data-read="${w.id}">${s && s.progress > 0.01 && s.status !== "finished" ? "続きを読む" : "読む"}</button>
    <select id="status-sel" aria-label="本棚の状態">
      <option value="">${s ? "本棚から外す" : "＋ 本棚に追加…"}</option>
      ${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${s && s.status === k ? "selected" : ""}>${l}</option>`).join("")}
    </select>
  </div></div>
  <div class="seg" style="margin:18px 0 14px">${[["about", "作品について"], ["commentary", "解説"], ["critique", "論文・批評"]].map(([k, l]) => `<button data-pane="${k}" aria-pressed="${detailPane === k}">${l}</button>`).join("")}</div>`;

  if (detailPane === "about") {
    if (s) h += `<div class="row" style="margin-bottom:12px"><span class="hint">あなたの評価</span><span class="stars">${[1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" aria-label="${n}つ星">${n <= (s.rating || 0) ? "★" : "☆"}</button>`).join("")}</span><span class="spacer"></span>${s.progress > 0 ? `<span class="hint">${Math.round(s.progress * 100)}% 読了</span>` : ""}</div>`;
    h += `<dl class="kv">${w.lang ? `<dt>言語</dt><dd>${esc(langLabel(w.lang))}</dd>` : ""}${w.sh ? `<dt>書棚</dt><dd>${esc(w.sh.split("|").join("、"))}</dd>` : ""}${w.sub ? `<dt>件名</dt><dd>${esc(w.sub.split("|").join("、"))}</dd>` : ""}${w.iss ? `<dt>収録日</dt><dd>${esc(w.iss)}</dd>` : ""}<dt>作品番号</dt><dd>#${esc(w.id)}</dd></dl>`;
    if (/^\d+$/.test(w.id)) h += `<p style="margin:12px 0 0"><a href="https://www.gutenberg.org/ebooks/${esc(w.id)}" target="_blank" rel="noopener">Project Gutenberg の作品ページを開く</a></p>`;
    const phr = S.phrases.filter(p => p.workId === w.id);
    if (phr.length) h += `<h2 class="sec">この作品で保存したことば</h2>` + phr.map(p => `<div class="panel"><div class="quote-en">${esc(p.text)}</div>${p.tr ? `<div class="quote-ja">${esc(p.tr)}</div>` : ""}</div>`).join("");
    if (others.length) h += `<h2 class="sec">${esc(w.a)}のほかの作品</h2><div class="hscroll">${others.slice(0, 30).map(x => bookCard(x)).join("")}</div>`;
  } else if (detailPane === "commentary") {
    const key = "commentary|" + w.id;
    h += `<div class="panel" id="wiki-box"><div class="thinking">Wikipediaを確認中…</div></div>
      <div class="row" style="margin:18px 0 10px"><span class="badge-ai">✦ AI</span><span class="hint">これから読む人向けの作品解説（日本語）</span></div>
      <div class="panel"><div class="ai-out" id="ai-box">${S.ai[key] ? md(S.ai[key]) : `<p class="hint">邦題、背景、主題、文学史上の位置づけ、原文で読むときのヒントを、ネタバレなしでまとめます。</p>`}</div></div>
      <div class="row" style="margin-top:10px"><button class="btn ai" data-act="gen-commentary">${S.ai[key] ? "作り直す" : "✦ 解説を書いてもらう"}</button></div>
      <p class="hint">AIの解説は誤りを含むことがあります。事実関係は研究書・論文で確かめてください。</p>`;
    setTimeout(() => loadWiki(w), 0);
  } else {
    const key = "critique|" + w.id, q = encodeURIComponent(`${shortTitle(w.t)} ${w.a}`);
    h += `<div class="row" style="margin-bottom:10px"><span class="badge-ai">✦ AI</span><span class="hint">見つかった論文の題名・要旨から、研究の論点を日本語で整理</span></div>
      <div class="panel"><div class="ai-out" id="ai-box">${S.ai[key] ? md(S.ai[key]) : `<p class="hint">論文の一覧を読み込んだあとに使えます。</p>`}</div></div>
      <div class="row" style="margin-top:10px"><button class="btn ai" data-act="gen-critique">${S.ai[key] ? "作り直す" : "✦ 論点を整理してもらう"}</button></div>
      <h2 class="sec">論文</h2><div id="paper-box"><div class="thinking">OpenAlex・J-STAGEを検索中…</div></div>
      <div class="panel" style="display:flex;flex-direction:column;gap:6px;margin-top:12px">
        <a href="https://scholar.google.com/scholar?q=${q}" target="_blank" rel="noopener">Google Scholarで検索</a>
        <a href="https://www.jstor.org/action/doBasicSearch?Query=${q}" target="_blank" rel="noopener">JSTORで検索</a>
        <a href="https://cir.nii.ac.jp/all?q=${q}" target="_blank" rel="noopener">CiNii Researchで検索（日本語の論文）</a>
      </div>`;
    setTimeout(() => loadPapers(w), 0);
  }
  h += `</div>`;
  $("#detail").innerHTML = h;
}
async function loadWiki(w) {
  if (!$("#wiki-box")) return;
  if (w._wiki === undefined) {
    w._wiki = null;
    const surname = w.a.split(" ").pop();
    for (const cand of [`${shortTitle(w.t)} (novel)`, shortTitle(w.t)]) {
      try {
        const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cand.replace(/ /g, "_"))}`);
        if (!r.ok) continue;
        const j = await r.json();
        if (j.type === "disambiguation" || !j.extract || (surname && w.a !== "Anonymous" && !j.extract.includes(surname))) continue;
        w._wiki = { extract: j.extract, url: j.content_urls?.mobile?.page || "" }; break;
      } catch (e) {}
    }
  }
  if (!$("#wiki-box")) return;
  $("#wiki-box").innerHTML = w._wiki
    ? `<div class="hint" style="font-weight:700;margin-bottom:6px">Wikipedia（英語版）より</div><p style="margin:0" lang="en">${esc(w._wiki.extract)}</p>${w._wiki.url ? `<a class="hint" href="${esc(w._wiki.url)}" target="_blank" rel="noopener">記事を開く</a>` : ""}`
    : `<p class="hint" style="margin:0">Wikipediaに該当する記事は見つかりませんでした。</p>`;
}
function genCommentary() {
  const w = workOf(detailId);
  runAI($("#ai-box"), "commentary|" + w.id, `${w.t}（${w.a}${w.ad ? "、" + w.ad : ""}）について、これから原書で読む日本の読者向けに作品解説を書いてください。
目録情報：言語 ${langLabel(w.lang)}／書棚 ${(w.sh || "").replace(/\|/g, "、")}／件名 ${(w.sub || "").replace(/\|/g, "、")}
${w._wiki ? "参考（英語版Wikipedia冒頭）：\n" + w._wiki.extract : ""}

形式（Markdownの見出し##を使う）:
## 邦題と概要
（定着した邦題があれば『』で。2〜3文）
## 作品の背景
## 主題と特徴
## 文学史上の位置づけ
## 原文で読むときのヒント
（文体の特徴、時代特有の語彙、登場人物の呼び方など。結末のネタバレは避ける）
合計800字程度。`);
}
/* 論文：OpenAlex（英語圏の研究）＋ J-STAGE（日本語の研究） */
async function openalex(w) {
  const u = new URL("https://api.openalex.org/works");
  u.searchParams.set("search", `${shortTitle(w.t)} ${w.a === "Anonymous" ? "" : w.a.split(" ").pop()}`.trim());
  u.searchParams.set("per-page", "25");
  const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const abs = inv => { if (!inv) return ""; const arr = []; for (const [word, pos] of Object.entries(inv)) for (const p of pos) arr[p] = word; return arr.join(" ").slice(0, 500); };
  return (j.results || []).map(x => ({
    title: x.display_name || x.title || "", url: x.doi || x.id || "", year: String(x.publication_year || ""),
    journal: x.primary_location?.source?.display_name || "", authors: (x.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(", "),
    abstract: abs(x.abstract_inverted_index), cited: x.cited_by_count || 0, source: "OpenAlex",
  })).filter(p => p.title);
}
async function jstage(w) {
  const u = new URL("https://api.jstage.jst.go.jp/searchapi/do");
  u.searchParams.set("service", "3"); u.searchParams.set("count", "20"); u.searchParams.set("text", `${shortTitle(w.t)} ${w.a.split(" ").pop()}`);
  const r = await fetch(u); if (!r.ok) return [];
  const doc = new DOMParser().parseFromString(await r.text(), "application/xml");
  const pick = (el, sel) => { const n = el.querySelector(sel); return n ? n.textContent.trim() : ""; };
  return [...doc.getElementsByTagName("entry")].map(e => ({
    title: pick(e, "article_title ja") || pick(e, "article_title en"), url: pick(e, "article_link ja") || pick(e, "article_link en"),
    journal: pick(e, "material_title ja"), year: pick(e, "pubyear"), authors: [...e.querySelectorAll("author ja name")].map(n => n.textContent.trim()).slice(0, 3).join("、"),
    abstract: "", source: "J-STAGE",
  })).filter(p => p.title);
}
async function loadPapers(w) {
  if (!paperCache[w.id]) {
    let list = [], failed = 0;
    try { list = list.concat(await openalex(w)); } catch (e) { failed++; }
    try { list = list.concat(await jstage(w)); } catch (e) { failed++; }
    const seen = new Set();
    list = list.filter(p => { const k = norm(p.title); if (seen.has(k)) return false; seen.add(k); return true; });
    paperCache[w.id] = { list, failed: failed === 2 };
  }
  const box = $("#paper-box"); if (!box) return;
  const { list, failed } = paperCache[w.id];
  if (failed) { box.innerHTML = `<p class="hint">論文データベースに接続できませんでした。下のリンクから検索できます。</p>`; return; }
  if (!list.length) { box.innerHTML = `<p class="hint">論文は見つかりませんでした。下のリンクからも探せます。</p>`; return; }
  box.innerHTML = `<p class="hint" style="margin-top:0">${list.length}件</p>` + list.map((p, i) => `<a class="item" href="${esc(p.url)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:block">
    <span class="body"><span class="title" style="font-size:14.5px">[${i + 1}] ${esc(p.title)}</span><span class="meta">${esc([p.authors, p.journal, p.year].filter(Boolean).join(" / "))}・${p.source}${p.cited ? `・被引用${p.cited}` : ""}</span></span></a>`).join("");
}
function genCritique() {
  const w = workOf(detailId);
  const papers = (paperCache[w.id] && paperCache[w.id].list) || [];
  const list = papers.slice(0, 25).map((p, i) => `${i + 1}. ${p.title} / ${p.authors} / ${p.journal} ${p.year}${p.abstract ? "\n   Abstract: " + p.abstract.slice(0, 350) : ""}`).join("\n");
  runAI($("#ai-box"), "critique|" + w.id, papers.length
    ? `${w.t}（${w.a}）に関する研究論文の検索結果です。題名・要旨から読み取れる範囲で、この作品が研究上どのような観点から論じられてきたかを日本語で整理してください。作品と無関係な論文は無視してください。

${list}

形式（Markdownの見出し##を使う）:
## 主な論点
（観点ごとに太字の小見出し＋2〜3文。根拠となる論文番号を [3] のように添える）
## 初めて読む人へのおすすめ
（上の一覧から2〜3本、理由つきで）
論文の本文は読んでいないので、題名・要旨から推測できる範囲を超えて断定しないこと。`
    : `${w.t}（${w.a}）が文学研究・批評でどのような観点から論じられてきたかを、大学生向けに日本語で整理してください。
## 主な論点
（3〜5観点）
## 調べるときの検索語
（英語と日本語の検索語を4〜6個）
特定の研究者名・論文名・発表年は、確実なものだけ挙げること。`);
}

/* ============================================================
   読書画面
   ============================================================ */
let readingId = null, BLOCKS = [], TR = {}, plainCache = "", progressTimer = null, trBusy = false;
function applyReaderStyle() {
  const r = S.reader, el = $("#reader"), page = $("#page");
  el.dataset.rtheme = r.theme; el.dataset.showtr = String(r.showTr);
  page.style.setProperty("--r-size", r.size + "px");
  page.style.setProperty("--r-lh", r.lh);
  page.style.setProperty("--r-font", r.font === "sans" ? "var(--sans-en)" : "var(--serif-en)");
  $("#r-trbtn").setAttribute("aria-pressed", String(r.showTr));
}
const maxScroll = p => p.scrollHeight - p.clientHeight;
function ratio() { const p = $("#page"), m = maxScroll(p); return m <= 0 ? 1 : Math.min(1, Math.max(0, p.scrollTop / m)); }
function restore(r) { const p = $("#page"); p.scrollTop = r * maxScroll(p); }
function trHTML(i) { return TR[i] ? `<div class="tr" data-for="${i}" lang="ja">${esc(TR[i]).replace(/\n/g, "<br>")}</div>` : ""; }
function blockHTML(b, i) {
  if (b.k === "h") return `<h3 data-i="${i}" id="b${i}">${inlineHTML(b.s)}</h3>${trHTML(i)}`;
  return `<p data-i="${i}" id="b${i}"${b.k === "v" ? ' class="v"' : ""}>${inlineHTML(b.s)}</p>${trHTML(i)}`;
}
async function openReader(id, jumpTo) {
  const w = workOf(id); if (!w) return;
  readingId = id; BLOCKS = []; plainCache = "";
  const s = ensureShelf(w, "reading");
  if (s.status === "want") s.status = "reading";
  s.opened = Date.now(); save();
  $("#r-title").textContent = shortTitle(w.t); $("#r-author").textContent = w.a;
  applyReaderStyle();
  $("#page").innerHTML = `<div class="r-loading"><div class="thinking">本文を読み込み中…</div></div>`;
  $("#reader").hidden = false; $("#reader").classList.remove("hide-chrome");
  let t;
  try { t = await loadText(w); TR = (await idb.get("tr:" + id)) || {}; }
  catch (e) {
    if (readingId !== id) return;
    const msg = e.message || "本文を取得できませんでした。";
    $("#page").innerHTML = `<div class="r-loading"><p>${esc(msg)}</p><div class="row" style="gap:8px;justify-content:center;flex-wrap:wrap">${e.code === "noproxy" ? `<button class="btn primary" data-tab="settings">設定を開く</button>` : `<button class="btn" data-read="${id}">再試行</button>`}<button class="btn" data-act="paste">テキストを貼り付けて読む</button></div></div>`;
    return;
  }
  if (readingId !== id) return;
  BLOCKS = t.blocks; plainCache = blocksToPlain(BLOCKS);
  $("#page").innerHTML = `<div class="col"><div class="w-head"><p class="w-title">${esc(w.t)}</p><p class="w-author">${esc(w.a)}</p></div>${BLOCKS.map(blockHTML).join("")}<p class="r-note">— End —</p></div>`;
  const pos = jumpTo ?? (s.status === "finished" ? 0 : s.progress);
  requestAnimationFrame(() => { restore(pos); updateProgress(); });
  setTimeout(() => { restore(pos); updateProgress(); }, 300);
}
function updateProgress() {
  if (!readingId || !plainCache) return;
  const r = ratio(), s = S.shelf[readingId];
  $("#r-bar").style.width = Math.round(r * 100) + "%";
  $("#r-pct").textContent = Math.round(r * 100) + "%";
  $("#r-finish").hidden = !(r > 0.97 && s && s.status !== "finished");
  if (s && s.status !== "finished") { s.progress = r; clearTimeout(progressTimer); progressTimer = setTimeout(save, 500); }
}
function closeReader() { save(); readingId = null; plainCache = ""; BLOCKS = []; $("#reader").hidden = true; $("#selbar").hidden = true; if (!$("#detail").hidden) renderDetail(); render(); }

/* いま画面の上にある段落 */
function currentBlock() {
  const page = $("#page"), top = page.getBoundingClientRect().top + 8;
  for (const el of page.querySelectorAll("[data-i]")) if (el.getBoundingClientRect().bottom > top) return +el.dataset.i;
  return 0;
}
function chapterRange(i) {
  let s = i; while (s > 0 && BLOCKS[s].k !== "h") s--;
  let e = i + 1; while (e < BLOCKS.length && BLOCKS[e].k !== "h") e++;
  if (BLOCKS[s] && BLOCKS[s].k === "h") s++;
  // 題名だけの部分など短すぎるときは次の章にする
  if (e - s < 4 && e < BLOCKS.length - 1) return chapterRange(e);
  return [s, e];
}

/* ---------- 翻訳 ---------- */
function trInstruction() {
  return S.trStyle === "literal"
    ? "原文の構文と語の対応がたどれるよう、原文に忠実な日本語に訳してください（英語学習者が原文と照らし合わせて読む前提）。不自然になりすぎない範囲で直訳寄りに。"
    : "原文の語り口・時代の雰囲気・会話の調子を保った、自然で読みやすい日本語の文芸翻訳にしてください。";
}
function insertTr(i) {
  const el = document.getElementById("b" + i); if (!el) return;
  const next = el.nextElementSibling;
  if (next && next.classList.contains("tr")) next.remove();
  el.insertAdjacentHTML("afterend", trHTML(i));
}
async function translateIndices(indices, onStep, signal) {
  const w = workOf(readingId);
  const todo = indices.filter(i => !TR[i] && BLOCKS[i] && BLOCKS[i].s.trim());
  // 段落を 約3,500字ずつのまとまりに
  const batches = []; let cur = [], len = 0;
  for (const i of todo) {
    if (cur.length && (len + BLOCKS[i].s.length > 3500 || cur.length >= 14)) { batches.push(cur); cur = []; len = 0; }
    cur.push(i); len += BLOCKS[i].s.length;
  }
  if (cur.length) batches.push(cur);
  let done = 0;
  for (const b of batches) {
    const prev = b[0] > 0 && TR[b[0] - 1] ? `\n直前の段落の訳（文体と固有名詞の表記をそろえる参考に）：\n${TR[b[0] - 1].slice(-300)}\n` : "";
    const prompt = `以下は ${w.t}（${w.a}）の本文の、連続した${b.length}個の段落です。${trInstruction()}
・人名・地名はカタカナで、作品内で表記をそろえる
・段落の数と順番を変えない。見出しは見出しとして短く訳す
・詩や韻文は行分けを保ち、行の区切りは \\n で表す
${prev}
出力：JSON配列のみ。要素は各段落の訳文（文字列）で、ちょうど${b.length}個。例：["訳1","訳2"]

${b.map((i, k) => `[${k + 1}] ${BLOCKS[i].s}`).join("\n\n")}`;
    const arr = jsonArray(await callAI(prompt, { maxTokens: 4000, signal }));
    if (!arr || !arr.length) throw { code: "empty" };
    b.forEach((i, k) => { if (typeof arr[k] === "string" && arr[k].trim()) { TR[i] = arr[k].trim(); insertTr(i); } });
    await idb.set("tr:" + readingId, TR);
    done += b.length; onStep && onStep(done, todo.length);
  }
}
async function translateOne(i) {
  if (trBusy) return;
  const el = document.getElementById("b" + i); if (!el) return;
  if (TR[i]) { insertTr(i); return; }
  if (!aiReady()) { toast("翻訳にはAIのAPIキーが必要です（設定）"); return; }
  trBusy = true; el.classList.add("busy");
  try { await translateIndices([i]); }
  catch (e) { const m = aiError(e); if (m) toast(m); }
  finally { trBusy = false; el.classList.remove("busy"); }
}
function openChapterTranslate() {
  const i = currentBlock(), [s, e] = chapterRange(i);
  const head = s > 0 && BLOCKS[s - 1].k === "h" ? BLOCKS[s - 1].s : "この部分";
  const idx = []; for (let k = Math.max(0, s - 1); k < e; k++) idx.push(k);
  const todo = idx.filter(k => !TR[k]);
  const chars = todo.reduce((a, k) => a + BLOCKS[k].s.length, 0);
  const calls = Math.max(1, Math.ceil(chars / 3500), Math.ceil(todo.length / 14));
  openSheet("章をまとめて訳す", `<p style="margin:0"><b>${esc(head)}</b>（${idx.length}段落）</p>
    <p class="hint" style="margin:0">${todo.length ? `未翻訳 ${todo.length}段落・約${chars.toLocaleString()}字。AIを約${calls}回呼び出します。訳は端末に保存され、原文の下に表示されます。` : "この章はすべて訳してあります。"}</p>
    <div id="ct-out" class="hint"></div>
    <div class="row"><button class="btn ai" id="ct-go" ${todo.length ? "" : "disabled"}>✦ 訳す</button><button class="btn" data-act="close-sheet">閉じる</button></div>`);
  $("#ct-go").onclick = async () => {
    if (!aiReady()) { $("#ct-out").innerHTML = needKeyHTML(); return; }
    $("#ct-go").disabled = true; sheetCtl = new AbortController();
    if (!S.reader.showTr) { S.reader.showTr = true; save(); applyReaderStyle(); }
    $("#ct-out").innerHTML = `<div class="thinking">翻訳中… 0/${todo.length}</div>`;
    try {
      await translateIndices(idx, (d, n) => { const o = $("#ct-out"); if (o) o.innerHTML = `<div class="thinking">翻訳中… ${d}/${n}</div>`; }, sheetCtl.signal);
      closeSheet(); toast("この章を訳しました");
    } catch (err) {
      const m = aiError(err); const o = $("#ct-out"); if (o) o.innerHTML = m ? `<span style="color:var(--danger)">${esc(m)}</span>` : "";
      const g = $("#ct-go"); if (g) g.disabled = false;
    }
  };
}

/* ---------- 選択 ---------- */
function selectionInfo() {
  const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!$("#page").contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (!text) return null;
  let p = range.startContainer; while (p && !(p.dataset && p.dataset.i !== undefined) && p !== $("#page")) p = p.parentNode;
  const i = p && p.dataset && p.dataset.i !== undefined ? +p.dataset.i : -1;
  let ctx = i >= 0 ? BLOCKS[i].s.replace(/\s+/g, " ") : "";
  if (ctx.length > 600) { const k = Math.max(0, ctx.indexOf(text)); ctx = ctx.slice(Math.max(0, k - 250), k + text.length + 250); }
  return { text: text.slice(0, 600), context: ctx, i, pos: ratio() };
}
let lastSel = null;
document.addEventListener("selectionchange", () => {
  if ($("#reader").hidden) return;
  const info = selectionInfo();
  if (info) lastSel = info;
  $("#selbar").hidden = !info;
});
function savePhrase(sel, tr = "", note = "") {
  const w = workOf(readingId);
  S.phrases.unshift({ id: "p" + Date.now().toString(36), text: sel.text, tr, context: sel.context, note, workId: w.id, title: w.t, author: w.a, pos: sel.pos, at: Date.now() });
  save(); toast("ことばを保存しました");
}

/* ============================================================
   シート
   ============================================================ */
let sheetCtl = null;
function openSheet(title, html) { $("#sh-title").textContent = title; $("#sh-body").innerHTML = html; $("#sheet-wrap").hidden = false; }
function closeSheet() { if (sheetCtl) { sheetCtl.abort(); sheetCtl = null; } $("#sheet-wrap").hidden = true; }

function lookup(sel) {
  const w = workOf(readingId);
  const isWord = sel.text.split(" ").length <= 4;
  const hl = esc(sel.context).replace(esc(sel.text), `<mark>${esc(sel.text)}</mark>`);
  openSheet(isWord ? "ことばの意味" : "この文の意味", `<div class="quote-en" style="font-size:20px;font-weight:600">${esc(sel.text)}</div>
    ${sel.context && sel.context !== sel.text ? `<div class="ctx" lang="en">…${hl}…</div>` : ""}
    <div><span class="badge-ai">✦ AI</span></div>
    <div class="ai-out" id="lk-out"></div>
    <div class="row"><button class="btn primary" id="lk-save">解説ごと保存</button><button class="btn" data-act="close-sheet">閉じる</button></div>`);
  const key = "explain|" + w.id + "|" + sel.text;
  let result = S.ai[key] || "";
  $("#lk-save").onclick = () => { savePhrase(sel, "", result); closeSheet(); };
  if (result) { $("#lk-out").innerHTML = md(result); return; }
  sheetCtl = new AbortController();
  const prompt = isWord
    ? `${w.t}（${w.a}）を原書で読んでいる日本の読者が、次の語句の意味を知りたがっています。

語句：「${sel.text}」
文脈：「${sel.context}」

次の形式で簡潔に答えてください（見出しは付けない）。
**発音**：IPA とカタカナの目安
**品詞・原形**：（活用形なら原形も）
**この文脈での意味**：1〜2文、日本語で
**文の訳**：この語句を含む文の日本語訳
**補足**：古い用法・方言・時代背景・慣用句など、理解に役立つこと（なければ省略）`
    : `${w.t}（${w.a}）を原書で読んでいる日本の読者が、次の箇所の意味を知りたがっています。

箇所：「${sel.text}」
文脈：「${sel.context}」

次の形式で答えてください（見出しは付けない）。
**訳**：${S.trStyle === "literal" ? "原文に忠実な" : "自然な"}日本語訳
**構文**：文の骨組み（主語・動詞・修飾関係）を短く
**難しい語句**：箇条書きで3つまで、意味つき
**補足**：時代背景や含みなど（なければ省略）`;
  runAI($("#lk-out"), key, prompt, { maxTokens: 1000, signal: sheetCtl.signal }).then(t => { if (t) result = t; });
}
function translateSelection(sel) {
  const w = workOf(readingId);
  openSheet("訳", `<div class="quote-en">${esc(sel.text)}</div><div class="ai-out quote-ja" id="ts-out"></div>
    <div class="row"><button class="btn primary" id="ts-save" disabled>訳つきで保存</button><button class="btn" data-act="close-sheet">閉じる</button></div>`);
  const key = "trsel|" + w.id + "|" + S.trStyle + "|" + sel.text;
  const done = t => { const b = $("#ts-save"); if (!b) return; b.disabled = false; b.onclick = () => { savePhrase(sel, t); closeSheet(); }; };
  if (S.ai[key]) { $("#ts-out").innerHTML = md(S.ai[key]); done(S.ai[key]); return; }
  sheetCtl = new AbortController();
  runAI($("#ts-out"), key, `${w.t}（${w.a}）の一節です。${trInstruction()}訳文だけを出力してください。\n文脈（参考）：${sel.context}\n\n訳す箇所：${sel.text}`, { maxTokens: 1000, signal: sheetCtl.signal }).then(t => { if (t) done(t); });
}

let sumScope = "until";
function openSummary() {
  const w = workOf(readingId);
  const r = ratio(), bucket = Math.max(5, Math.floor(r * 20) * 5);
  const src = sumScope === "until" ? plainCache.slice(0, Math.max(3000, Math.round(plainCache.length * bucket / 100))) : plainCache;
  const parts = chunk(src, 20000).length;
  const key = `summary|${w.id}|${sumScope === "until" ? "u" + bucket : "whole"}`;
  openSheet("あらすじ", `<div class="seg"><button data-scope="until" aria-pressed="${sumScope === "until"}">いま読んだところまで</button><button data-scope="whole" aria-pressed="${sumScope === "whole"}">作品全体</button></div>
    <p class="hint" style="margin:0">${sumScope === "until" ? `先の展開に触れないよう、いまの位置（約${bucket}%）までの本文だけをAIに渡します。` : "結末まで含めて要約します。"} 対象 約${src.length.toLocaleString()}字${parts > 1 ? `／${parts}回に分けて要約してからまとめます（APIを計${parts + 1}回呼び出します）` : ""}。</p>
    <div class="panel"><div class="ai-out" id="sum-out">${S.ai[key] ? md(S.ai[key]) : '<p class="hint">ボタンを押すと日本語で作成します。</p>'}</div></div>
    <div class="row"><button class="btn ai" id="sum-go">${S.ai[key] ? "作り直す" : "✦ あらすじを作る"}</button></div>`);
  $("#sum-go").onclick = () => makeSummary(w, src, key);
}
const chunk = (text, size) => { const out = []; let cur = ""; for (const p of text.split("\n\n")) { if (cur.length + p.length > size && cur) { out.push(cur); cur = ""; } cur += p + "\n\n"; } if (cur.trim()) out.push(cur); return out; };
async function makeSummary(w, src, key) {
  const box = $("#sum-out"), btn = $("#sum-go");
  if (!aiReady()) { box.innerHTML = needKeyHTML(); return; }
  btn.disabled = true; sheetCtl = new AbortController();
  const spoil = sumScope === "until" ? "\n読者はまだこの先を読んでいません。与えた本文より先の展開には絶対に触れないでください。" : "";
  const fmt = `## ひとことで\n（40字以内）\n## あらすじ\n（300〜600字）\n## 登場人物\n（主要人物を箇条書き。カタカナ表記と原綴りを併記）\n## 読みどころ\n（2〜3点）`;
  const parts = chunk(src, 20000);
  try {
    if (parts.length === 1) {
      await runAI(box, key, `${w.t}（${w.a}）の本文です。日本語で次の形式で要約してください。${spoil}\n${fmt}\n\n---本文---\n${src}`, { signal: sheetCtl.signal });
    } else {
      const notes = new Array(parts.length); let done = 0, next = 0;
      const worker = async () => {
        while (next < parts.length) {
          const i = next++;
          notes[i] = await callAI(`${w.t}（${w.a}）の本文の一部（${i + 1}/${parts.length}）です。この部分の出来事・人物の動き・重要な描写を、日本語で300字程度の箇条書きに要約してください。\n---本文---\n${parts[i]}`, { maxTokens: 1200, signal: sheetCtl.signal });
          done++; box.innerHTML = `<div class="thinking">区切りごとに要約中… ${done}/${parts.length}</div>`;
        }
      };
      box.innerHTML = `<div class="thinking">区切りごとに要約中… 0/${parts.length}</div>`;
      await Promise.all([worker(), worker(), worker()]);
      await runAI(box, key, `${w.t}（${w.a}）を順に区切って要約したメモです。統合して日本語で次の形式でまとめてください。${spoil}\n${fmt}\n\n---メモ---\n${notes.map((n, i) => `【${i + 1}】\n${n}`).join("\n\n")}`, { signal: sheetCtl.signal });
    }
  } catch (e) { const m = aiError(e); if (m) box.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(m)}</p>`; }
  btn.disabled = false; btn.textContent = "作り直す";
}
function openToc() {
  const heads = BLOCKS.map((b, i) => [b, i]).filter(([b]) => b.k === "h");
  const cur = currentBlock();
  openSheet("目次", heads.length
    ? `<div class="list">${heads.map(([b, i]) => `<button class="toc-item${i <= cur ? " past" : ""}" data-goto="${i}"><span>${esc(b.s)}</span>${TR[i] ? `<small>${esc(TR[i])}</small>` : ""}</button>`).join("")}</div>`
    : `<p class="hint">見出しが見つかりませんでした。</p>`);
}
function openStyleSheet() { openSheet("表示", `<div style="display:flex;flex-direction:column;gap:10px">${styleControls(S.reader)}</div>`); }
function openNote(id) {
  const p = S.phrases.find(x => x.id === id); if (!p) return;
  openSheet("メモ", `<div class="quote-en">${esc(p.text)}</div>${p.tr ? `<div class="quote-ja">${esc(p.tr)}</div>` : ""}
    <label class="hint" for="note-ta">メモ</label><textarea id="note-ta">${esc(p.note || "")}</textarea>
    <div class="row"><button class="btn primary" id="note-save">保存</button></div>`);
  $("#note-save").onclick = () => { p.note = $("#note-ta").value; save(); closeSheet(); render(); };
}
function openRate() {
  openSheet("読了おめでとうございます", `<p style="margin:0">評価をつけると、おすすめに反映されます。</p><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button data-finrate="${n}" style="font-size:30px">☆</button>`).join("")}</div>`);
  document.querySelectorAll("[data-finrate]").forEach(b => b.onclick = () => { S.shelf[readingId].rating = +b.dataset.finrate; save(); closeSheet(); toast("評価を保存しました"); });
}
function openPaste() {
  openSheet("テキストを貼り付けて読む", `<p class="hint" style="margin:0">本文を取得できないときや、目録にない作品に使います。Project Gutenberg のテキストを全選択してコピーし、貼り付けてください。</p>
    <textarea id="paste-ta" placeholder="ここに貼り付け" style="min-height:130px" lang="en"></textarea>
    <div class="row" style="gap:8px"><input type="text" id="paste-title" placeholder="題名" aria-label="題名"><input type="text" id="paste-author" placeholder="作者" aria-label="作者" style="max-width:40%"></div>
    <button class="btn primary block" id="paste-go">この本文で読む</button>`);
  if (detailId && BY_ID[detailId]) { $("#paste-title").value = BY_ID[detailId].t; $("#paste-author").value = BY_ID[detailId].a; }
  $("#paste-go").onclick = async () => {
    const raw = $("#paste-ta").value; if (raw.trim().length < 50) { toast("本文が短すぎます"); return; }
    const title = $("#paste-title").value.trim() || (raw.match(/^Title:\s*(.+)$/m) || [])[1] || "Untitled";
    const author = $("#paste-author").value.trim() || (raw.match(/^Author:\s*(.+)$/m) || [])[1] || "Unknown";
    const found = detailId && BY_ID[detailId] && BY_ID[detailId].t === title ? BY_ID[detailId] : null;
    const w = found || { id: "imp-" + hash(title + author), t: title, a: author, ad: "", lang: "", sh: "", sub: "" };
    await idb.set("text:" + w.id, { blocks: parseGutenberg(raw), at: Date.now() });
    S.downloaded[w.id] = Date.now(); ensureShelf(w, "reading"); save();
    closeSheet(); render(); openReader(w.id);
  };
}

/* ============================================================
   イベント
   ============================================================ */
document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-open], [data-read]");
  if (!t) {
    const pg = e.target.closest("#page");
    if (pg && getSelection().isCollapsed && plainCache) {
      const blk = e.target.closest("[data-i]");
      if (S.reader.showTr && blk) translateOne(+blk.dataset.i);
      else $("#reader").classList.toggle("hide-chrome");
    }
    return;
  }
  const d = t.dataset;
  if (d.tab) { closeSheet(); if (!$("#reader").hidden) closeReader(); return setTab(d.tab); }
  if (d.read) { closeSheet(); return openReader(d.read); }
  if (d.open) return openDetail(d.open);
  if (d.tag) { S.tags = S.tags.includes(d.tag) ? S.tags.filter(x => x !== d.tag) : [...S.tags, d.tag]; save(); return render(); }
  if (d.author) { searchQ = d.author; return render(); }
  if (d.genre) { $("#results").innerHTML = genreResults(d.genre); return; }
  if (d.lang) { searchLang = d.lang; return render(); }
  if (d.shelf) { shelfFilter = d.shelf; return render(); }
  if (d.pane) { detailPane = d.pane; return renderDetail(); }
  if (d.rate) { const s = S.shelf[detailId]; s.rating = s.rating === +d.rate ? 0 : +d.rate; save(); return renderDetail(); }
  if (d.scope) { sumScope = d.scope; return openSummary(); }
  if (d.provider) { S.aiProvider = d.provider; save(); return render(); }
  if (d.trstyle) { S.trStyle = d.trstyle; save(); return render(); }
  if (d.goto) { closeSheet(); const el = document.getElementById("b" + d.goto); if (el) el.scrollIntoView({ block: "start" }); return; }
  if (d.style) {
    const v = d.val === "true" ? true : d.val === "false" ? false : isNaN(+d.val) ? d.val : +d.val;
    const keep = readingId && plainCache ? ratio() : 0;
    S.reader[d.style] = v; save();
    if (readingId) { applyReaderStyle(); requestAnimationFrame(() => { restore(keep); updateProgress(); }); openStyleSheet(); }
    else render();
    return;
  }
  if (d.share) {
    const p = S.phrases.find(x => x.id === d.share), s = `"${p.text}"${p.tr ? `\n「${p.tr}」` : ""}\n— ${p.author}, ${shortTitle(p.title)}`;
    if (navigator.share) navigator.share({ text: s }).catch(() => {});
    else navigator.clipboard?.writeText(s).then(() => toast("コピーしました"), () => toast("コピーできませんでした"));
    return;
  }
  if (d.note) return openNote(d.note);
  if (d.jump) { const p = S.phrases.find(x => x.id === d.jump); if (p) openReader(p.workId, p.pos); return; }
  if (d.delphrase) { S.phrases = S.phrases.filter(x => x.id !== d.delphrase); save(); return render(); }
  switch (d.act) {
    case "close-detail": $("#detail").hidden = true; detailId = null; return render();
    case "close-reader": return closeReader();
    case "close-sheet": return closeSheet();
    case "reader-style": return openStyleSheet();
    case "summary": if (plainCache) openSummary(); return;
    case "toc": if (plainCache) openToc(); return;
    case "tr-toggle": S.reader.showTr = !S.reader.showTr; save(); applyReaderStyle(); toast(S.reader.showTr ? "段落をタップすると訳を表示します" : "原文のみ表示"); return;
    case "tr-chapter": if (plainCache) openChapterTranslate(); return;
    case "finish": { const s = S.shelf[readingId]; s.status = "finished"; s.progress = 1; save(); updateProgress(); toast("読了にしました"); if (!s.rating) openRate(); return; }
    case "sel-lookup": { const s = selectionInfo() || lastSel; if (s) lookup(s); return; }
    case "sel-tr": { const s = selectionInfo() || lastSel; if (s) translateSelection(s); return; }
    case "sel-save": { const s = selectionInfo() || lastSel; if (s) { savePhrase(s); getSelection().removeAllRanges(); } return; }
    case "paste": if (!$("#reader").hidden) closeReader(); return openPaste();
    case "recommend": return recommend();
    case "gen-commentary": return genCommentary();
    case "gen-critique": return genCritique();
    case "reload-catalog": return loadCatalog(true);
    case "ai-test": return aiTest();
    case "proxy-test": return proxyTest();
    case "reset-ask": $("#reset-area").innerHTML = `<div class="row" style="flex-wrap:wrap"><span class="hint">本棚・ことば・保存した本文と訳・APIキーがすべて消えます。</span><button class="btn small" data-act="reset-do" style="color:var(--danger)">消去する</button><button class="btn small" data-act="reset-cancel">やめる</button></div>`; return;
    case "reset-cancel": return render();
    case "reset-do": try { localStorage.removeItem(KEY); } catch (e) {} idb.clear().then(() => location.reload()); return;
  }
});
async function aiTest() {
  const out = $("#ai-test-out");
  out.innerHTML = '<div class="thinking">接続を確認中…</div>';
  try { const r = await callAI("「Pride and Prejudice」の作者名だけを日本語で答えてください。", { maxTokens: 50 }); out.textContent = `接続できました（応答：${r.slice(0, 30)}）`; }
  catch (e) { out.innerHTML = `<span style="color:var(--danger)">${esc(aiError(e))}</span>`; }
}
async function proxyTest() {
  const out = $("#proxy-out");
  S.proxy = ($("#proxy").value || "").trim().replace(/\/+$/, ""); save();
  if (!/^https:\/\//.test(S.proxy)) { out.innerHTML = `<span style="color:var(--danger)">https:// で始まるURLを入れてください。</span>`; return; }
  out.innerHTML = '<div class="thinking">確認中…</div>';
  try {
    const r = await fetch(S.proxy + "/?id=1342");
    const t = r.ok ? await r.text() : "";
    out.innerHTML = /Pride and Prejudice/i.test(t) ? "使えます（『高慢と偏見』を取得できました）" : `<span style="color:var(--danger)">応答はありましたが本文ではありませんでした（HTTP ${r.status}）。URLとWorkerのコードを確かめてください。</span>`;
  } catch (e) { out.innerHTML = `<span style="color:var(--danger)">接続できませんでした。URLが正しいか、Workerを「Deploy」したか確かめてください。</span>`; }
}
document.addEventListener("change", e => {
  if (e.target.id === "status-sel") {
    const v = e.target.value, w = workOf(detailId);
    if (!v) delete S.shelf[detailId]; else ensureShelf(w, v).status = v;
    if (v === "finished") S.shelf[detailId].progress = 1;
    save(); renderDetail();
  }
});
document.addEventListener("input", e => {
  const id = e.target.id;
  if (id === "q") { searchQ = e.target.value; clearTimeout(window._qt); window._qt = setTimeout(() => { $("#results").innerHTML = searchResults(); }, 250); }
  if (id === "pq") { phraseQ = e.target.value; const pos = e.target.selectionStart; render(); const el = $("#pq"); el.focus(); el.setSelectionRange(pos, pos); }
  if (id === "ai-key") { S.aiKeys[S.aiProvider] = e.target.value.trim(); save(); }
  if (id === "ai-model") { S.aiModels[S.aiProvider] = e.target.value.trim(); save(); }
  if (id === "proxy") { S.proxy = e.target.value.trim().replace(/\/+$/, ""); save(); }
});
$("#page").addEventListener("scroll", () => requestAnimationFrame(updateProgress), { passive: true });
["mousedown", "pointerdown"].forEach(ev => $("#selbar").addEventListener(ev, e => e.preventDefault()));
$("#sheet-wrap").addEventListener("click", e => { if (e.target.id === "sheet-wrap") closeSheet(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if (!$("#sheet-wrap").hidden) closeSheet(); else if (!$("#reader").hidden) closeReader(); else if (!$("#detail").hidden) { $("#detail").hidden = true; render(); } }
  if (!$("#reader").hidden && $("#sheet-wrap").hidden && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === " ")) {
    const p = $("#page"); if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    e.preventDefault(); p.scrollBy({ top: (e.key === "ArrowUp" ? -1 : 1) * (p.clientHeight - 60), behavior: "smooth" });
  }
});

/* 起動 */
render();
loadCatalog();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
