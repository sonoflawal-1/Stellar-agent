// dashboard/public/virtualList.test.js
// Unit tests for the VirtualList renderer (#762).
//
// The dashboard bundle (app.js) is a browser IIFE that touches `document` and
// `window` at import time, and the repo's npm workspaces are currently
// unresolvable from a clean checkout. To keep these tests runnable in
// isolation, we load app.js with a minimal DOM shim and pull the exposed
// `window.__VirtualList` factory off of it.
//
// Run with: node dashboard/public/virtualList.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ── Minimal DOM shim ──
// Only implements the surface app.js touches at import + what VirtualList uses.
function createElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: "",
    style: {},
    children: [],
    parentNode: null,
    innerHTML: "",
    __listeners: {},
    id: "",
    clientHeight: 0,
    scrollTop: 0,
    offsetHeight: 0,
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
      toggle(c) {
        if (this._set.has(c)) this._set.delete(c);
        else this._set.add(c);
      },
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) {
      (el.__listeners[type] = el.__listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = el.__listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    setAttribute(k, v) {
      el[k] = v;
    },
    getAttribute(k) {
      return el[k];
    },
    querySelectorAll() {
      return [];
    },
    setSelectionRange() {},
    focus() {},
    querySelector() {
      return null;
    },
    closest() {
      return null;
    },
    matches() {
      return false;
    },
  };
  return el;
}

function makeDocument() {
  const body = createElement("body");
  const head = createElement("head");
  const registry = { page: createElement("div") };
  body.appendChild(registry.page);
  return {
    body,
    head,
    documentElement: createElement("html"),
    __registry: registry,
    getElementById(id) {
      if (!registry[id]) {
        // Real HTML has these nodes; auto-create so app.js can resolve them.
        registry[id] = createElement("div");
        registry[id].id = id;
      }
      return registry[id];
    },
    createElement,
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame(cb) {
      return setTimeout(cb, 0);
    },
    cancelAnimationFrame(id) {
      clearTimeout(id);
    },
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    RegExp,
    Set,
    Map,
    parseFloat,
    parseInt,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    URLSearchParams,
    URL,
    AbortController,
    Intl,
    Promise,
    Symbol,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = makeDocument();
  sandbox.localStorage = {
    getItem() {
      return null;
    },
    setItem() {},
    removeItem() {},
  };
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sandbox.location = { hash: "#/dashboard", href: "" };
  sandbox.navigator = { userAgent: "node-test" };
  sandbox.Notification = undefined;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

  vm.createContext(sandbox);
  try {
    vm.runInContext(src, sandbox, { filename: "app.js" });
  } catch (e) {
    throw new Error("app.js failed to evaluate in shim: " + e.message);
  }
  return sandbox;
}

// ── Harness ──
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    failed++;
    console.error("FAIL  " + name + "\n     " + e.message);
  }
}

const sandbox = loadApp();
const VirtualList = sandbox.window.__VirtualList;
assert.strictEqual(typeof VirtualList, "function", "window.__VirtualList must be exposed");

function makeItems(n) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: i });
  return items;
}

function makeContainer(viewHeight) {
  const c = createElement("div");
  c.clientHeight = viewHeight;
  c.scrollTop = 0;
  return c;
}

console.log("VirtualList (#762)");

test("renders only a bounded window of a 10,000-item list", () => {
  const items = makeItems(10000);
  const container = makeContainer(600);
  const vl = VirtualList({
    container,
    getItems: () => items,
    renderRow: (it) => '<div class="row">' + it.id + "</div>",
    estimatedRowHeight: 64,
  });
  vl.update();
  const s = vl.stats();
  assert.strictEqual(s.total, 10000);
  // 600px viewport / 64px rows ~= 10 rows + 5 buffer above + 5 below + 1 = <= 21
  assert.ok(s.rendered > 0, "should render at least one row");
  assert.ok(s.rendered <= 30, "window must stay small; got " + s.rendered);
  assert.ok(s.pooledNodes <= 30, "pool must stay small; got " + s.pooledNodes);
  vl.dispose();
});

test("total scroll height reflects the full list, not the window", () => {
  const items = makeItems(10000);
  const container = makeContainer(600);
  const vl = VirtualList({
    container,
    getItems: () => items,
    renderRow: (it) => "<div>" + it.id + "</div>",
    estimatedRowHeight: 64,
  });
  vl.update();
  // 10000 rows * 64px estimate
  assert.strictEqual(vl.stats().totalHeight, 10000 * 64);
  vl.dispose();
});

test("live DOM node count stays below 100 regardless of list size", () => {
  [50, 500, 5000, 10000, 50000].forEach((n) => {
    const items = makeItems(n);
    const container = makeContainer(800);
    const vl = VirtualList({
      container,
      getItems: () => items,
      renderRow: (it) => "<div>" + it.id + "</div>",
      estimatedRowHeight: 48,
    });
    vl.update();
    const live = vl.stats().liveNodes;
    assert.ok(live < 100, "n=" + n + " produced " + live + " live nodes");
    vl.dispose();
  });
});

test("scrolling moves the window and reuses the same pooled nodes", () => {
  const items = makeItems(10000);
  const container = makeContainer(600);
  const vl = VirtualList({
    container,
    getItems: () => items,
    renderRow: (it) => "<div>" + it.id + "</div>",
    estimatedRowHeight: 64,
  });
  vl.update();
  const startBefore = vl.stats().windowStart;

  container.scrollTop = 64000; // deep into the list
  vl.render();

  const s = vl.stats();
  assert.ok(s.windowStart > startBefore, "window should advance on scroll");
  // The pool grows to the largest window seen and then recycles; it must stay
  // a small bounded constant, not scale with the 10,000-item list.
  assert.ok(s.pooledNodes < 100, "pool must stay bounded; got " + s.pooledNodes);
  assert.ok(s.liveNodes < 100, "live nodes stay bounded after scroll");

  // A second, different deep offset should reuse the pool, not grow it.
  container.scrollTop = 128000;
  vl.render();
  const s2 = vl.stats();
  assert.ok(
    s2.pooledNodes <= s.pooledNodes + 5,
    "pool should stabilize across scrolls; " + s.pooledNodes + " -> " + s2.pooledNodes,
  );
  vl.dispose();
});

test("search/sort changes to the backing array are reflected on update", () => {
  let items = makeItems(10000);
  const container = makeContainer(600);
  const vl = VirtualList({
    container,
    getItems: () => items,
    renderRow: (it) => "<div>" + it.id + "</div>",
    estimatedRowHeight: 64,
  });
  vl.update();
  assert.strictEqual(vl.stats().total, 10000);

  // Simulate a search that narrows the list to 3 matches.
  items = [{ id: 7 }, { id: 8 }, { id: 9 }];
  vl.update();
  assert.strictEqual(vl.stats().total, 3);
  assert.ok(vl.stats().liveNodes <= 3, "should render only the matches");
  vl.dispose();
});

test("dispose removes the spacer and detaches the scroll listener", () => {
  const items = makeItems(1000);
  const container = makeContainer(600);
  const vl = VirtualList({
    container,
    getItems: () => items,
    renderRow: (it) => "<div>" + it.id + "</div>",
    estimatedRowHeight: 64,
  });
  vl.update();
  assert.ok(container.children.length >= 1, "spacer should be mounted");
  const before = (container.__listeners.scroll || []).length;
  assert.ok(before >= 1, "scroll listener should be attached");
  vl.dispose();
  assert.strictEqual(container.children.length, 0, "spacer should be removed");
  assert.strictEqual((container.__listeners.scroll || []).length, 0, "listener removed");
  assert.ok(!container.classList.contains("virtual-list"), "class removed on dispose");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
