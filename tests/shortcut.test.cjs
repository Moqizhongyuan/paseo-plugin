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
    "所有浏览器操作都必须走 GPT 插件",
    "禁止使用 CDP、CDP Proxy、远程调试端口",
    "不得在插件不可用时自动回退到 CDP",
    "若 GPT 插件入口不可用或未连接，报告阻塞并等待我处理",
    "通过 GPT 浏览器插件为本次测试创建专用标签页",
    "创建后立即暂停并结束本轮回复，保留该标签页",
    "由我手动配置 PPE 和 Tab Filter",
    "Agent 不操作 ENV 插件，不新增、修改或清理 ENV 配置",
    "必须等我明确回复配置完成并继续后",
    "不得在等待期间自行继续",
    "核验请求实际命中目标 PPE，并单独核验前端代码版本",
    "正常收尾时提醒我清理本次 PPE 和 Tab Filter，Agent 不操作这些配置",
    "未经确认不清理会破坏异常证据的配置或标签页",
    "0/0 的未插桩文件不作为补测目标",
    "立即停止后续补测",
    "不自行修复",
    "敏感信息须脱敏",
    "删除、退出团队、权限变更、付费或 AI 生成等操作必须另行征得我的确认",
    "不修改业务代码",
    "不重跑流水线或推进 Bits 阶段",
    "通过桌面级 Computer Use 打开测试标签页开发者工具的 Network 面板",
    "确认华佗覆盖率上报的真实域名、路径和请求特征",
    "不得拦截、修改或重放请求，禁止改走 CDP",
    "不能仅凭出现请求或 HTTP 2xx 就认定成功",
    "上报成功但报告尚未更新",
    "记录可观察到的自动重试及结果",
    "发生明确上报失败时暂停后续补测",
    "不自行修复或手工补发",
    "每 30 秒检查一次，单批最多等待 5 分钟",
    "不要为催促上报而重复执行有数据副作用的操作",
    "只有华佗报告回读确认后才计入新增覆盖",
    "关闭测试标签页或清理 ENV 配置前，先完成本批上报状态核验",
    "恢复本次修改的 Network 过滤和日志保留等设置",
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
