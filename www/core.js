/* openboard core: логика без DOM. Работает и в браузере (window.OB), и в Node (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OB = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const PRESETS = {
    "OpenRouter": "https://openrouter.ai/api/v1",
    "NVIDIA NIM": "https://integrate.api.nvidia.com/v1",
    "OpenAI": "https://api.openai.com/v1",
    "Groq": "https://api.groq.com/openai/v1",
    "Ollama (локально)": "http://localhost:11434/v1",
    "Свой base_url": "",
  };
  const ACCENTS = {
    violet: ["#7A6BFF", "#9387FF", "Фиолетовый"], blue: ["#3B82F6", "#5F9BFF", "Синий"],
    green: ["#1FA971", "#33C48A", "Зелёный"], orange: ["#F07F2D", "#FF9A4D", "Оранжевый"],
    pink: ["#E5499B", "#F26BB3", "Розовый"],
  };
  const DEFAULT_SKILLS = [
    { id: "kratko", name: "Кратко и по делу", text: "Отвечай максимально кратко: сначала вывод, затем только важные детали. Без вступлений и повторов." },
    { id: "code-review", name: "Ревью кода", text: "Когда пользователь присылает код, проведи ревью: 1) ошибки, 2) безопасность, 3) читаемость, 4) конкретные исправления. Указывай строки, где возможно." },
    { id: "translator", name: "Переводчик", text: "Переводи текст пользователя между русским и английским (направление определяй сам). Сохраняй смысл и тон, пояснения добавляй только по просьбе." },
  ];
  const DEFAULT_CONFIG = {
    provider: "OpenRouter", base_url: PRESETS["OpenRouter"], api_key: "", model: "", models: [],
    price_in_1m: 0, price_out_1m: 0, monthly_budget: 0,
    system_prompt: "Ты полезный ассистент. Отвечай по делу.", history_limit: 40,
    web_search: false, skills: DEFAULT_SKILLS, active_skills: [], theme: "dark", accent: "violet",
    native_http: false,
  };
  const WEB_PROMPT = "У тебя есть веб-поиск (web_search) и загрузка страниц (fetch_url). Сегодня {date}. Используй их, когда нужны актуальные факты, и называй источники (URL).";
  const MAX_STEPS = 8;
  const MAX_TEXT_ATTACH = 300000;
  const MAX_IMAGE_ATTACH = 5000000;

  class ApiError extends Error {}

  // ---------- утилиты ----------
  function truncate(text, limit) {
    if (text.length <= limit) return text;
    const head = Math.floor(limit / 3);
    return text.slice(0, head) + "\n… (обрезано) …\n" + text.slice(text.length - (limit - head));
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function decodeEntities(s) {
    const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return map[e.toLowerCase()] !== undefined ? map[e.toLowerCase()] : m;
    });
  }
  const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, "")).trim();
  const shortBody = (d) => (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 600);

  // ---------- markdown (безопасный: всё экранируется) ----------
  function inline(text) {
    return escapeHtml(text).split(/(`[^`\n]+`)/).map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return "<code>" + part.slice(1, -1) + "</code>";
      return part
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }).join("");
  }
  function codeBlock(lang, code) {
    return '<pre><div class="codehead"><span>' + escapeHtml((lang || "code").toUpperCase()) +
      '</span><button class="copy" type="button">Копировать</button></div><code>' + escapeHtml(code) + "</code></pre>";
  }
  function renderMarkdown(text) {
    let html = "", inCode = false, lang = "", code = [], list = null;
    const closeList = () => { if (list) { html += "</" + list + ">"; list = null; } };
    for (const line of String(text).split("\n")) {
      const fence = line.trim().match(/^```([\w+-]*)/);
      if (fence) {
        if (!inCode) { closeList(); inCode = true; lang = fence[1]; code = []; }
        else { html += codeBlock(lang, code.join("\n")); inCode = false; }
        continue;
      }
      if (inCode) { code.push(line); continue; }
      const h = line.match(/^(#{1,3})\s+(.*)$/), ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) { closeList(); const n = h[1].length + 2; html += "<h" + n + ">" + inline(h[2]) + "</h" + n + ">"; }
      else if (ul) { if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; } html += "<li>" + inline(ul[1]) + "</li>"; }
      else if (ol) { if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; } html += "<li>" + inline(ol[1]) + "</li>"; }
      else if (!line.trim()) { closeList(); html += '<div class="sp"></div>'; }
      else { closeList(); html += "<p>" + inline(line) + "</p>"; }
    }
    if (inCode) html += codeBlock(lang, code.join("\n"));
    closeList();
    return html;
  }

  // ---------- стоимость ----------
  function computeCost(usage, priceIn, priceOut, promptChars) {
    usage = usage || {};
    if (usage.cost !== undefined && usage.cost !== null && Number.isFinite(Number(usage.cost))) {
      return { cost: Number(usage.cost), pt: usage.prompt_tokens || 0, ct: usage.completion_tokens || 0 };
    }
    let pt = usage.prompt_tokens, ct = usage.completion_tokens;
    if (pt === undefined || pt === null) { pt = Math.floor((promptChars || 0) / 4); ct = Math.floor((usage._chars || 0) / 4); }
    return { cost: (pt * (priceIn || 0) + (ct || 0) * (priceOut || 0)) / 1e6, pt, ct: ct || 0 };
  }
  function monthSpend(usage, now) {
    const d = new Date(now || Date.now());
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return usage.reduce((s, u) => (u.ts >= start ? s + (u.cost || 0) : s), 0);
  }
  function usageByModel(usage) {
    const m = {};
    for (const u of usage) {
      const r = m[u.model] || (m[u.model] = { model: u.model, calls: 0, pt: 0, ct: 0, cost: 0 });
      r.calls++; r.pt += u.pt || 0; r.ct += u.ct || 0; r.cost += u.cost || 0;
    }
    return Object.values(m).sort((a, b) => b.cost - a.cost);
  }

  // ---------- API ----------
  function headersFor(baseUrl, key) {
    const h = { "Content-Type": "application/json" };
    if (key) h.Authorization = "Bearer " + key;
    if (/openrouter\.ai/.test(baseUrl)) h["X-Title"] = "openboard";
    return h;
  }
  const perMillion = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : null; };

  async function listModels({ baseUrl, key, fetchImpl, native }) {
    const url = baseUrl.replace(/\/+$/, "") + "/models";
    let data;
    if (native) {
      const r = await native({ url, method: "GET", headers: headersFor(baseUrl, key) });
      if (r.status >= 400) throw new ApiError("HTTP " + r.status + ": " + shortBody(r.data));
      data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    } else {
      const r = await (fetchImpl || fetch)(url, { headers: headersFor(baseUrl, key) });
      if (!r.ok) throw new ApiError("HTTP " + r.status + ": " + (await r.text()).slice(0, 600));
      data = await r.json();
    }
    const items = Array.isArray(data) ? data : data.data || [];
    return items.filter((m) => m && m.id).map((m) => ({
      id: m.id, in: perMillion((m.pricing || {}).prompt), out: perMillion((m.pricing || {}).completion),
      tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null,
    })).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  function applyChunk(obj, st, onDelta) {
    if (obj.error) throw new ApiError(typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error));
    if (obj.usage) st.usage = obj.usage;
    for (const ch of obj.choices || []) {
      const d = ch.delta || {};
      if (d.content) { st.chars += d.content.length; onDelta(d.content); }
      for (const tc of d.tool_calls || []) {
        let i = tc.index;
        if (i === undefined || i === null) i = tc.id ? Object.keys(st.calls).length : Math.max(0, ...Object.keys(st.calls).map(Number));
        const c = st.calls[i] || (st.calls[i] = { id: "", name: "", arguments: "" });
        if (tc.id) c.id = tc.id;
        const f = tc.function || {};
        if (f.name && !c.name) c.name = f.name;
        if (f.arguments) c.arguments += f.arguments;
      }
    }
  }
  function finishState(st) {
    st.usage._chars = st.usage._chars || st.chars;
    const calls = Object.keys(st.calls).map(Number).sort((a, b) => a - b).map((i) => st.calls[i]).filter((c) => c.name);
    calls.forEach((c, n) => { if (!c.id) c.id = "call_" + Date.now() + "_" + n; });
    return { usage: st.usage, toolCalls: calls };
  }

  /** Стриминг ответа. o: {baseUrl,key,model,messages,tools,signal,onDelta,fetchImpl,native} */
  async function streamChat(o) {
    const url = o.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const headers = headersFor(o.baseUrl, o.key);
    const st = { usage: {}, chars: 0, calls: {} };
    const onDelta = o.onDelta || (() => {});
    const payload = { model: o.model, messages: o.messages };
    if (o.tools && o.tools.length) payload.tools = o.tools;

    if (o.native) {  // без стриминга: для провайдеров без CORS
      const r = await o.native({ url, method: "POST", headers, data: { ...payload, stream: false } });
      if (r.status >= 400) throw new ApiError("HTTP " + r.status + ": " + shortBody(r.data));
      const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      const msg = ((data.choices || [])[0] || {}).message || {};
      if (msg.content) { st.chars += msg.content.length; onDelta(msg.content); }
      (msg.tool_calls || []).forEach((tc, i) => {
        st.calls[i] = { id: tc.id || "", name: (tc.function || {}).name || "", arguments: (tc.function || {}).arguments || "" };
      });
      if (data.usage) st.usage = data.usage;
      return finishState(st);
    }

    const f = o.fetchImpl || fetch;
    const body = { ...payload, stream: true, stream_options: { include_usage: true } };
    const send = (b) => f(url, { method: "POST", headers, body: JSON.stringify(b), signal: o.signal });
    let resp = await send(body);
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 600);
      if (resp.status === 400 && /stream_options/.test(text)) {
        delete body.stream_options;
        resp = await send(body);
        if (!resp.ok) throw new ApiError("HTTP " + resp.status + ": " + (await resp.text()).slice(0, 600));
      } else throw new ApiError("HTTP " + resp.status + ": " + text);
    }
    const reader = resp.body.getReader(), dec = new TextDecoder();
    let buf = "", done = false;
    try {
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const chunk = line.slice(5).trim();
          if (chunk === "[DONE]") { done = true; break; }
          let obj; try { obj = JSON.parse(chunk); } catch (e) { continue; }
          applyChunk(obj, st, onDelta);
        }
      }
    } catch (e) {
      if (!(e && e.name === "AbortError")) throw e;  // «Стоп» — не ошибка
    } finally {
      try { const c = reader.cancel(); if (c && c.catch) c.catch(() => {}); } catch (e) { /* ignore */ }
    }
    return finishState(st);
  }

  // ---------- веб-инструменты ----------
  const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
  const WEB_TOOLS = [
    fn("web_search", "Поиск в интернете: заголовки, ссылки и фрагменты.", { query: { type: "string" }, max_results: { type: "integer", description: "От 1 до 10, по умолчанию 5." } }, ["query"]),
    fn("fetch_url", "Загрузить веб-страницу по URL и вернуть её текст.", { url: { type: "string" } }, ["url"]),
  ];

  function parseDDG(page, n) {
    const res = [];
    const re = /<a\s+([^>]*class="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(page)) && res.length < (n || 5)) {
      const h = m[1].match(/href="([^"]+)"/);
      if (!h) continue;
      let url = decodeEntities(h[1]);
      if (url.includes("uddg=")) {
        try { url = new URL(url.startsWith("//") ? "https:" + url : url).searchParams.get("uddg") || url; } catch (e) { /* keep */ }
      } else if (url.startsWith("//")) url = "https:" + url;
      const tail = page.slice(re.lastIndex, re.lastIndex + 4000);
      const sn = tail.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      res.push([stripTags(m[2]), url, sn ? stripTags(sn[1]) : ""]);
    }
    return res;
  }

  function htmlToText(text) {
    text = text.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    return decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  }

  function checkPublicUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error("Некорректный URL."); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Нужен http(s)-адрес.");
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    const bad = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
      h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) ||
      (v4 && (+v4[1] === 10 || +v4[1] === 127 || +v4[1] === 0 || (+v4[1] === 169 && +v4[2] === 254) ||
        (+v4[1] === 172 && +v4[2] >= 16 && +v4[2] <= 31) || (+v4[1] === 192 && +v4[2] === 168)));
    if (bad) throw new Error("Адреса локальной сети и localhost для этого инструмента недоступны.");
  }

  async function httpText(ctx, o) {
    if (ctx.native) {
      const r = await ctx.native({ url: o.url, method: o.method || "GET", headers: o.headers || {}, data: o.body, responseType: "text" });
      if (r.status >= 400) throw new Error("HTTP " + r.status);
      const h = r.headers || {};
      return { text: typeof r.data === "string" ? r.data : JSON.stringify(r.data), contentType: h["Content-Type"] || h["content-type"] || "" };
    }
    try {
      const r = await (ctx.fetchImpl || fetch)(o.url, { method: o.method || "GET", headers: o.headers, body: o.body, redirect: "follow" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return { text: await r.text(), contentType: r.headers.get("content-type") || "" };
    } catch (e) {
      if (e instanceof TypeError) throw new Error("Запрос заблокирован браузером (CORS). Веб-поиск работает в установленном приложении (APK/IPA).");
      throw e;
    }
  }

  async function webSearch(args, ctx) {
    const q = String(args.query || "").trim();
    if (!q) throw new Error("Пустой запрос.");
    const n = Math.max(1, Math.min(parseInt(args.max_results || 5, 10) || 5, 10));
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (ctx.native) headers["User-Agent"] = "Mozilla/5.0 (compatible; openboard/2.0)";
    const { text } = await httpText(ctx, { method: "POST", url: ctx.searchUrl || "https://html.duckduckgo.com/html/", headers, body: "q=" + encodeURIComponent(q) });
    const items = parseDDG(text, n);
    if (!items.length) throw new Error("Ничего не найдено (или поисковик временно ограничил запросы).");
    return items.map((x, i) => (i + 1) + ". " + x[0] + "\n" + x[1] + "\n" + x[2]).join("\n\n");
  }

  async function fetchUrl(args, ctx) {
    const url = String(args.url || "").trim();
    checkPublicUrl(url);
    const { text, contentType } = await httpText(ctx, { url });
    const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text.slice(0, 40));
    return truncate(isHtml ? htmlToText(text.slice(0, 1500000)) : text, 15000);
  }

  async function runTool(name, args, ctx) {
    if (name === "web_search") return webSearch(args, ctx);
    if (name === "fetch_url") return fetchUrl(args, ctx);
    throw new Error("Неизвестный инструмент: " + name);
  }

  // ---------- навыки и вложения ----------
  function skillsPrompt(skills, active) {
    const parts = (skills || []).filter((s) => (active || []).includes(s.id)).map((s) => "## Навык: " + s.name + "\n" + String(s.text).slice(0, 8000));
    return parts.length ? "Активные навыки (следуй им):\n\n" + parts.join("\n\n") : "";
  }
  const fileBlock = (name, text) => "--- Файл: " + name + " ---\n" + text + "\n--- конец файла ---";

  function classifyFile(name, mime, size) {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(mime || "")) {
      if (size > MAX_IMAGE_ATTACH) throw new Error("изображение больше 5 МБ");
      return "image";
    }
    if (size > MAX_TEXT_ATTACH) throw new Error("файл больше 300 КБ");
    return "text";
  }
  function userMessageContent(msg, atts) {
    const texts = [msg], imgs = [];
    for (const a of atts || []) (a.kind === "text" ? texts.push(fileBlock(a.name, a.text)) : imgs.push(a));
    const text = texts.join("\n\n");
    if (!imgs.length) return text;
    return [{ type: "text", text }].concat(imgs.map((a) => ({ type: "image_url", image_url: { url: a.data_url } })));
  }
  function expandUserText(content, atts) {
    const parts = [content];
    for (const a of atts || []) parts.push(a.kind === "text" ? fileBlock(a.name, a.text || "") : "[изображение: " + a.name + "]");
    return parts.join("\n\n");
  }

  // ---------- цикл: ответ -> инструменты -> ответ ----------
  /** o: {baseUrl,key,model,messages,webOn,signal,fetchImpl,native,callbacks...} */
  async function runChat(o) {
    const tools = o.webOn ? WEB_TOOLS : null;
    const ctx = { fetchImpl: o.fetchImpl, native: o.toolNative !== undefined ? o.toolNative : o.native, searchUrl: o.searchUrl };
    const messages = o.messages;
    const aborted = () => o.signal && o.signal.aborted;
    for (let step = 0; step < (o.maxSteps || MAX_STEPS); step++) {
      if (aborted()) return;
      const pchars = messages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length), 0);
      const parts = [];
      o.onStepStart && o.onStepStart();
      const { usage, toolCalls } = await streamChat({
        baseUrl: o.baseUrl, key: o.key, model: o.model, messages, tools, signal: o.signal, fetchImpl: o.fetchImpl,
        native: o.native, onDelta: (t) => { parts.push(t); o.onDelta && o.onDelta(t); },
      });
      const text = parts.join("");
      o.onStepEnd && (await o.onStepEnd(usage, text, pchars));
      if (!toolCalls.length || aborted()) return;
      messages.push({ role: "assistant", content: text, tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })) });
      for (const c of toolCalls) {
        if (aborted()) return;
        let args = null;
        try { const a = JSON.parse(c.arguments || "{}"); if (a && typeof a === "object" && !Array.isArray(a)) args = a; } catch (e) { /* bad */ }
        o.onToolStart && o.onToolStart(c, args || {});
        let status = "ok", out;
        if (args === null) { status = "error"; out = "Некорректные аргументы (нужен JSON-объект)."; }
        else if (!tools || !tools.some((t) => t.function.name === c.name)) { status = "error"; out = "Инструмент «" + c.name + "» сейчас отключён."; }
        else { try { out = await runTool(c.name, args, ctx); } catch (e) { status = "error"; out = e.message || String(e); } }
        o.onToolEnd && o.onToolEnd(c, status, out);
        messages.push({ role: "tool", tool_call_id: c.id, content: truncate(out, 20000) });
      }
    }
    o.onNotice && o.onNotice("Достигнут лимит в " + (o.maxSteps || MAX_STEPS) + " шагов.");
  }

  return {
    PRESETS, ACCENTS, DEFAULT_SKILLS, DEFAULT_CONFIG, WEB_TOOLS, WEB_PROMPT, MAX_TEXT_ATTACH, MAX_IMAGE_ATTACH, ApiError,
    truncate, escapeHtml, decodeEntities, renderMarkdown, computeCost, monthSpend, usageByModel, headersFor,
    listModels, streamChat, parseDDG, htmlToText, checkPublicUrl, runTool, skillsPrompt, classifyFile,
    userMessageContent, expandUserText, runChat,
  };
});
