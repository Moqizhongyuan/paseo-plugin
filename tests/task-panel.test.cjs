const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
function load(file, mocks) {
  const code = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = { exports: {}, Error, process, require: (name) => mocks[name] ?? require(name) };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}
const shared = load("src/features/task-panel/shared.ts", {
  "@getpaseo/plugin/server": { defineRpc: (value) => value },
});
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const CHILD = "00000000-0000-4000-8000-000000000003";
const GRANDCHILD = "00000000-0000-4000-8000-000000000004";

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "paseo-beads-test-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, "ai-native"));
  const parents = { [A]: null, [B]: null, [CHILD]: A, [GRANDCHILD]: CHILD };
  const calls = [];
  const issues = new Map();
  const overrides = {};
  const directory = (id) => path.join(home, "ai-native/personal/agent-state", id, "beads/.beads");
  const server = load("src/features/task-panel/server.ts", {
    "./shared": shared,
    "node:os": { homedir: () => home },
    "node:util": { promisify: (fn) => fn },
    "node:child_process": {
      execFile: async (command, args, options) => {
        calls.push({ command, args, options });
        assert.equal(command, "bd");
        assert.equal(args[0], "--readonly");
        assert.equal(options.env.BEADS_DIR, path.join(options.cwd, ".beads"));
        assert.deepEqual(
          Object.keys(options.env).filter((key) => /^(BEADS_|DOLT_)/.test(key)),
          ["BEADS_DIR"],
        );
        const dir = options.env.BEADS_DIR;
        const action = args[1];
        if (overrides[action]) return { stdout: await overrides[action](dir) };
        const value =
          action === "context"
            ? { beads_dir: dir, dolt_mode: "embedded", is_redirected: false }
            : action === "where"
              ? { path: dir, database_path: path.join(dir, "dolt") }
              : (issues.get(dir) ?? []);
        return { stdout: JSON.stringify(value) };
      },
    },
  });
  async function addDatabase(id, metadata = { dolt_mode: "embedded", database: "beads.db" }) {
    const dir = directory(id);
    await fs.mkdir(path.join(dir, "dolt"), { recursive: true });
    await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify(metadata));
    issues.set(dir, [{ id: `task-${id}`, title: id, status: "open", dependencies: [] }]);
    return dir;
  }
  async function query(id) {
    const result = await server.getBeadsTaskList(
      { agentId: id },
      {
        paseo: {
          agents: {
            ref: (agentId) => ({
              refresh: async () =>
                agentId in parents
                  ? {
                      agent: {
                        id: agentId,
                        labels: parents[agentId]
                          ? { "paseo.parent-agent-id": parents[agentId] }
                          : {},
                      },
                    }
                  : null,
            }),
          },
        },
      },
    );
    shared.beadsTaskList.parse(result);
    return result;
  }
  return { home, query, addDatabase, directory, calls, parents, overrides };
}

test("two main agents use different stores; nested children reuse the main store", async (t) => {
  const f = await fixture(t);
  await f.addDatabase(A);
  await f.addDatabase(B);
  const a = await f.query(A),
    b = await f.query(B),
    child = await f.query(GRANDCHILD);
  assert.equal(a.lastError, null);
  assert.equal(b.lastError, null);
  assert.notEqual(a.beadsDirectory, b.beadsDirectory);
  assert.equal(a.tasks[0].title, A);
  assert.equal(b.tasks[0].title, B);
  assert.equal(child.mainAgentId, A);
  assert.equal(child.tasks[0].title, A);
  assert.ok(f.calls.some((call) => call.args[1] === "show"));
  assert.ok(
    f.calls.every((call) => [f.directory(A), f.directory(B)].includes(call.options.env.BEADS_DIR)),
  );
});

test("an uninitialized main store stays absent and never runs bd", async (t) => {
  const f = await fixture(t);
  const result = await f.query(CHILD);
  assert.equal(result.mainAgentId, A);
  assert.equal(result.beadsAvailable, false);
  assert.equal(result.lastError, null);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.directory(A)), { code: "ENOENT" });
});

test("uses the embedded storage path reported by bd instead of assuming dolt", async (t) => {
  const f = await fixture(t);
  const dir = await f.addDatabase(A, { database: "dolt", backend: "dolt", dolt_mode: "embedded" });
  await fs.rename(path.join(dir, "dolt"), path.join(dir, "embeddeddolt"));
  f.overrides.where = () =>
    JSON.stringify({ path: dir, database_path: path.join(dir, "embeddeddolt") });
  const result = await f.query(A);
  assert.equal(result.lastError, null);
  assert.equal(result.tasks[0].title, A);
  await assert.rejects(fs.stat(path.join(dir, "dolt")), { code: "ENOENT" });
});

test("missing parents, invalid IDs and cycles fail without accessing a database", async (t) => {
  const f = await fixture(t);
  assert.ok((await f.query("../../outside")).lastError);
  delete f.parents[A];
  assert.ok((await f.query(CHILD)).lastError);
  f.parents[A] = CHILD;
  assert.match((await f.query(CHILD)).lastError, /循环/);
  assert.equal(f.calls.length, 0);
});

test("existing incomplete or corrupt stores report errors and are not reinitialized", async (t) => {
  const f = await fixture(t);
  const dir = await f.addDatabase(A);
  await fs.writeFile(path.join(dir, "metadata.json"), "broken");
  assert.ok((await f.query(A)).lastError);
  await fs.unlink(path.join(dir, "metadata.json"));
  assert.ok((await f.query(A)).lastError);
  assert.equal(f.calls.length, 0);
});

test("redirects, symlinks, external storage and server-mode stores are rejected", async (t) => {
  const f = await fixture(t);
  const a = await f.addDatabase(A),
    b = await f.addDatabase(B);
  await fs.writeFile(path.join(a, "redirect"), b);
  assert.match((await f.query(A)).lastError, /redirect/);
  await fs.unlink(path.join(a, "redirect"));
  await f.addDatabase(A, { dolt_mode: "server" });
  assert.match((await f.query(A)).lastError, /embedded/);
  await f.addDatabase(A, { dolt_mode: "embedded", dolt_data_dir: path.join(b, "dolt") });
  assert.match((await f.query(A)).lastError, /之外/);
  await fs.rm(a, { recursive: true });
  await fs.symlink(b, a);
  assert.match((await f.query(A)).lastError, /软链/);
  assert.equal(f.calls.length, 0);
});

test("effective config or where pointing outside the agent store stops before list", async (t) => {
  const f = await fixture(t);
  await f.addDatabase(A);
  await f.addDatabase(B);
  f.overrides.context = () => JSON.stringify({ beads_dir: f.directory(B), dolt_mode: "embedded" });
  assert.ok((await f.query(A)).lastError);
  delete f.overrides.context;
  f.overrides.where = () =>
    JSON.stringify({ path: f.directory(A), database_path: path.join(f.directory(B), "dolt") });
  assert.ok((await f.query(A)).lastError);
  assert.ok(f.calls.every((call) => !["list", "show"].includes(call.args[1])));
});

test("bd failure and malformed JSON produce an error, not a shared-store fallback", async (t) => {
  const f = await fixture(t);
  await f.addDatabase(A);
  f.overrides.list = () => {
    throw new Error("database locked");
  };
  assert.match((await f.query(A)).lastError, /database locked/);
  f.overrides.list = () => "invalid JSON";
  assert.match((await f.query(A)).lastError, /JSON/);
  assert.ok(f.calls.every((call) => call.options.env.BEADS_DIR === f.directory(A)));
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
function clientFixture() {
  const states = [],
    effects = [],
    requests = [];
  let cursor = 0,
    pendingEffects = [],
    tree;
  const equal = (a, b) => a && b && a.length === b.length && a.every((item, i) => item === b[i]);
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (value) => {
          states[i] = value;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      return (states[i] ??= { current: initial });
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!equal(states[i]?.deps, deps)) states[i] = { deps, value: fn() };
      return states[i].value;
    },
    useCallback(fn, deps) {
      return hooks.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!equal(effects[i]?.deps, deps))
        pendingEffects.push(() => {
          effects[i]?.cleanup?.();
          effects[i] = { deps, cleanup: fn() };
        });
    },
  };
  const loadList = (input) =>
    new Promise((resolve, reject) => requests.push({ input, resolve, reject }));
  const jsx = (type, props) => ({ type, props });
  const client = load("src/features/task-panel/client.tsx", {
    "./shared": shared,
    "./agent-config": { AgentConfigPanel: "AgentConfigPanel" },
    "../../components": { Card: "Card", Toast: "Toast" },
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      StyleSheet: { create: (s) => s },
      Text: "Text",
      View: "View",
      ScrollView: "ScrollView",
      Pressable: "Pressable",
      TextInput: "TextInput",
    },
    "@getpaseo/plugin": {
      useWorkspace: () => "/same/worktree",
      useAgent: () => null,
      useRpc: (contract) =>
        contract === shared.getBeadsTaskList ? loadList : async () => ({ config: null }),
    },
  });
  function render(agentId) {
    cursor = 0;
    pendingEffects = [];
    tree = client.TaskPanel({
      agentId,
      workspaceId: "workspace",
      theme: { colors: {} },
      layout: { compact: false },
    });
    pendingEffects.forEach((fn) => fn());
    return tree;
  }
  const text = () => JSON.stringify(tree);
  return {
    render,
    requests,
    text,
    unmount: () => effects.forEach((effect) => effect?.cleanup?.()),
  };
}
function snapshot(title) {
  return {
    mainAgentId: A,
    beadsDirectory: "/fixture/.beads",
    beadsAvailable: true,
    tasks: [
      { id: title, title, status: "open", description: null, dependencies: [], assignee: null },
    ],
    lastError: null,
    lastUpdatedAt: "now",
  };
}

test("switching agents hides prior data immediately and ignores stale async responses", async () => {
  const f = clientFixture();
  f.render(A);
  assert.equal(f.requests[0].input.agentId, A);
  f.requests[0].resolve(snapshot("A-OLD"));
  await tick();
  f.render(A);
  assert.ok(f.text().includes("A-OLD"));
  f.render(B);
  assert.ok(!f.text().includes("A-OLD"));
  assert.equal(f.requests[1].input.agentId, B);
  f.render(A);
  f.requests[2].resolve(snapshot("A-NEW"));
  await tick();
  f.requests[1].resolve(snapshot("B-LATE"));
  await tick();
  f.render(A);
  assert.ok(f.text().includes("A-NEW"));
  assert.ok(!f.text().includes("B-LATE"));
  f.unmount();
});

test("a previous agent's late failure cannot replace the current result", async () => {
  const f = clientFixture();
  f.render(A);
  f.render(B);
  f.requests[1].resolve(snapshot("B-CURRENT"));
  await tick();
  f.requests[0].reject(new Error("A-STALE-ERROR"));
  await tick();
  f.render(B);
  assert.ok(f.text().includes("B-CURRENT"));
  assert.ok(!f.text().includes("A-STALE-ERROR"));
  f.unmount();
});
