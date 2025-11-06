/* assets/imdb.js — Browser replacement for imdb_suggest.sh
   - Static-friendly (GitHub Pages): uses JSONP to bypass CORS
   - Aggregates many IMDb "suggests" responses
   - Dedup (tt*), sort by rank, render as cards
   - Safe-timeouts, capped queries, progress bar, single-flight submit
   - NEW: Local persistence (localStorage): autosave + autoload + history
*/

// ---------- CONFIG (safe defaults) ----------
const CONFIG = {
    maxQueriesSearch: 40,      // תקרת וריאציות כאשר יש שאילתה
    maxQueriesDiscover: 40,    // תקרת זרעים במצב Discovery (שדה ריק)
    concurrency: 6,            // גודל מאגר מקביליות
    perRequestTimeoutMs: 2500, // timeout קצר לכל JSONP
    globalTimeoutMs: 12000,    // hard stop כולל
    interRequestDelayMs: 30,   // דיליי קטן בין בקשות
    historyLimit: 15           // כמה חיפושים לשמור בהיסטוריה
  };
  
  // ---------- STORAGE KEYS ----------
  const STORAGE = {
    lastResults: "imdb:last_results:v1",
    lastMeta: "imdb:last_meta:v1",
    history: "imdb:history:v1"
  };
  
  // ---------- utilities ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const slug = (s) => (s || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    || "query";
  
  const urlencode = (s) => encodeURIComponent(s);
  
  function safeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn("localStorage set failed:", e);
      return false;
    }
  }
  function safeGet(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      console.warn("localStorage get failed:", e);
      return fallback;
    }
  }
  function pushHistory(entry) {
    const hist = safeGet(STORAGE.history, []);
    hist.unshift(entry); // הכי חדש בתחילה
    // dedup לפי שאילתה+דגלים, שמור עד התקרה
    const seen = new Set();
    const deduped = [];
    for (const h of hist) {
      const k = `${h.query}::${h.variations?'1':'0'}::${h.images?'1':'0'}`;
      if (!seen.has(k)) { seen.add(k); deduped.push(h); }
      if (deduped.length >= CONFIG.historyLimit) break;
    }
    safeSet(STORAGE.history, deduped);
    return deduped;
  }
  
  // IMDb JSONP: https://sg.media-imdb.com/suggests/<first-letter>/<query>.json
  // Callback name is imdb$<query_lower_underscored>
  function buildJSONPUrl(q) {
    const first = q.trim().charAt(0).toLowerCase() || "a";
    const encoded = urlencode(q);
    return `https://sg.media-imdb.com/suggests/${first}/${encoded}.json`;
  }
  function jsonpCallbackName(q) {
    return "imdb$" + q.toLowerCase().replace(/[^a-z0-9]/g, "_");
  }
  
  // ---------- query expansion ----------
  function expandQueries(base, useVariations) {
    const q = [];
    if (base) {
      q.push(base);
      if (useVariations) {
        // וריאציות רזות שמספיקות לעקוף מגבלת ~8 תוצאות:
        q.push(`${base} movie`, `${base} series`, `${base} season`);
        for (const ch of "abcdefghijklmnopqrstuvwxyz") q.push(`${base} ${ch}`);
        for (const d of "0123456789") q.push(`${base} ${d}`);
      }
      return [...new Set(q)].slice(0, CONFIG.maxQueriesSearch);
    } else {
      // Discovery: קומבינציה שימושית אבל מוגבלת
      q.push("the","new","best","top","movie","series","2024","2025");
      for (const ch of "abcdefghijklmnopqrstuvwxyz") q.push(ch);
      return [...new Set(q)].slice(0, CONFIG.maxQueriesDiscover);
    }
  }
  
  // ---------- JSONP loader with per-request timeout ----------
  function loadSuggest(q, timeoutMs = CONFIG.perRequestTimeoutMs) {
    return new Promise((resolve) => {
      const url = buildJSONPUrl(q);
      const cbName = jsonpCallbackName(q);
  
      let done = false;
      const finish = (val) => { if (!done) { done = true; cleanup(); resolve(val); } };
  
      const timer = setTimeout(() => finish(null), timeoutMs);
      const script = document.createElement("script");
  
      function cleanup() {
        try { delete window[cbName]; } catch (_) {}
        clearTimeout(timer);
        if (script.parentNode) script.parentNode.removeChild(script);
      }
  
      window[cbName] = (data) => finish(data || null);
      script.src = url;
      script.onerror = () => finish(null);
      document.head.appendChild(script);
    });
  }
  
  // ---------- concurrent loader with progress + global hard stop ----------
  async function loadAll(queries, onProgress) {
    const results = [];
    let i = 0, done = 0, canceled = false;
  
    const progressEl = document.getElementById("progress");
    if (progressEl) { progressEl.style.display = "inline-block"; progressEl.value = 0; }
  
    const globalTimer = setTimeout(() => { canceled = true; }, CONFIG.globalTimeoutMs);
  
    async function worker() {
      while (!canceled && i < queries.length) {
        const my = i++;
        const q = queries[my];
        const data = await loadSuggest(q);
        if (data && data.d && Array.isArray(data.d)) results.push(...data.d);
        done++;
        const pct = Math.round((done / queries.length) * 100);
        if (progressEl) progressEl.value = pct;
        if (onProgress) onProgress({ done, total: queries.length, pct });
        await sleep(CONFIG.interRequestDelayMs);
      }
    }
  
    const threads = Math.min(CONFIG.concurrency, queries.length);
    await Promise.all(Array.from({ length: threads }, () => worker()));
  
    clearTimeout(globalTimer);
    if (progressEl) setTimeout(() => (progressEl.style.display = "none"), 400);
    return results;
  }
  
  // ---------- normalization ----------
  function normalize(items, wantImages) {
    const out = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const id = it.id;
      if (!id || !/^tt/.test(id)) continue; // titles only
      const obj = {
        id,
        title: it.l || "",
        kind: it.q || "",
        year: it.y ?? null,
        rank: it.rank ?? null,
        href: `https://www.imdb.com/title/${id}/`,
        image_url: wantImages ? (it.i && it.i.imageUrl) || null : null,
        image_width: wantImages ? (it.i && it.i.width) || null : null,
        image_height: wantImages ? (it.i && it.i.height) || null : null
      };
      out.push(obj);
    }
    // dedup by id
    const seen = new Set();
    const unique = [];
    for (const x of out) {
      if (!seen.has(x.id)) { seen.add(x.id); unique.push(x); }
    }
    // sort by rank (nulls last)
    unique.sort((a, b) => {
      const ra = a.rank ?? Number.POSITIVE_INFINITY;
      const rb = b.rank ?? Number.POSITIVE_INFINITY;
      return ra - rb;
    });
    return { len: unique.length, titles: unique };
  }
  
  // ---------- rendering ----------
  function renderCards(model) {
    if (!model || !Array.isArray(model.titles) || model.titles.length === 0) {
      return "<p>No results.</p>";
    }
    return model.titles.map(t => {
      const img = t.image_url ? `<img src="${t.image_url}" alt="">` : `<img alt="" />`;
      return `
        <article class="card">
          ${img}
          <div class="meta">
            <a class="title" href="${t.href}" target="_blank" rel="noopener">${t.title}</a>
            <div>
              <span class="badge">${t.kind || "title"}</span>
              ${t.year ? `<span class="badge">${t.year}</span>` : ""}
              ${t.rank != null ? `<span class="badge">rank ${t.rank}</span>` : ""}
            </div>
            <small>${t.id}</small>
          </div>
        </article>
      `;
    }).join("");
  }
  
  // ---------- app wiring (called from htmx via hx-on) ----------
  window.imdbApp = (() => {
    let lastJSON = { len: 0, titles: [] };
    let busy = false;
  
    // --- persistence helpers ---
    function autosave(meta) {
      // meta: { query, variations, images, timestamp }
      const ok1 = safeSet(STORAGE.lastResults, lastJSON);
      const ok2 = safeSet(STORAGE.lastMeta, meta);
      const histEntry = { ...meta, results: lastJSON.len };
      pushHistory(histEntry);
      return ok1 && ok2;
    }
  
    function autoload() {
      const saved = safeGet(STORAGE.lastResults, null);
      const meta = safeGet(STORAGE.lastMeta, null);
      return { saved, meta };
    }
  
    function renderFromSaved(saved, meta) {
      if (!saved || !saved.titles) return false;
      const resultsEl = document.getElementById("results");
      const status = document.getElementById("status");
      resultsEl.innerHTML = renderCards(saved);
      lastJSON = saved;
      const qInput = document.getElementById("q");
      const vChk = document.getElementById("variations");
      const iChk = document.getElementById("images");
      if (meta) {
        if (qInput && typeof meta.query === "string") qInput.value = meta.query;
        if (vChk && typeof meta.variations === "boolean") vChk.checked = meta.variations;
        if (iChk && typeof meta.images === "boolean") iChk.checked = meta.images;
        const when = meta.timestamp ? new Date(meta.timestamp) : null;
        const whenStr = when ? when.toLocaleString() : "previous session";
        if (status) status.textContent = `Restored ${saved.len} titles from local cache (${whenStr})`;
      } else {
        if (status) status.textContent = `Restored ${saved.len} titles from local cache`;
      }
      return true;
    }
  
    // --- public ops for future UI hooks ---
    function save() {
      const qInput = document.getElementById("q");
      const vChk = document.getElementById("variations");
      const iChk = document.getElementById("images");
      const meta = {
        query: (qInput && qInput.value.trim()) || "",
        variations: !!(vChk && vChk.checked),
        images: !!(iChk && iChk.checked),
        timestamp: Date.now()
      };
      const ok = autosave(meta);
      const status = document.getElementById("status");
      if (status) status.textContent = ok ? "Saved locally." : "Save failed (storage).";
      return ok;
    }
  
    function load() {
      const { saved, meta } = autoload();
      const ok = renderFromSaved(saved, meta);
      const status = document.getElementById("status");
      if (!ok && status) status.textContent = "No local data found.";
      return ok;
    }
  
    function clearHistory() {
      safeSet(STORAGE.history, []);
      const status = document.getElementById("status");
      if (status) status.textContent = "History cleared.";
    }
  
    // --- main submit flow ---
    async function onSubmit(evt) {
      evt.preventDefault();
      if (busy) return false;     // single-flight guard
      busy = true;
  
      const q = document.getElementById("q").value.trim();
      const wantVar = document.getElementById("variations").checked;
      const wantImg = document.getElementById("images").checked;
      const status = document.getElementById("status");
      const resultsEl = document.getElementById("results");
  
      status.textContent = "Loading…";
      resultsEl.innerHTML = "";
  
      const qs = expandQueries(q, wantVar);
  
      try {
        const raw = await loadAll(qs, ({ pct }) => { status.textContent = `Loading… ${pct}%`; });
        const model = normalize(raw, wantImg);
        lastJSON = model;
        resultsEl.innerHTML = renderCards(model);
        status.textContent = `Found ${model.len} unique titles (capped)`;
  
        // autosave on success
        autosave({ query: q, variations: wantVar, images: wantImg, timestamp: Date.now() });
      } catch (e) {
        console.error(e);
        status.textContent = "Error while loading data.";
        resultsEl.innerHTML = "<p>Failed to load.</p>";
      } finally {
        busy = false;
      }
      return false;
    }
  
    // --- autoload on first paint ---
    document.addEventListener("DOMContentLoaded", () => {
      // שחזור תוצאות אחרונות אם קיימות
      const { saved, meta } = autoload();
      renderFromSaved(saved, meta);
    });
  
    // public API
    return { onSubmit, downloadJSON, save, load, clearHistory };
  
    // existing download stays the same:
    function downloadJSON() {
      const blob = new Blob([JSON.stringify(lastJSON, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const input = document.getElementById("q");
      const name = slug(input && input.value);
      a.download = `${name}.${new Date().toISOString().slice(0,19).replace(/[:T]/g,'_')}.imdb.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  })();
  