const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(mrUrl) {
  const states = [],
    effects = [],
    creations = [];
  let cursor = 0,
    pending = [],
    tree;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (v) => {
          states[i] = v;
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
    useEffect(fn, deps) {
      const i = cursor++;
      if (!equal(effects[i]?.deps, deps))
        pending.push(() => {
          effects[i]?.cleanup?.();
          effects[i] = { deps, cleanup: fn() };
        });
    },
  };
  const shared = {
    DEFAULT_MR_URL: "默认链接",
    DEFAULT_MEEGO_URL: "默认链接",
    getShortcutBinding: "binding",
    getCurrentBranch: "branch",
    saveShortcutBinding: "save",
  };
  const rpc = {
    binding: async () => ({ mrUrl, branch: "main" }),
    branch: async () => ({ branch: "main" }),
  };
  const paseo = {
    workspaces: {
      ref: (workspaceId) => ({
        agents: {
          create: (input) =>
            new Promise((resolve, reject) =>
              creations.push({ workspaceId, ...input, resolve, reject }),
            ),
        },
      }),
    },
  };
  const jsx = (type, props) => ({ type, props });
  const mocks = {
    "./shared": shared,
    "../../components": { Button: "Button", Toast: "Toast" },
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      StyleSheet: { create: (s) => s },
      Text: "Text",
      View: "View",
      Pressable: "Pressable",
      TextInput: "TextInput",
    },
    "@getpaseo/plugin": {
      usePaseo: () => paseo,
      useWorkspace: () => "/fixture",
      useRpc: (key) => rpc[key],
    },
  };
  const file = path.join(__dirname, "../src/features/shortcut/client.tsx");
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = { exports: {}, Error, require: (name) => mocks[name] };
  vm.runInNewContext(code, context, { filename: file });
  function render() {
    cursor = 0;
    pending = [];
    tree = context.exports.ShortcutPanel({
      agentId: "current-agent",
      workspaceId: "workspace",
      theme: { colors: {} },
      layout: { compact: false },
    });
    pending.forEach((fn) => fn());
  }
  function find(type, label) {
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === type && (!label || node.props.label === label)) return node.props;
      return [node.props?.children].flat().map(visit).find(Boolean);
    };
    return visit(tree);
  }
  return {
    render,
    creations,
    button: () => find("Button", "提高华佗测试覆盖率"),
    toast: () => find("Toast"),
  };
}

test("Huatuo command creates one agent in the current workspace with the bound MR and safety requirements", async () => {
  const url = "https://example.com/mr/42?version=latest&view=changes";
  const f = fixture(` ${url} `);
  f.render();
  assert.equal(f.button().disabled, true);
  f.button().onPress();
  assert.equal(f.creations.length, 0);
  await tick();
  f.render();
  assert.equal(f.button().disabled, false);
  f.button().onPress();
  f.button().onPress();
  assert.equal(f.creations.length, 1);
  const created = f.creations[0];
  assert.equal(created.workspaceId, "workspace");
  assert.equal(created.title, "提高华佗测试覆盖率");
  assert.equal(created.config.provider, "codex/gpt-6-astra");
  assert.equal(created.config.modeId, "full-access");
  assert.equal(created.config.thinkingOptionId, "high");
  assert.equal(created.labels.shortcut, "huatuo-coverage");
  assert.equal(created.parentAgentId, undefined);
  const prompt = created.prompt;
  assert.ok(prompt.includes(`MR 链接：${JSON.stringify(url)}`));
  assert.equal((prompt.match(/^\d+\. /gm) || []).length, 10);
  for (const requirement of [
    "web-access Skill",
    "0/0 的未插桩文件不作为补测目标",
    "立即停止后续补测",
    "不自行修复",
    "敏感信息须脱敏",
    "删除、退出团队、权限变更、付费或 AI 生成等操作必须另行征得我的确认",
    "不修改业务代码",
    "不重跑流水线或推进 Bits 阶段",
    "以超过 90% 为目标",
    "第 5 条优先",
    "保留我的原有标签页",
  ])
    assert.ok(prompt.includes(requirement), requirement);
  f.render();
  assert.equal(f.button().loading, true);
  f.creations[0].resolve();
  await tick();
  f.render();
  assert.equal(f.button().loading, false);
  assert.equal(f.toast().variant, "success");
});

test("Huatuo command blocks absent/default MR bindings", async () => {
  for (const mr of [null, "", "   ", "默认链接"]) {
    const f = fixture(mr);
    f.render();
    await tick();
    f.render();
    assert.equal(f.button().disabled, true);
    f.button().onPress();
    assert.equal(f.creations.length, 0);
  }
});

test("Huatuo creation failure is visible and releases the retry guard", async () => {
  const f = fixture("https://example.com/mr/42");
  f.render();
  await tick();
  f.render();
  f.button().onPress();
  f.creations[0].reject(new Error("creation failed"));
  await tick();
  f.render();
  assert.equal(f.toast().variant, "error");
  assert.equal(f.toast().message, "creation failed");
  assert.equal(f.button().loading, false);
  f.button().onPress();
  assert.equal(f.creations.length, 2);
  f.creations[1].resolve();
  await tick();
});
