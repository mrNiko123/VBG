// Дымовой тест интерфейса: app.js запускается против простой модели DOM, а API — настоящий локальный сервер.
// Это не замена проверки на телефоне, но ловит ошибки логики (ReferenceError, TypeError, неверный порядок вызовов).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ""; this.nodeType = 1;
    this.dataset = {}; this.style = { setProperty() {} }; this._text = ""; this.innerHTML = ""; this.value = ""; this.disabled = false;
    this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this.type = "text";
    const self = this;
    this.classList = { add(c) { self.className = (self.className + " " + c).trim(); }, remove(c) { self.className = self.className.split(" ").filter((x) => x !== c).join(" "); },
      toggle(c, on) { on ? this.add(c) : this.remove(c); }, contains(c) { return self.className.split(" ").includes(c); } };
  }
  append(...kids) { for (const k of kids) { this.children.push(k); if (this.tag === "textarea" && k && k.nodeType === 3) this.value = k.data; } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "value") this.value = v; if (k === "type") this.type = v; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || c.data || "").join(""); }
  querySelector() { return new El("q"); }
  closest() { return new El("c"); }
  remove() { this.removed = true; } focus() {} select() {} click() {}
  fire(ev, extra) { for (const f of this.listeners[ev] || []) f(Object.assign({ target: this, preventDefault() {}, key: "" }, extra)); }
  walk(fn) { fn(this); for (const c of this.children) if (c.walk) c.walk(fn); }
}

function setup(cfg, store0 = {}) {
  const els = {}, store = Object.assign({}, store0);
  store["ob.config"] = JSON.stringify(cfg);
  global.document = {
    querySelector: (s) => els[s] || (els[s] = new El(s)),
    createElement: (t) => new El(t), createTextNode: (d) => ({ nodeType: 3, data: String(d), textContent: String(d) }),
    documentElement: new El("html"), body: new El("body"), execCommand() {},
  };
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  global.window = global; global.matchMedia = () => ({ matches: false });
  global.requestAnimationFrame = (f) => setTimeout(f, 0); global.cancelAnimationFrame = clearTimeout;
  global.navigator = {}; global.location = { protocol: "file:" };
  global.OB = require("../www/core.js");
  const src = fs.readFileSync(path.join(__dirname, "../www/app.js"), "utf8");
  new Function(src)();
  return { els, store };
}
const wait = async (cond, ms = 4000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 15)); } };

test("запуск, шторки и их кнопки не падают", async () => {
  const { els } = setup({ api_key: "k", model: "m", base_url: "http://127.0.0.1:1/v1", provider: "Свой base_url" });
  for (const id of ["#settingsBtn", "#usageBtn", "#plusBtn", "#modelChip", "#menuBtn", "#newChat"]) els[id].fire("click");
  // пройти по всем кликабельным элементам открытой шторки (плюс-меню → разделы → назад …)
  els["#plusBtn"].fire("click");
  for (let round = 0; round < 6; round++) {
    const clickable = [];
    els["#sheetBody"].walk((e) => { if (e.listeners.click) clickable.push(e); });
    for (const e of clickable) { try { e.fire("click"); } catch (err) { assert.fail("клик упал: " + err.stack); } }
  }
  assert.ok(true);
});

test("полный цикл: отправка → веб-поиск → ответ → сохранение и расход", async () => {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = JSON.parse(body); calls.push(p);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const w = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
      if (calls.length === 1) {
        w({ choices: [{ delta: { content: "Ищу." } }] });
        w({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "web_search", arguments: '{"query":"кот"}' } }] } }] });
        w({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } });
      } else { w({ choices: [{ delta: { content: "Нашёл **кота**" } }] }); w({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } }); }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port + "/v1";
  const realFetch = global.fetch;
  global.fetch = (url, o) => String(url).includes("duckduckgo")
    ? Promise.resolve({ ok: true, text: async () => '<a class="result__a" href="https://example.org/cat">Кот</a><a class="result__snippet">Про котов</a>', headers: { get: () => "text/html" } })
    : realFetch(url, o);
  try {
    const { els, store } = setup({ api_key: "k", model: "m/x", base_url: base, provider: "Свой base_url", web_search: true, monthly_budget: 5, price_in_1m: 1, price_out_1m: 2 });
    els["#input"].value = "привет, кот?"; els["#input"].fire("input");
    assert.equal(els["#send"].disabled, false);
    els["#send"].fire("click");
    try {
      await wait(() => /Нашёл/.test(JSON.parse(store["ob.chats"]).flatMap((c) => c.messages).map((m) => m.content || "").join("|")) && els["#send"].innerHTML.includes('width="20"'));
    } catch (e) {
      let shown = ""; els["#messages"].walk((n) => { if (n.textContent && !n.children.length) shown += "[" + n.textContent.slice(0, 120) + "]"; });
      throw new Error("TIMEOUT chats=" + store["ob.chats"] + " calls=" + calls.length + " send=" + els["#send"].innerHTML.slice(0, 40) + " ui=" + shown);
    }
    const chat = JSON.parse(store["ob.chats"])[0];
    assert.equal(chat.title, "привет, кот?");
    assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(chat.messages[2].status, "ok"); assert.ok(chat.messages[2].output.includes("example.org/cat"));
    assert.ok(chat.messages[3].content.includes("кота") && /30 → 4/.test(chat.messages[3].meta));
    const u = JSON.parse(store["ob.usage"]); assert.equal(u.length, 2); assert.ok(u[1].cost > 0);
    assert.ok(calls[0].tools && calls[0].messages[0].role === "system" && /веб-поиск/.test(calls[0].messages[0].content));
    assert.equal(els["#input"].value, "");
    els["#usageBtn"].fire("click"); els["#settingsBtn"].fire("click");
  } finally { global.fetch = realFetch; srv.close(); }
});

test("ошибка API показывается, чат не ломается", async () => {
  const srv = http.createServer((req, res) => { res.writeHead(401); res.end('{"error":"bad key"}'); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port + "/v1";
  const { els, store } = setup({ api_key: "k", model: "m", base_url: base, provider: "Свой base_url" });
  els["#input"].value = "x"; els["#input"].fire("input"); els["#send"].fire("click");
  await wait(() => els["#send"].innerHTML.includes('width="20"') && els["#messages"].children.length >= 2);
  let found = false; els["#messages"].walk((e) => { if (/HTTP 401/.test(e.textContent || "")) found = true; });
  srv.close(); assert.ok(found);
  assert.deepEqual(JSON.parse(store["ob.chats"])[0].messages.map((m) => m.role), ["user"]);
});

test("без ключа и модели отправка не уходит в сеть", async () => {
  const { els, store } = setup({});
  els["#input"].value = "x"; els["#input"].fire("input"); els["#send"].fire("click");
  assert.equal(JSON.parse(store["ob.chats"])[0].messages.length, 0);
});
