/* openboard mobile: интерфейс. Логика API/markdown/инструментов — в core.js (window.OB). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  }

  // ---------- состояние и хранилище ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast("Не удалось сохранить: хранилище заполнено"); } },
  };
  let cfg = Object.assign({}, OB.DEFAULT_CONFIG, store.get("ob.config", {}));
  let chats = store.get("ob.chats", []);
  let usage = store.get("ob.usage", []);
  let curId = store.get("ob.cur", null);
  let atts = [];
  let busy = false, controller = null, curA = null, curNode = null, raf = 0;

  const saveCfg = () => store.set("ob.config", cfg);
  const saveChats = () => store.set("ob.chats", chats);
  const saveUsage = () => store.set("ob.usage", usage.slice(-5000));

  const cap = window.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  const nativeRequest = (o) => cap.Plugins.CapacitorHttp.request(o);
  const chatNative = () => (isNative && cfg.native_http ? nativeRequest : undefined);
  const toolNative = () => (isNative ? nativeRequest : undefined);

  const messagesEl = $("#messages"), input = $("#input"), sendBtn = $("#send");
  const cur = () => chats.find((c) => c.id === curId) || null;

  // ---------- мелочи ----------
  let toastTimer = 0;
  function toast(text) {
    const t = $("#toast");
    t.textContent = text; t.style.whiteSpace = "pre-line"; t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 3200);
  }
  function copyText(text) {
    const done = () => toast("Скопировано");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast("Не удалось скопировать"));
    else { const ta = h("textarea", {}, text); document.body.append(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) { toast("Не удалось скопировать"); } ta.remove(); }
  }
  function netError(e) {
    const m = (e && e.message) || String(e);
    if (e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(m))
      return "нет соединения или запрос заблокирован (CORS). Для провайдеров без CORS включите «Нативные запросы» в настройках (в приложении).";
    return m;
  }
  const money = (v) => "$" + v.toFixed(v < 1 ? 4 : 2);
  const short = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

  function applyTheme() {
    document.documentElement.dataset.theme = cfg.theme;
    const a = OB.ACCENTS[cfg.accent] || OB.ACCENTS.violet;
    document.documentElement.style.setProperty("--accent", a[0]);
    document.documentElement.style.setProperty("--accent-h", a[1]);
    $("#themeColor").setAttribute("content", cfg.theme === "light" ? "#FFFFFF" : "#0B0D12");
  }

  // ---------- шторки ----------
  function openSheet(title, build) {
    $("#sheetTitle").textContent = title;
    const body = $("#sheetBody");
    body.replaceChildren();
    build(body);
    $("#sheetScrim").classList.add("on");
  }
  function closeSheet() { $("#sheetScrim").classList.remove("on"); }
  $("#sheetScrim").addEventListener("click", (e) => { if (e.target.id === "sheetScrim") closeSheet(); });

  function confirmSheet(title, text, okLabel, onOk, danger) {
    openSheet(title, (b) => {
      b.append(h("p", { text, style: "color:var(--muted);margin:0 0 16px" }),
        h("div", { style: "display:flex;gap:10px" },
          h("button", { class: "btn ghost", style: "flex:1", text: "Отмена", onclick: closeSheet }),
          h("button", { class: "btn " + (danger ? "danger" : "primary"), style: "flex:1", text: okLabel, onclick: () => { closeSheet(); onOk(); } })));
    });
  }
  const row = (label, opts) => {
    opts = opts || {};
    const right = opts.toggle !== undefined ? h("span", { class: "sw" + (opts.toggle ? " on" : "") })
      : opts.chev ? h("span", { class: "r", text: "›" }) : opts.right ? h("span", { class: "r", text: opts.right }) : null;
    return h("button", { class: "srow", type: "button", onclick: opts.onClick }, h("span", { text: label }), right);
  };

  // ---------- чаты ----------
  function newChat() {
    const existing = cur();
    if (existing && !existing.messages.length) { renderAll(); return existing; }
    const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: "Новый чат", created: Date.now(), messages: [] };
    chats.unshift(c); curId = c.id; store.set("ob.cur", curId); saveChats();
    return c;
  }
  function openChat(id) {
    if (busy) return;
    curId = id; store.set("ob.cur", id); closeDrawer(); renderAll();
  }
  function deleteChat(id) {
    if (busy) return;
    confirmSheet("Удалить чат?", "Вся история этого чата будет удалена без возможности восстановления.", "Удалить", () => {
      chats = chats.filter((c) => c.id !== id);
      if (curId === id) { curId = chats[0] ? chats[0].id : null; }
      if (!curId) newChat(); else store.set("ob.cur", curId);
      saveChats(); renderAll();
    }, true);
  }

  // ---------- отрисовка ----------
  function renderAll() { renderDrawer(); renderTop(); renderMessages(); renderAtts(); renderHint(); updateSend(); }

  function renderDrawer() {
    const list = $("#chatList");
    list.replaceChildren(...chats.map((c) => h("div", { class: "crow" + (c.id === curId ? " sel" : "") },
      h("div", { class: "t", text: c.title, onclick: () => openChat(c.id) }),
      h("button", { class: "x", "aria-label": "Удалить", text: "✕", onclick: () => deleteChat(c.id) }))));
    const spent = OB.monthSpend(usage), b = Number(cfg.monthly_budget) || 0;
    const m = $("#meter");
    m.replaceChildren(h("div", { text: "Расход за месяц: " + money(spent) + (b ? " из $" + b.toFixed(0) : "") }));
    if (b) m.append(h("div", { class: "bar" }, h("i", { style: "width:" + Math.min(100, (spent / b) * 100) + "%" })));
  }
  function renderTop() {
    const c = cur();
    $("#title").textContent = c ? c.title : "openboard";
    const chip = $("#modelChip");
    chip.textContent = cfg.model ? short(cfg.model, 28) : "Выбрать модель";
    chip.classList.toggle("on", !!cfg.model);
  }
  function renderHint() {
    const parts = [];
    if (cfg.web_search) parts.push("Веб-поиск");
    const act = (cfg.skills || []).filter((s) => (cfg.active_skills || []).includes(s.id));
    if (act.length) parts.push("Навыки: " + act.map((s) => s.name).join(", "));
    $("#hint").textContent = parts.length ? parts.join("  ·  ") : "openboard может ошибаться. Проверяйте важную информацию.";
  }

  function welcome() {
    const chips = [["Объясни просто", "Объясни простыми словами, как работает "], ["Напиши код", "Напиши на Python функцию, которая "],
      ["Улучши текст", "Улучши и сократи этот текст:\n\n"], ["Придумай идеи", "Предложи 10 идей для "]];
    return h("div", { class: "welcome" }, h("img", { src: "icon-512.png", alt: "" }), h("h1", { text: "Чем займёмся?" }),
      h("p", { text: (cfg.model || "модель не выбрана") + "  ·  " + cfg.provider }),
      h("div", { class: "chips" }, chips.map(([l, p]) => h("button", { text: l, onclick: () => { input.value = p; autosize(); input.focus(); } }))));
  }

  const TOOL_TITLES = { web_search: "Веб-поиск", fetch_url: "Загрузка страницы" };
  const briefOf = (m) => short(String((m.args && (m.args.query || m.args.url)) || ""), 80);

  function userNode(m) {
    const b = h("div", { class: "bubble" }, m.content);
    (m.atts || []).forEach((a) => b.append(h("span", { class: "af", text: "▪ " + a.name })));
    return h("div", { class: "msg user" }, b);
  }
  function aiNode(m) {
    const body = h("div", { class: "body" }), foot = h("div", { class: "foot" });
    const node = h("div", { class: "msg ai" }, h("img", { src: "icon-192.png", alt: "" }), h("div", { style: "min-width:0;flex:1" }, body, foot));
    node._body = body; node._foot = foot; node._m = m;
    paintAi(node, false);
    return node;
  }
  function paintAi(node, streaming) {
    const m = node._m;
    node._body.innerHTML = OB.renderMarkdown(m.content || "") + (streaming ? '<span class="cursor"> ▍</span>' : "");
    node._foot.replaceChildren();
    if (!streaming && m.content) node._foot.append(h("span", { text: m.meta || "" }), h("button", { type: "button", text: "Копировать", onclick: () => copyText(m.content) }));
  }
  function toolNode(m) {
    const dot = h("span", { class: "dot " + (m.status === "running" ? "" : m.status) });
    const pre = h("pre", { text: m.output || "" });
    const d = h("details", { class: "tool" }, h("summary", {}, dot, h("b", { text: TOOL_TITLES[m.name] || m.name }), h("span", { class: "brief", text: briefOf(m) })), pre);
    d._dot = dot; d._pre = pre;
    return d;
  }
  function msgNode(m) {
    if (m.role === "user") return userNode(m);
    if (m.role === "tool") return toolNode(m);
    return aiNode(m);
  }
  function renderMessages() {
    const c = cur();
    messagesEl.replaceChildren();
    if (!c || !c.messages.length) { messagesEl.append(welcome()); return; }
    c.messages.forEach((m) => messagesEl.append(msgNode(m)));
    toBottom();
  }
  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
  const toBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };
  function appendNode(node) {
    const stick = nearBottom();
    messagesEl.append(node);
    if (stick) toBottom();
  }
  messagesEl.addEventListener("click", (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains("copy")) {
      const code = t.closest("pre").querySelector("code");
      copyText(code ? code.textContent : "");
      t.textContent = "Скопировано ✓"; setTimeout(() => (t.textContent = "Копировать"), 1400);
    }
  });

  // ---------- ввод и вложения ----------
  const SEND_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v6a2 2 0 0 1-2 2H6"/><path d="M10 9l-4 5 4 5"/></svg>';
  const STOP_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
  function updateSend() {
    sendBtn.innerHTML = busy ? STOP_SVG : SEND_SVG;
    sendBtn.disabled = !busy && !(input.value.trim() || atts.length);
  }
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; updateSend(); }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener("click", send);

  function renderAtts() {
    $("#attRow").replaceChildren(...atts.map((a, i) => h("div", { class: "att" }, (a.kind === "image" ? "▣ " : "▤ ") + short(a.name, 26),
      h("b", { text: "✕", onclick: () => { atts.splice(i, 1); renderAtts(); } }))));
    updateSend();
  }
  const readAs = (file, mode) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(new Error("не удалось прочитать файл"));
    mode === "dataURL" ? r.readAsDataURL(file) : r.readAsText(file);
  });
  $("#filePick").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    const skipped = [];
    for (const f of files) {
      if (atts.length >= 8) { skipped.push(f.name + ": максимум 8 вложений"); continue; }
      try {
        const kind = OB.classifyFile(f.name, f.type, f.size);
        if (kind === "image") atts.push({ name: f.name, kind, data_url: await readAs(f, "dataURL") });
        else {
          const text = await readAs(f, "text");
          if (text.slice(0, 4096).includes("\u0000")) throw new Error("бинарный файл (поддерживаются текст, код и изображения)");
          atts.push({ name: f.name, kind, text });
        }
      } catch (err) { skipped.push(f.name + ": " + err.message); }
    }
    renderAtts();
    if (skipped.length) toast("Не все файлы добавлены:\n" + skipped.join("\n"));
  });

  // ---------- отправка ----------
  const priceFor = (model) => {
    const m = (cfg.models || []).find((x) => x.id === model);
    return m && m.in != null && m.out != null ? [m.in, m.out] : [cfg.price_in_1m, cfg.price_out_1m];
  };

  async function send() {
    if (busy) { if (controller) controller.abort(); return; }
    const text = input.value.trim();
    if (!text && !atts.length) return;
    const local = /localhost|127\.0\.0\.1/.test(cfg.base_url);
    if (!cfg.model) { toast("Выберите модель."); return openSettings(); }
    if (!cfg.api_key && !local) { toast("Добавьте API-ключ в настройках."); return openSettings(); }
    const budget = Number(cfg.monthly_budget) || 0;
    if (budget && OB.monthSpend(usage) >= budget) return toast("Месячный бюджет $" + budget.toFixed(2) + " исчерпан.");

    const msgText = text || "Посмотри вложенные файлы.";
    let chat = cur() || newChat();
    if (!chat.messages.length) { chat.title = short(msgText.replace(/\n/g, " "), 48); }
    const sendAtts = atts.slice();
    const userMsg = { role: "user", content: msgText, atts: sendAtts.map((a) => ({ name: a.name, kind: a.kind, text: a.kind === "text" ? a.text : "" })) };
    const hist = chat.messages.filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.role === "user" ? OB.expandUserText(m.content, m.atts) : m.content }));
    if (!chat.messages.length) messagesEl.replaceChildren();
    chat.messages.push(userMsg);
    appendNode(userNode(userMsg));
    atts = []; input.value = ""; autosize(); renderAtts(); renderDrawer(); renderTop(); saveChats();

    let sys = cfg.system_prompt || "";
    const extra = [OB.skillsPrompt(cfg.skills, cfg.active_skills)];
    if (cfg.web_search) extra.push(OB.WEB_PROMPT.replace("{date}", new Date().toISOString().slice(0, 10)));
    const extraText = extra.filter(Boolean).join("\n\n");
    if (extraText) sys = (sys ? sys + "\n\n" : "") + extraText;
    const messages = [];
    if (sys) messages.push({ role: "system", content: sys });
    hist.concat([{ role: "user", content: OB.userMessageContent(msgText, sendAtts) }]).slice(-Number(cfg.history_limit || 40))
      .forEach((m) => messages.push(m));

    busy = true; controller = new AbortController(); curA = null; curNode = null; updateSend();
    const tools = {};
    const model = cfg.model;
    try {
      await OB.runChat({
        baseUrl: cfg.base_url, key: cfg.api_key, model, messages, webOn: !!cfg.web_search, signal: controller.signal,
        native: chatNative(), toolNative: toolNative(),
        onStepStart() {
          curA = { role: "assistant", content: "", meta: "" };
          chat.messages.push(curA);
          curNode = aiNode(curA); paintAi(curNode, true); appendNode(curNode);
        },
        onDelta(t) {
          curA.content += t;
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (curNode) { const s = nearBottom(); paintAi(curNode, true); if (s) toBottom(); } });
        },
        onStepEnd(u, full, pchars) {
          const [pi, po] = priceFor(model);
          const c = OB.computeCost(u, pi, po, pchars);
          usage.push({ ts: Date.now(), model, provider: cfg.provider, pt: c.pt, ct: c.ct, cost: c.cost }); saveUsage();
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          if (curA.content) { curA.meta = c.pt + " → " + c.ct + " токенов  ·  " + money(c.cost); paintAi(curNode, false); }
          else { chat.messages.splice(chat.messages.indexOf(curA), 1); curNode.remove(); }
          curA = null; curNode = null; saveChats(); renderDrawer();
        },
        onToolStart(call, args) {
          const m = { role: "tool", name: call.name, args, status: "running", output: "" };
          chat.messages.push(m); const n = toolNode(m); tools[call.id] = { m, n }; appendNode(n);
        },
        onToolEnd(call, status, out) {
          const t = tools[call.id]; if (!t) return;
          t.m.status = status; t.m.output = out.slice(0, 6000);
          t.n._dot.className = "dot " + status; t.n._pre.textContent = t.m.output; saveChats();
        },
        onNotice(text) { appendNode(h("div", { class: "note", text })); },
      });
    } catch (e) {
      const msg = netError(e);
      if (curNode && curA && !curA.content) { chat.messages.splice(chat.messages.indexOf(curA), 1); curNode.remove(); }
      appendNode(h("div", { class: "msg ai" }, h("img", { src: "icon-192.png", alt: "" }), h("div", { class: "body err", text: msg })));
    } finally {
      busy = false; controller = null; curA = null; curNode = null;
      saveChats(); renderDrawer(); updateSend();
    }
  }

  // ---------- меню «+» и его разделы ----------
  function openPlus() {
    openSheet("Добавить", (b) => {
      b.append(
        row("Загрузить или добавить файл…", { right: "", onClick: () => { closeSheet(); $("#filePick").click(); } }),
        row("Skills", { chev: true, onClick: openSkills }),
        row("Дизайн-система", { chev: true, onClick: openDesign }),
        row("Веб-поиск", { toggle: !!cfg.web_search, onClick: () => { cfg.web_search = !cfg.web_search; saveCfg(); renderHint(); openPlus(); } }));
      if (!isNative) b.append(h("div", { class: "status", text: "Веб-поиск работает в установленном приложении (APK/IPA): браузер блокирует такие запросы (CORS)." }));
    });
  }
  function openSkills() {
    openSheet("Skills", (b) => {
      (cfg.skills || []).forEach((s) => {
        const on = (cfg.active_skills || []).includes(s.id);
        b.append(row(s.name, { toggle: on, onClick: () => {
          cfg.active_skills = on ? cfg.active_skills.filter((x) => x !== s.id) : (cfg.active_skills || []).concat([s.id]);
          saveCfg(); renderHint(); openSkills();
        } }));
      });
      b.append(h("div", { style: "display:flex;gap:10px;margin-top:14px" },
        h("button", { class: "btn primary", style: "flex:1", text: "Создать навык", onclick: newSkill }),
        h("button", { class: "btn ghost", text: "Назад", onclick: openPlus })));
    });
  }
  function newSkill() {
    openSheet("Новый навык", (b) => {
      const name = h("input", { placeholder: "Название" });
      const text = h("textarea", { rows: 7, placeholder: "Инструкции для модели" });
      b.append(h("div", { class: "f" }, h("label", { text: "Название" }), name), h("div", { class: "f" }, h("label", { text: "Инструкции для модели" }), text),
        h("div", { style: "display:flex;gap:10px;margin-top:16px" },
          h("button", { class: "btn ghost", style: "flex:1", text: "Отмена", onclick: openSkills }),
          h("button", { class: "btn primary", style: "flex:1", text: "Создать", onclick: () => {
            if (!name.value.trim() || !text.value.trim()) return toast("Заполните название и инструкции.");
            const id = "u" + Date.now().toString(36);
            cfg.skills = (cfg.skills || []).concat([{ id, name: name.value.trim(), text: text.value.trim() }]);
            cfg.active_skills = (cfg.active_skills || []).concat([id]); saveCfg(); renderHint(); openSkills();
          } })));
    });
  }
  function openDesign() {
    openSheet("Дизайн-система", (b) => {
      b.append(h("div", { class: "seg" }, ["dark", "light"].map((k) => h("button", { class: cfg.theme === k ? "on" : "", text: k === "dark" ? "Тёмная" : "Светлая",
        onclick: () => { cfg.theme = k; saveCfg(); applyTheme(); openDesign(); } }))),
        h("div", { class: "dots" }, Object.entries(OB.ACCENTS).map(([k, v]) => h("button", { class: cfg.accent === k ? "on" : "", "aria-label": v[2],
          style: "background:" + v[0], onclick: () => { cfg.accent = k; saveCfg(); applyTheme(); openDesign(); } }))),
        h("div", { class: "status", text: "Применяется сразу." }),
        h("div", { style: "margin-top:14px" }, h("button", { class: "btn ghost", text: "Назад", onclick: openPlus })));
    });
  }

  // ---------- выбор модели, настройки, расход ----------
  function openModelPicker() {
    openSheet("Модель", (b) => {
      const models = cfg.models || [];
      if (!models.length) {
        b.append(h("p", { text: "Список моделей пуст. Вставьте ключ в настройках и нажмите «Загрузить модели».", style: "color:var(--muted)" }),
          h("button", { class: "btn primary block", text: "Открыть настройки", onclick: openSettings }));
        return;
      }
      const search = h("input", { placeholder: "Поиск по моделям", autocapitalize: "off", spellcheck: "false", style: "width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:11px 12px;outline:0;margin-bottom:6px" });
      const list = h("div");
      const draw = () => {
        const q = search.value.toLowerCase().trim();
        list.replaceChildren(...models.filter((m) => m.id.toLowerCase().includes(q)).slice(0, 150).map((m) =>
          h("button", { class: "mrow" + (m.id === cfg.model ? " sel" : ""), type: "button", onclick: () => { cfg.model = m.id; saveCfg(); renderTop(); renderHint(); if (!cur() || !cur().messages.length) renderMessages(); closeSheet(); } },
            m.id, m.tools === false ? h("small", { text: "  · без инструментов" }) : null)));
      };
      search.addEventListener("input", draw); b.append(search, list); draw();
    });
  }

  function openSettings() {
    openSheet("Настройки", (b) => {
      let models = (cfg.models || []).slice();
      const provider = h("select", {}, Object.keys(OB.PRESETS).map((k) => h("option", { value: k, text: k })));
      provider.value = cfg.provider;
      const base = h("input", { type: "url", value: cfg.base_url, autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
      const key = h("input", { type: "password", value: cfg.api_key, autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
      const showBtn = h("button", { class: "btn ghost", type: "button", text: "Показать", onclick: () => {
        const hide = key.type === "password"; key.type = hide ? "text" : "password"; showBtn.textContent = hide ? "Скрыть" : "Показать";
      } });
      const status = h("div", { class: "status", text: "Моделей в списке: " + models.length });
      const dl = h("datalist", { id: "modelList" });
      const model = h("input", { value: cfg.model, list: "modelList", autocapitalize: "off", spellcheck: "false", placeholder: "например, openai/gpt-4o-mini" });
      const fill = () => dl.replaceChildren(...models.slice(0, 500).map((m) => h("option", { value: m.id })));
      fill();
      provider.addEventListener("change", () => {
        const u = OB.PRESETS[provider.value];
        if (u) base.value = u;
        models = []; model.value = ""; fill(); status.className = "status"; status.textContent = "Провайдер изменён — загрузите список моделей";
      });
      const load = h("button", { class: "btn primary block", type: "button", text: "Загрузить модели по этому ключу", style: "margin-top:14px", onclick: async () => {
        status.className = "status"; status.textContent = "Загрузка…";
        try {
          models = await OB.listModels({ baseUrl: base.value.trim(), key: key.value.trim(), native: toolNative() });
          fill(); status.className = "status ok"; status.textContent = "Доступно моделей по ключу: " + models.length;
          if (!models.some((m) => m.id === model.value)) model.value = "";
        } catch (e) { status.className = "status bad"; status.textContent = "Ошибка: " + netError(e); }
      } });
      const pin = h("input", { type: "number", step: "any", inputmode: "decimal", value: cfg.price_in_1m }), pout = h("input", { type: "number", step: "any", inputmode: "decimal", value: cfg.price_out_1m });
      const budget = h("input", { type: "number", step: "any", inputmode: "decimal", value: cfg.monthly_budget });
      const sys = h("textarea", { rows: 4 }, cfg.system_prompt);
      let nat = !!cfg.native_http;
      const natRow = row("Нативные запросы", { toggle: nat, onClick: () => { nat = !nat; natRow.querySelector(".sw").classList.toggle("on", nat); } });
      const F = (label, el, hint) => h("div", { class: "f" }, h("label", { text: label }), el, hint ? h("div", { class: "hint", text: hint }) : null);
      b.append(
        F("Провайдер", provider), F("Base URL", base), F("API-ключ", h("div", { class: "two" }, key, showBtn)), load, status,
        F("Модель (из списка по ключу)", model), dl,
        F("Цена, $ за 1M токенов: вход / выход", h("div", { class: "two" }, pin, pout), "Нужна, только если провайдер не отдаёт цены сам (у OpenRouter берутся автоматически)."),
        F("Месячный бюджет, $ (0 — без лимита)", budget), F("Системный промпт", sys),
        h("div", { class: "f" }, natRow, h("div", { class: "hint", text: "Для провайдеров без CORS (например NVIDIA). Ответ приходит целиком, без потоковой печати. Работает только в APK/IPA." })),
        h("div", { style: "display:flex;gap:10px;margin-top:18px" },
          h("button", { class: "btn ghost", style: "flex:1", text: "Отмена", onclick: closeSheet }),
          h("button", { class: "btn primary", style: "flex:1", text: "Сохранить", onclick: () => {
            const nums = [pin.value, pout.value, budget.value].map((v) => parseFloat(String(v).replace(",", ".")) || 0);
            Object.assign(cfg, { provider: provider.value, base_url: base.value.trim(), api_key: key.value.trim(), models, model: model.value.trim(),
              price_in_1m: nums[0], price_out_1m: nums[1], monthly_budget: nums[2], system_prompt: sys.value.trim(), native_http: nat });
            saveCfg(); closeSheet(); renderAll();
          } })));
    });
  }

  function openUsage() {
    openSheet("Расход", (b) => {
      const rows = OB.usageByModel(usage), total = rows.reduce((s, r) => s + r.cost, 0);
      b.append(h("p", { style: "color:var(--muted);margin:0 0 10px", text: "Всего: " + money(total) + "  ·  в этом месяце: " + money(OB.monthSpend(usage)) }));
      if (!rows.length) { b.append(h("p", { text: "Запросов пока не было.", style: "color:var(--muted)" })); return; }
      b.append(h("table", { class: "utable" }, h("tr", {}, ["Модель", "Запр.", "Вход", "Выход", "$"].map((t) => h("th", { text: t }))),
        rows.map((r) => h("tr", {}, [r.model, r.calls, r.pt, r.ct, r.cost.toFixed(4)].map((v) => h("td", { text: String(v) }))))));
    });
  }

  // ---------- панель ----------
  function openDrawer() { $("#drawer").classList.add("open"); $("#scrim").classList.add("on"); }
  function closeDrawer() { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("on"); }
  $("#menuBtn").addEventListener("click", openDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  $("#newChat").addEventListener("click", () => { if (busy) return; newChat(); closeDrawer(); renderAll(); });
  $("#settingsBtn").addEventListener("click", () => { closeDrawer(); openSettings(); });
  $("#usageBtn").addEventListener("click", () => { closeDrawer(); openUsage(); });
  $("#modelChip").addEventListener("click", openModelPicker);
  $("#plusBtn").addEventListener("click", openPlus);

  // ---------- запуск ----------
  chats = chats.filter((c) => c.messages.length || c.id === curId);
  if (!cur()) { curId = null; newChat(); }
  applyTheme(); renderAll();
  if (!cfg.api_key && !/localhost|127\.0\.0\.1/.test(cfg.base_url)) setTimeout(openSettings, 450);
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol) && !isNative) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
