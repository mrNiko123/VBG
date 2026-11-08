const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const OB = require("../www/core.js");

function sseServer(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const payload = body ? JSON.parse(body) : null;
        calls.push({ url: req.url, payload, headers: req.headers });
        handler(req, res, payload, calls.length);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, calls, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}
const sse = (res, objs, delay = 0) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  objs.forEach((o) => res.write("data: " + JSON.stringify(o) + "\n\n"));
  res.end("data: [DONE]\n\n");
};

test("markdown: экранирует HTML и не делает javascript:-ссылок", () => {
  const h = OB.renderMarkdown('<script>alert(1)</script> **жирный** `a<b` [ok](https://x.dev/a?b=1&c=2) [bad](javascript:alert(1))');
  assert.ok(!h.includes("<script>"));
  assert.ok(h.includes("&lt;script&gt;"));
  assert.ok(h.includes("<strong>жирный</strong>") && h.includes("<code>a&lt;b</code>"));
  assert.ok(h.includes('href="https://x.dev/a?b=1&amp;c=2"'));
  assert.ok(!/href="javascript/i.test(h));
});

test("markdown: блоки кода, списки, заголовки, незакрытый блок", () => {
  const h = OB.renderMarkdown("# Заг\n- один\n- два\n1. a\n```python\nprint('<x>')\n```\nконец\n```js\nпоток");
  assert.ok(h.includes("<h3>Заг</h3>") && h.includes("<ul><li>один</li><li>два</li></ul>") && h.includes("<ol><li>a</li></ol>"));
  assert.ok(h.includes("PYTHON") && h.includes("print(&#39;&lt;x&gt;&#39;)"));
  assert.ok(h.includes("JS") && h.includes("поток"));
});

test("стоимость и расход", () => {
  assert.deepEqual(OB.computeCost({ prompt_tokens: 10, completion_tokens: 5 }, 1, 2, 0), { cost: 2e-5, pt: 10, ct: 5 });
  assert.equal(OB.computeCost({ cost: 0.01, prompt_tokens: 1, completion_tokens: 2 }, 1, 2).cost, 0.01);
  const est = OB.computeCost({ _chars: 400 }, 1, 2, 800); assert.deepEqual([est.pt, est.ct], [200, 100]);
  const now = new Date(2026, 10, 15).getTime();
  const usage = [{ ts: new Date(2026, 10, 2).getTime(), model: "a", cost: 1, pt: 1, ct: 1 }, { ts: new Date(2026, 9, 28).getTime(), model: "a", cost: 5 }, { ts: now, model: "b", cost: 3 }];
  assert.equal(OB.monthSpend(usage, now), 4);
  assert.deepEqual(OB.usageByModel(usage).map((r) => [r.model, r.cost]), [["a", 6], ["b", 3]]);
});

test("listModels: цены и поддержка tools", async () => {
  const { srv, calls, base } = await sseServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "z/m", pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools", "x"] }, { id: "a/m" }] }));
  });
  const m = await OB.listModels({ baseUrl: base, key: "k" });
  srv.close();
  assert.deepEqual(m, [{ id: "a/m", in: null, out: null, tools: null }, { id: "z/m", in: 1, out: 2, tools: true }]);
  assert.equal(calls[0].headers.authorization, "Bearer k");
});

test("streamChat: поток, части tool_calls, usage", async () => {
  const { srv, calls, base } = await sseServer((req, res) => sse(res, [
    { choices: [{ delta: { content: "При" } }] }, { choices: [{ delta: { content: "вет" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"кот"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }]));
  const got = [];
  const r = await OB.streamChat({ baseUrl: base, key: "k", model: "m", messages: [{ role: "user", content: "x" }], tools: OB.WEB_TOOLS, onDelta: (t) => got.push(t) });
  srv.close();
  assert.equal(got.join(""), "Привет");
  assert.deepEqual(r.toolCalls, [{ id: "c1", name: "web_search", arguments: '{"query":"кот"}' }]);
  assert.equal(r.usage.prompt_tokens, 7);
  assert.ok(calls[0].payload.stream && calls[0].payload.stream_options.include_usage && calls[0].payload.tools.length === 2);
});

test("streamChat: повтор без stream_options при 400, ошибка HTTP, «Стоп»", async () => {
  let n = 0;
  let s = await sseServer((req, res, p) => {
    n++;
    if (p.stream_options) { res.writeHead(400); return res.end("unknown field stream_options"); }
    sse(res, [{ choices: [{ delta: { content: "ok" } }] }]);
  });
  const r = await OB.streamChat({ baseUrl: s.base, model: "m", messages: [] });
  s.srv.close(); assert.equal(n, 2); assert.equal(r.usage._chars, 2);

  s = await sseServer((req, res) => { res.writeHead(401); res.end('{"error":"bad key"}'); });
  await assert.rejects(OB.streamChat({ baseUrl: s.base, model: "m", messages: [] }), /HTTP 401.*bad key/);
  s.srv.close();

  s = await sseServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"часть"}}]}\n\n');   // и «зависает»
    setTimeout(() => res.end(), 2000);
  });
  const ac = new AbortController(), got = [];
  const p = OB.streamChat({ baseUrl: s.base, model: "m", messages: [], signal: ac.signal, onDelta: (t) => { got.push(t); ac.abort(); } });
  const res = await p; s.srv.closeAllConnections(); s.srv.close();
  assert.deepEqual(got, ["часть"]); assert.equal(res.usage._chars, 5);
});

test("streamChat: нативный режим (без стриминга)", async () => {
  let seen;
  const native = async (o) => { seen = o; return { status: 200, data: { choices: [{ message: { content: "Привет", tool_calls: [{ id: "t1", function: { name: "fetch_url", arguments: "{}" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 1 } } }; };
  const got = [];
  const r = await OB.streamChat({ baseUrl: "https://x.test/v1", key: "k", model: "m", messages: [], native, onDelta: (t) => got.push(t) });
  assert.equal(seen.data.stream, false); assert.equal(seen.url, "https://x.test/v1/chat/completions");
  assert.deepEqual(got, ["Привет"]); assert.equal(r.toolCalls[0].name, "fetch_url");
  await assert.rejects(OB.streamChat({ baseUrl: "https://x.test/v1", model: "m", messages: [], native: async () => ({ status: 500, data: "boom" }) }), /HTTP 500/);
});

test("DuckDuckGo-парсер, html→текст, защита от локальных адресов", () => {
  const page = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=1">Пример &amp; <b>заг</b></a><a class="result__snippet" href="x">Фраг <b>мент</b></a><a class="result__a" href="https://d.example/p">Второй</a>';
  assert.deepEqual(OB.parseDDG(page), [["Пример & заг", "https://example.com/a?x=1", "Фраг мент"], ["Второй", "https://d.example/p", ""]]);
  assert.equal(OB.htmlToText("<style>a{}</style><h1>Заг</h1><p>Т &amp; т</p><script>x()</script>"), "Заг\nТ & т".replace("\n", "\n"));
  for (const u of ["http://localhost/", "http://127.0.0.1:8080", "http://10.1.2.3", "http://192.168.0.1", "http://172.20.0.1", "http://169.254.1.1", "http://[::1]/", "http://nas.local/", "ftp://example.com", "not a url"]) assert.throws(() => OB.checkPublicUrl(u), u);
  for (const u of ["https://example.com", "http://8.8.8.8/x", "http://172.32.0.1/"]) assert.doesNotThrow(() => OB.checkPublicUrl(u), u);
});

test("вложения и навыки", () => {
  assert.equal(OB.classifyFile("a.png", "image/png", 10), "image");
  assert.equal(OB.classifyFile("a.py", "", 10), "text");
  assert.throws(() => OB.classifyFile("a.png", "image/png", 6e6), /5 МБ/);
  assert.throws(() => OB.classifyFile("a.txt", "text/plain", 400000), /300 КБ/);
  const atts = [{ name: "a.py", kind: "text", text: "print(1)" }, { name: "i.png", kind: "image", data_url: "data:image/png;base64,AA" }];
  const c = OB.userMessageContent("смотри", atts);
  assert.equal(c[0].type, "text"); assert.ok(c[0].text.includes("--- Файл: a.py ---") && c[0].text.includes("print(1)"));
  assert.equal(c[1].image_url.url, "data:image/png;base64,AA");
  assert.equal(OB.userMessageContent("x", []), "x");
  assert.ok(OB.expandUserText("привет", atts).includes("[изображение: i.png]"));
  assert.equal(OB.skillsPrompt(OB.DEFAULT_SKILLS, []), "");
  assert.ok(OB.skillsPrompt(OB.DEFAULT_SKILLS, ["kratko"]).includes("Кратко и по делу"));
});

test("runChat: веб-поиск → ответ, шаги и разрешённые инструменты", async () => {
  const search = '<a class="result__a" href="https://example.org/cat">Кот</a><a class="result__snippet">Про котов</a>';
  const { srv, calls, base } = await sseServer((req, res, p, n) => {
    if (n === 1) return sse(res, [
      { choices: [{ delta: { content: "Ищу. " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "s1", function: { name: "web_search", arguments: '{"query":"кот"}' } }, { index: 1, id: "s2", function: { name: "run_command", arguments: "{}" } }] } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }]);
    sse(res, [{ choices: [{ delta: { content: "Нашёл: Кот" } }] }, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } }]);
  });
  const ev = [], messages = [{ role: "user", content: "кот?" }];
  const fetchImpl = (url, o) => url.startsWith("http://127.0.0.1") ? fetch(url, o) : Promise.resolve({ ok: true, text: async () => search, headers: { get: () => "text/html" } });
  await OB.runChat({
    baseUrl: base, key: "k", model: "m", messages, webOn: true, fetchImpl,
    onStepStart: () => ev.push("step"), onDelta: (t) => ev.push("d:" + t),
    onStepEnd: (u, text) => ev.push("end:" + u.prompt_tokens + ":" + text),
    onToolStart: (c) => ev.push("ts:" + c.name), onToolEnd: (c, st, out) => ev.push("te:" + c.name + ":" + st + ":" + out.slice(0, 60)),
  });
  srv.close();
  assert.deepEqual(ev.slice(0, 7), ["step", "d:Ищу. ", "end:10:Ищу. ", "ts:web_search", "te:web_search:ok:1. Кот\nhttps://example.org/cat\nПро котов", "ts:run_command", "te:run_command:error:Инструмент «run_command» сейчас отключён."]);
  assert.equal(ev[ev.length - 1], "end:40:Нашёл: Кот");
  const tm = calls[1].payload.messages.filter((m) => m.role === "tool");
  assert.deepEqual(tm.map((m) => m.tool_call_id), ["s1", "s2"]);
  assert.equal(calls[1].payload.messages.at(-3).tool_calls[0].function.name, "web_search");
  assert.ok(calls[0].payload.tools.length === 2);
});

test("runChat: без веб-поиска инструменты не отправляются", async () => {
  const { srv, calls, base } = await sseServer((req, res) => sse(res, [{ choices: [{ delta: { content: "ok" } }] }]));
  await OB.runChat({ baseUrl: base, model: "m", messages: [{ role: "user", content: "x" }], webOn: false });
  srv.close(); assert.equal(calls[0].payload.tools, undefined);
});
