import { type PluginAgentPanelProps, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Toast, type ToastVariant } from "../../components";
import {
  DEFAULT_MEEGO_URL,
  DEFAULT_MR_URL,
  getCurrentBranch,
  getShortcutBinding,
  saveShortcutBinding,
} from "./shared";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

// “评审当前 MR”只创建一个 GPT 管理 Agent，由它负责后续编排两个 Claude 子 Agent 与飞书文档。
// 管理 Agent 固定使用完整 provider/model，并以 full-access 模式运行（它需要创建子 Agent 与飞书文档，
// 这些是允许的外部写入）；两个 Claude 子 Agent 使用下方固定的实时可用 provider/model 与只读模式。
const REVIEW_MANAGER_PROVIDER = "codex/gpt-6-astra";
const REVIEW_MANAGER_MODE_ID = "full-access";
const REVIEW_CHILD_PROVIDER = "claude-super-relay/claude-opus-4-8[1m]";
const REVIEW_CHILD_MODE_ID = "plan";
const REVIEW_CHILD_THINKING_OPTION_ID = "max";
const REVIEW_CHILD_FEATURES = { fast_mode: true } as const;
const REVIEW_CHILD_MAX_RETRIES = 3;

// 构造 GPT 管理 Agent 的 initial prompt：插件只提供 MR URL、绑定分支、workspaceId 和整个管理流程，
// 真正的 MR 取证、创建两个 Claude 子 Agent、收集结果、创建飞书文档都由这个管理 Agent 异步负责。
function buildReviewManagerPrompt(
  targetMrUrl: string,
  branch: string,
  reviewWorkspaceId: string,
): string {
  return `你是本次 MR 代码评审的“管理 Agent”，负责端到端编排评审并产出一份飞书云文档。请按下面的流程执行。

输入信息：
- MR 链接：${JSON.stringify(targetMrUrl)}
- 当前绑定分支：${JSON.stringify(branch)}
- 目标 Workspace ID：${JSON.stringify(reviewWorkspaceId)}

一、你自己的取证（先做）：
1. 核对 MR 链接、MR 的源分支与目标分支、当前 Git 状态和远端配置；从真实 diff 取证（例如比较 MR 目标分支与源分支，或从代码托管平台读取 MR diff），不要根据分支名称或文件名猜测改动内容。
2. 如信息缺失或不一致（例如 MR 链接无法访问、分支对不上），在最终结论中如实说明，不要臆测。

二、创建两个 Claude 子 Agent（遵循 Paseo 多 Agent 规则）：
- 使用 Paseo skill / MCP（create_agent 等）在目标 Workspace ${JSON.stringify(reviewWorkspaceId)} 中创建两个 Claude 子 Agent；不要绑定发起本次评审的快捷面板 Agent，也不要把它当作 parent。
- provider/model 必须固定为当前 Claude Seed 内测的完整 ID：${JSON.stringify(REVIEW_CHILD_PROVIDER)}；不要使用旧 profile 中的 ${JSON.stringify("model_api/experimental_0630")}、模糊的 provider 名称 ${JSON.stringify("claude")}，也不要自行改用未经实时确认的其他模型。
- 创建前必须通过 Paseo 的 provider/model 查询确认 ${JSON.stringify(REVIEW_CHILD_PROVIDER)} 仍出现在实时模型列表中。若没有出现在列表中，先刷新并重新查询一次；仍不可用时记录真实 blocker，不要用过期 profile 猜测或冒充成功。
- 两个子 Agent 都使用 ${JSON.stringify(REVIEW_CHILD_MODE_ID)} / 只读模式、thinking option ${JSON.stringify(REVIEW_CHILD_THINKING_OPTION_ID)}，并在 Paseo MCP create_agent 的 settings 中传入 features: ${JSON.stringify(REVIEW_CHILD_FEATURES)} 开启 fast mode；位于同一个 Workspace，使用清晰的标题和 labels（例如 role=primary-review / role=verification-review）。这里是 MCP 调用，必须使用 settings: { modeId, thinkingOptionId, features }；不要传 config，也不要传顶层 featureValues。
- 每个子任务都必须写清：目标、允许范围、禁止范围、背景、完成标准、验证命令、失败/回滚边界，以及固定的结构化汇报格式。必要时先建立或指定一个 chat room 做协作与结果收集。

Claude 子 Agent 1（主评审）：
- 只读审查 MR 改动的：正确性、边界、异常处理、安全、性能、可维护性、测试覆盖，以及与项目既有约定的一致性。
- 禁止修改任何文件、禁止 git add/commit/push、禁止改写历史、禁止发布 MR 评论或任何远端写入。
- 输出结构化报告：总体结论 + 逐条问题（严重级别 blocker/major/minor/nit、path:line、证据、建议）、验证情况、不确定项。

Claude 子 Agent 2（复核）：
- 不能信任 Agent 1 的结论；必须独立重新读取真实 diff 与相关代码上下文取证。
- 逐条把 Agent 1 的问题标记为 confirmed / rejected / uncertain 并给出自己的 path:line 证据，补充 Agent 1 遗漏的问题，给出纠正后的最终建议（approve / request-changes / needs-discussion）。
- 同样只读，禁止修改文件、git add/commit/push、改写历史或发布 MR 评论。
- 你可以先等待 Agent 1 完成，再把它的状态与报告原文发送给 Agent 2；即使 Agent 1 失败、超时或没有产出文本，也要把该状态转交给 Agent 2，并要求 Agent 2 完整、独立地评审。

两个 Claude 评审 Agent 的子 Agent 权限与重试边界：
- 必须把本段授权和边界写进两个 Claude 评审 Agent 的 initialPrompt。两个评审 Agent 都可以按需使用 Paseo skill / MCP create_agent 创建自己的 Claude 子 Agent，用于只读检索、分片审查或验证；不得使用其它 spawn / Task / Explore 委托机制。
- 评审 Agent 创建的子 Agent 必须继承相同的只读红线，使用目标 Workspace，并在创建后核对 parent、Workspace、provider/model 和模式。若一次创建两个及以上子 Agent，先按 Paseo 规则建立或指定 chat room 并划清任务与共享资源边界。
- 每个 Claude 评审 Agent 自行管理它所创建子 Agent 的等待、结果收集和有限重试。重试次数、等待间隔和是否改为自身继续审查，可以由该评审 Agent 根据实际错误独立决定，不需要与 GPT 管理 Agent 对两个评审 Agent 的外层重试机制保持一致，也不需要与另一个 Claude 评审 Agent 保持一致；但禁止无限重试。
- 某个子 Agent 失败不等于所属 Claude 评审 Agent 失败。评审 Agent 应优先复用已完成的自身取证、必要时自行补齐缺口，并在最终报告中说明子 Agent 失败及未覆盖范围。只有评审 Agent 自身最终没有产出报告或进入失败终态，GPT 管理 Agent 才使用下面的外层重试机制。

三、两个 Claude 评审 Agent 的外层有限重试（由 GPT 管理 Agent 分别处理）：
- 创建或运行两个 Claude 评审 Agent 时，HTTP 429、5xx（尤其是 503 No available accounts）、网关暂时不可用、timeout、connection reset、stream disconnected 等属于可重试的临时服务端错误。第一次遇到这类错误时，不要立即把对应评审 Agent 判定为最终失败。
- 每个评审 Agent 最多重试 ${REVIEW_CHILD_MAX_RETRIES} 次（首次尝试之外的重试次数）。建议使用递增等待，例如 15 秒、30 秒、60 秒；每次重试前重新读取评审 Agent 状态和最近活动，确认没有已经成功完成的请求。
- 如果创建评审 Agent 的 create_agent 返回错误，先通过 Paseo 查询目标 Workspace 中是否已经创建了对应评审 Agent；只有确认没有创建成功时才重新创建，避免重复创建和重复消耗账号配额。若评审 Agent 已存在，优先复用原 Agent 并发送重试指令，不要为同一次评审无限制地新建 tab。
- 两个评审 Agent 的外层重试相互独立，也不管理它们各自创建的子 Agent 重试。主评审成功后仍要等待复核 Agent 完成；主评审失败、超时或所有外层重试耗尽时，仍把完整状态和每次错误原文传给复核 Agent，要求复核 Agent 独立完成评审。
- 在所有重试结束前，不要创建最终飞书文档，也不要汇报“评审已完成”。应轮询或等待两个 Agent 到达终态；如果仍处于 running，继续等待，不要因为暂时没有新输出就提前结束。
- 达到外层重试上限后仍失败时，才把对应评审 Agent 标记为 blocked/error，并在文档和最终回复中记录尝试次数、每次错误、等待过程和真实终态；不得编造评审结论。若只有一个评审 Agent 成功，文档仍须明确区分已完成的报告与未完成的部分。

四、创建飞书云文档（结果汇总）：
- 先读取 lark-doc 与 lark-shared 的使用要求以及创建文档所需的 references。
- 默认使用 \`lark-cli docs +create --as user\` 的 XML 格式创建文档；创建后必须检查返回 JSON 的 ok:true 与文档 URL。若失败，请如实报告真实的认证/权限原因，不得假称已创建。
- 文档标题与正文要清楚标识：本次 MR、评审时间、两个 Agent 的结论、问题清单、证据、验证结果和不确定项。不要广播消息或发送到群聊。

五、红线（管理 Agent 自身）：
- 不得修改当前仓库代码、不得 git commit/push、不得修改 MR 或发布 MR 评论。只读评审与创建飞书文档是允许的外部写入。

六、最终回复：
- 汇总两个 Agent 的评审结论要点，并在你自己的最终回复中明确给出所创建飞书文档的 URL（若文档创建失败，则说明失败原因）。`;
}

function buildBitsDevTaskPrompt(
  codeDirectory: string,
  targetMeegoUrl: string,
  requirementBranch: string,
): string {
  return `请在当前 \`serial-common-monorepo\` 仓库中，一次性完成本需求的 Bits 开发任务创建，并启动标准流程对应的流水线。

任务信息：
- 需求名称：根据当前 Meego 名称
- 代码目录：${JSON.stringify(codeDirectory)}
- Meego：${JSON.stringify(targetMeegoUrl)}
- 需求分支：${JSON.stringify(requirementBranch)}
- 目标应用：红果AIGC创作工具平台（aigc-platform）
- 应用主 SCM：novel_fe/serial/aigc_platform
- 流程：小说通用-单需求发布流程 / 【小说】标准开发流程
- 部署环境：仅使用 PPE；自动生成一个具体的 \`ppe_<random>\` 环境，不使用 BOE

执行要求：
1. 使用项目的 \`serial-bits-dev-task\` 和官方 \`bits-devops-dev-task\` Skill。
2. 必须根据代码目录 \`apps/aigc-platform\` 显式选择“红果AIGC创作工具平台（aigc-platform）”。
3. 不得仅根据 monorepo 的 Git remote 套用默认项目，也不得选择 \`playlet-produce\` 或 \`playlet-produce-migrate\`。
4. 创建前通过应用中心核对目标应用名称和主 SCM；二者必须与上述信息完全一致，否则停止创建并报告。
5. 如果当前分支不是需求分支，将本需求的提交和工作区改动迁移到需求分支，并设置远端 upstream。
6. 提交并推送本需求相关的全部改动。不得提交无关改动；仅由本地构建产生的 \`apps/aigc-platform/@mf-types/**\` 变化不要纳入提交，也不要擅自清理。
7. 本消息明确授权本次执行 \`git commit\`、\`git push\`、创建或迁移需求分支，以及正式创建 Bits 开发任务。不使用 force push，不删除其他分支。
8. 参数校验后，查询是否已经存在同时匹配该 Meego、需求分支和目标应用的开发任务：
   - 已存在：不要重复创建，直接回读并返回已有任务。
   - 不存在：只创建一个新的开发任务。
9. 本消息同时构成最终参数确认。我明确授权本次 prepare 和 submit 使用 \`BITS_DEV_TASK_NO_CONFIRM=1\`；该授权仅限本次任务。参数齐全后直接创建，不要再次要求我回复“确认创建”。
10. 如果创建请求超时或结果不明确，必须先查询平台确认是否已经创建，不得直接重复提交。
11. 创建后必须回读并核对任务名称、Meego、目标应用、主 SCM、需求分支、提交和实际 PPE 环境。只有全部一致时才报告完成。
12. 最终返回 Bits 链接、任务 ID、目标应用、需求分支、提交、Meego、实际 PPE 和流水线状态。`;
}

function buildTestSubmissionPrompt(targetMeegoUrl: string, targetMrUrl: string): string {
  return `请根据本需求的测试计划补全提测文档，由你这一个 Agent 直接执行，不创建其他 Agent 或 Beads 任务图。

任务信息：
- Meego 链接：${JSON.stringify(targetMeegoUrl)}
- 面板绑定的 MR 地址（仅作检索线索，需核对属于该 Meego）：${JSON.stringify(targetMrUrl)}
- 提测文档模板：https://bytedance.larkoffice.com/wiki/UTkywASFriMHOJkqTvicjmZXnkb

一、确定文档与资料
1. 使用适用的 Meego 查询工具，以及 lark-doc、lark-drive Skill，读取上述 Meego 的详情、关联文档、附件和相关评论。只处理该需求，不根据模板示例推断业务。
2. 必须直接使用上述链接对应的飞书模板生成“需求名称-提测文档”，这是强制要求。已核实飞书官方文档 https://open.feishu.cn/document/docs/drive-v1/file/create-cloud-document 明确指定“复制文件”接口作为“基于模板创建文档”的入口：POST /open-apis/drive/v1/files/:file_token/copy，现有 CLI 已提供 lark-cli drive files copy。按 lark-drive Skill 先将上述 Wiki 链接解析为实际文档 token，确认源文件类型和目标文件夹，再调用该接口生成文档；不得把 Wiki 节点 token 直接当作文件 token。若该接口对当前模板不可用，必须使用 web-access Skill 在已登录的浏览器中打开上述模板网页，点击右上角“使用该模板”，完成创建并获取实际生成的文档链接。不得通过读取正文后重新创建、手写 Markdown/XML 来替代直接使用模板。若本需求已有由该模板生成的提测文档，经核实后可继续补全，避免重复创建；有多个无法区分的目标文档时先确认，不猜选。
   创建后读取实际生成的文档，核对模板原有的章节、表格、图片及样式均被保留，再填写指定内容；模板源文档本身不得修改。若网页入口也不可用或权限不足，报告实际阻塞并等待处理，不得自行改用其他模板或重建文档。
3. 仅补全这些字段：Meego链接/需求文档、UX稿、埋点文档、技术方案文档、MR地址、测试计划。尽可能从 Meego 获取真实可点击链接；MR 可使用经核对属于该需求的面板绑定地址。找不到的字段留空，不填写“未找到”等占位文字，不编造链接，不清空已有的有效信息。
4. 测试计划必须实际读取完整内容；有嵌入表格、多维表格或 Bits 用例时，使用对应 Skill 展开并读取全部相关用例及分页。找不到或无权限读取测试计划时，先完成可确认的资料字段，并明确报告自测阻塞，不能自行生成计划替代原计划。

二、填写 PPE 环境
1. 从已核对的 MR 描述、评论和关联部署记录获取真实 PPE 环境，并确认与该 MR 的部署版本对应。在模板的“PPE环境”中分别填写已确认的服务端环境和前端环境，同时保留来源链接。
2. 找不到的环境留空；不得使用模板中的 ppe_test_xxx、随机环境或从分支名推测。环境无法确认或不可访问时，不把其他环境的结果写成 PPE 自测。

三、按测试计划完成自测演示
1. 先将测试计划全部展开为逐项清单，保留原编号或标题、前置条件、步骤和预期结果；覆盖所有测试计划条目，包括异常、边界、权限和不同角色场景，不只选主流程。
2. 在上述 MR 对应的 PPE 中逐项执行并记录实际结果。Mac 上真实登录态及多环境插件交互必须使用 web-access Skill，通过 CDP 复用 Chrome，并在自己的标签页内操作。读取团队“E2E录屏交付”操作指引，使用可用的真实录屏能力记录操作过程；不得用静态图片拼接冒充录屏。
3. 可按场景分段录屏；将可播放的录屏附件或可访问链接放入“自测演示 / 录屏”，标注每段对应的测试计划条目及必要的时间位置。复核视频确实包含操作和结果。
4. 在“自测演示 / 截屏”原有的“场景 / 功能说明 / 截图”表格中按需增加行。场景对应测试计划编号或标题；功能说明记录关键步骤、预期、实际结果与通过/失败/阻塞状态；截图单元格嵌入关键操作、状态和结果的真实截图，不能只写本地路径或文字说明。
5. 某条用例失败或受权限、账号、数据、环境影响时，如实记录原因并继续其余可执行用例，不漏记，也不宣称全部通过。若需 Mock 辅助展示，必须明确标注，不能替代真实 PPE 自测结论。
6. 只操作必要的测试数据，不改业务代码、不提交或推送代码、不执行发布。涉及生产数据、付费或不可逆删除的用例先确认授权，未执行的条目记录阻塞原因。

四、范围与交付
1. 只修改上述六个资料字段、PPE 环境，以及自测演示中的录屏和截屏表格；其他章节保留原样，不额外补写。
2. 写入后重新读取提测文档，核对字段、表格内图片、录屏可访问性，以及所有测试计划条目与执行结果的一一对应关系。
3. 最终返回提测文档链接、测试计划总数和通过/失败/阻塞/未执行数量、录屏链接、缺失资料及未完成原因。只有全部条目实际执行且证据齐全时，才可报告已完成全部自测覆盖。`;
}

function buildHuatuoCoveragePrompt(targetMrUrl: string): string {
  return `请根据以下 MR 链接，在我已登录的浏览器中进行补测，提高华佗增量代码覆盖率，同时验证功能是否正常。

MR 链接：${JSON.stringify(targetMrUrl)}

执行要求：

1. 自动确认测试对象
从 MR 或关联 Bits 开发任务查询真实的源分支、最新提交、PPE 环境、华佗报告和覆盖率门禁。不要根据历史或名称猜测；只有信息无法唯一确定时才问我。

2. 使用真实 PPE 环境
使用 web-access Skill 连接我日常使用且已登录的浏览器，确认页面命中本次 PPE 和对应代码版本。不得用本地开发环境、其他泳道或其他版本替代。

3. 按未覆盖代码设计操作
完整盘点报告中“已插桩但未覆盖”的代码，结合源码和已有测试计划，明确对应页面、操作入口、触发条件和预期结果。0/0 的未插桩文件不作为补测目标。

4. 真实操作并同步验收
通过页面点击、输入、滚动等真实交互触发代码，同时检查页面展示、交互、请求结果及数据变化是否符合预期。不得只为了执行代码而忽略功能问题。

5. 发现问题立即停止并上报
一旦发现页面或业务异常，立即停止后续补测，不继续追求覆盖率、不自行修复。保留现场，及时向我报告：
- 页面地址、PPE 环境和代码版本；
- 复现步骤；
- 预期结果与实际结果；
- 截图及可获取的控制台、请求错误信息，敏感信息须脱敏；
- 是否产生数据改动。
等待我决定后再继续。仅在安全且不会破坏异常证据时清理临时数据。

6. 控制测试副作用
优先使用低风险、可恢复的场景。允许对明确的测试数据进行临时编辑和保存，完成后恢复原值并回读确认。删除、退出团队、权限变更、付费或 AI 生成等操作必须另行征得我的确认。不得影响其他人的业务数据。

7. 不伪造覆盖结果
不修改业务代码、不直接调用内部函数、不篡改覆盖率数据、不擅自添加豁免。无法通过正常 UI 触发的防御分支，说明所缺条件，不强行凑数。

8. 以平台回读为准
分批补测并更新、回读华佗报告，确认目标代码实际变为已覆盖。“点击成功”不等于“覆盖已回收”。未获授权，不重跑流水线或推进 Bits 阶段。

9. 达标即停止
默认达到华佗门禁要求即停止；没有明确阈值时，以超过 90% 为目标。开始时已达标则直接告知，不额外补测。发现异常时，第 5 条优先于覆盖率目标。

10. 收尾与汇报
恢复临时数据和浏览器设置，取消未提交草稿，关闭本次创建的临时标签页，保留我的原有标签页。汇报覆盖率前后变化、新增覆盖场景、功能验证结果、未覆盖项及原因、数据恢复情况和华佗报告链接。

除目标信息无法确定、缺少必要权限或测试数据、发现异常及需要高风险操作授权外，连续执行，不逐步要求我确认。`;
}

export function ShortcutPanel({ theme, layout, agentId, workspaceId }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const workspaceDirectory = useWorkspace(workspaceId, ({ directory }) => directory);
  const loadShortcutBinding = useRpc(getShortcutBinding);
  const loadCurrentBranch = useRpc(getCurrentBranch);
  const persistShortcutBinding = useRpc(saveShortcutBinding);
  const [gitBranch, setGitBranch] = useState("");
  const [draftBranch, setDraftBranch] = useState("");
  const [mrUrl, setMrUrl] = useState(DEFAULT_MR_URL);
  const [draftMrUrl, setDraftMrUrl] = useState(DEFAULT_MR_URL);
  const [meegoUrl, setMeegoUrl] = useState(DEFAULT_MEEGO_URL);
  const [draftMeegoUrl, setDraftMeegoUrl] = useState(DEFAULT_MEEGO_URL);
  const [editingBranch, setEditingBranch] = useState(false);
  const [editingMrUrl, setEditingMrUrl] = useState(false);
  const [editingMeegoUrl, setEditingMeegoUrl] = useState(false);
  const [branchLoading, setBranchLoading] = useState(true);
  const [savingBranch, setSavingBranch] = useState(false);
  const [savingMrUrl, setSavingMrUrl] = useState(false);
  const [savingMeegoUrl, setSavingMeegoUrl] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [sendingMainSyncPrompt, setSendingMainSyncPrompt] = useState(false);
  const [sendingMrSyncPrompt, setSendingMrSyncPrompt] = useState(false);
  const [sendingBitsPipelinePrompt, setSendingBitsPipelinePrompt] = useState(false);
  const [creatingHuatuoCoverageAgent, setCreatingHuatuoCoverageAgent] = useState(false);
  const huatuoCoverageCreationInFlight = useRef(false);
  const [creatingPushAgent, setCreatingPushAgent] = useState(false);
  const [creatingReviewManagerAgent, setCreatingReviewManagerAgent] = useState(false);
  const [creatingTestSubmissionAgent, setCreatingTestSubmissionAgent] = useState(false);
  const testSubmissionCreationInFlight = useRef(false);
  const [toast, setToast] = useState<{ message: string; variant: ToastVariant } | null>(null);

  useEffect(() => {
    let active = true;

    if (!workspaceDirectory) {
      setBranchLoading(false);
      return () => {
        active = false;
      };
    }

    const directory = workspaceDirectory;

    setBranchLoading(true);
    setBranchError(null);
    setEditingBranch(false);
    setEditingMrUrl(false);
    setEditingMeegoUrl(false);

    async function loadBranch() {
      try {
        const stored = await loadShortcutBinding({ agentId });
        if (!active) return;

        const loadedMrUrl = stored.mrUrl ?? DEFAULT_MR_URL;
        setMrUrl(loadedMrUrl);
        setDraftMrUrl(loadedMrUrl);
        const loadedMeegoUrl = stored.meegoUrl ?? DEFAULT_MEEGO_URL;
        setMeegoUrl(loadedMeegoUrl);
        setDraftMeegoUrl(loadedMeegoUrl);

        if (stored.branch) {
          setGitBranch(stored.branch);
          setDraftBranch(stored.branch);
          return;
        }

        const current = await loadCurrentBranch({ directory });
        if (!active) return;

        const fallbackBranch = current.branch ?? "";
        setGitBranch(fallbackBranch);
        setDraftBranch(fallbackBranch);
      } catch (cause) {
        if (active) setBranchError(errorMessage(cause));
      } finally {
        if (active) setBranchLoading(false);
      }
    }

    void loadBranch();
    return () => {
      active = false;
    };
  }, [agentId, loadCurrentBranch, loadShortcutBinding, workspaceDirectory]);

  function handleStartEditing() {
    if (branchLoading || savingBranch) return;
    setDraftBranch(gitBranch);
    setBranchError(null);
    setEditingBranch(true);
  }

  function handleCancelEditing() {
    if (savingBranch) return;
    setDraftBranch(gitBranch);
    setBranchError(null);
    setEditingBranch(false);
  }

  async function handleSaveBranch() {
    const normalizedBranch = draftBranch.trim();
    if (!normalizedBranch || savingBranch) return;

    setSavingBranch(true);
    setBranchError(null);
    try {
      const saved = await persistShortcutBinding({
        agentId,
        branch: normalizedBranch,
        mrUrl: mrUrl.trim() || DEFAULT_MR_URL,
        meegoUrl: meegoUrl.trim() || DEFAULT_MEEGO_URL,
      });
      setGitBranch(saved.branch);
      setDraftBranch(saved.branch);
      setMrUrl(saved.mrUrl);
      setDraftMrUrl(saved.mrUrl);
      setMeegoUrl(saved.meegoUrl);
      setDraftMeegoUrl(saved.meegoUrl);
      setEditingBranch(false);
    } catch (cause) {
      setBranchError(errorMessage(cause));
    } finally {
      setSavingBranch(false);
    }
  }

  function handleStartEditingMrUrl() {
    if (branchLoading || savingMrUrl) return;
    setDraftMrUrl(mrUrl);
    setBranchError(null);
    setEditingMrUrl(true);
  }

  function handleCancelEditingMrUrl() {
    if (savingMrUrl) return;
    setDraftMrUrl(mrUrl);
    setBranchError(null);
    setEditingMrUrl(false);
  }

  async function handleSaveMrUrl() {
    const normalizedBranch = gitBranch.trim();
    const normalizedMrUrl = draftMrUrl.trim();
    if (!normalizedBranch || !normalizedMrUrl || savingMrUrl) return;

    setSavingMrUrl(true);
    setBranchError(null);
    try {
      const saved = await persistShortcutBinding({
        agentId,
        branch: normalizedBranch,
        mrUrl: normalizedMrUrl,
        meegoUrl: meegoUrl.trim() || DEFAULT_MEEGO_URL,
      });
      setGitBranch(saved.branch);
      setDraftBranch(saved.branch);
      setMrUrl(saved.mrUrl);
      setDraftMrUrl(saved.mrUrl);
      setMeegoUrl(saved.meegoUrl);
      setDraftMeegoUrl(saved.meegoUrl);
      setEditingMrUrl(false);
    } catch (cause) {
      setBranchError(errorMessage(cause));
    } finally {
      setSavingMrUrl(false);
    }
  }

  function handleStartEditingMeegoUrl() {
    if (branchLoading || savingMeegoUrl) return;
    setDraftMeegoUrl(meegoUrl);
    setBranchError(null);
    setEditingMeegoUrl(true);
  }

  function handleCancelEditingMeegoUrl() {
    if (savingMeegoUrl) return;
    setDraftMeegoUrl(meegoUrl);
    setBranchError(null);
    setEditingMeegoUrl(false);
  }

  async function handleSaveMeegoUrl() {
    const normalizedBranch = gitBranch.trim();
    const normalizedMeegoUrl = draftMeegoUrl.trim();
    if (!normalizedBranch || !normalizedMeegoUrl || savingMeegoUrl) return;

    setSavingMeegoUrl(true);
    setBranchError(null);
    try {
      const saved = await persistShortcutBinding({
        agentId,
        branch: normalizedBranch,
        mrUrl: mrUrl.trim() || DEFAULT_MR_URL,
        meegoUrl: normalizedMeegoUrl,
      });
      setGitBranch(saved.branch);
      setDraftBranch(saved.branch);
      setMrUrl(saved.mrUrl);
      setDraftMrUrl(saved.mrUrl);
      setMeegoUrl(saved.meegoUrl);
      setDraftMeegoUrl(saved.meegoUrl);
      setEditingMeegoUrl(false);
    } catch (cause) {
      setBranchError(errorMessage(cause));
    } finally {
      setSavingMeegoUrl(false);
    }
  }

  async function handleCreatePushAgent() {
    const targetBranch = gitBranch.trim();
    if (!targetBranch || creatingPushAgent) return;

    setCreatingPushAgent(true);
    setToast(null);
    try {
      await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: "codex/gpt-6-astra",
          modeId: "full-access",
          thinkingOptionId: "low",
        },
        title: "提交并推送代码",
        prompt: `请在当前 Workspace 中完成以下任务：
1. 检查当前 Git 状态、当前分支和远端配置。
2. 将当前工作区中需要提交的代码整理为一个合适的 commit，提交信息根据实际改动生成。
3. 将该 commit 推送到远端目标分支 ${JSON.stringify(targetBranch)}。
4. 不要丢弃或覆盖现有改动；如果无法安全完成，请停止并说明原因。`,
      });

      setToast({ message: `已创建推送 Agent，目标分支：${targetBranch}`, variant: "success" });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setCreatingPushAgent(false);
    }
  }

  // 点击“评审当前 MR”时，只创建一个 GPT 管理 Agent，把 MR 信息与整个管理流程交给它异步执行。
  async function handleCreateReviewManagerAgent() {
    const targetBranch = gitBranch.trim();
    const targetMrUrl = mrUrl.trim();
    if (
      branchLoading ||
      !targetBranch ||
      !targetMrUrl ||
      targetMrUrl === DEFAULT_MR_URL ||
      creatingReviewManagerAgent
    ) {
      return;
    }

    setCreatingReviewManagerAgent(true);
    setToast(null);
    try {
      // 只创建一个 GPT 管理 Agent（新 tab，不绑定当前面板 agentId 为 parent）。
      // 后续的双 Claude 子 Agent 编排与飞书文档由这个管理 Agent 异步负责，插件不参与等待/转发。
      await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: REVIEW_MANAGER_PROVIDER,
          modeId: REVIEW_MANAGER_MODE_ID,
          thinkingOptionId: "high",
        },
        title: "MR Code Review 管理",
        labels: { shortcut: "mr-review", role: "review-manager" },
        prompt: buildReviewManagerPrompt(targetMrUrl, targetBranch, workspaceId),
      });

      setToast({
        message: `已在新 tab 创建 MR 评审管理 Agent，将由它编排评审并生成飞书文档`,
        variant: "success",
      });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setCreatingReviewManagerAgent(false);
    }
  }

  async function handleCreateTestSubmissionAgent() {
    const targetMeegoUrl = meegoUrl.trim();
    if (
      branchLoading ||
      !targetMeegoUrl ||
      targetMeegoUrl === DEFAULT_MEEGO_URL ||
      testSubmissionCreationInFlight.current
    ) {
      return;
    }

    testSubmissionCreationInFlight.current = true;
    setCreatingTestSubmissionAgent(true);
    setToast(null);
    try {
      const targetMrUrl = mrUrl.trim();

      await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: "codex/gpt-6-astra",
          modeId: "full-access",
          thinkingOptionId: "high",
        },
        title: "根据测试计划补全提测文档",
        labels: { shortcut: "test-submission" },
        prompt: buildTestSubmissionPrompt(
          targetMeegoUrl,
          targetMrUrl === DEFAULT_MR_URL ? "" : targetMrUrl,
        ),
      });

      setToast({ message: "已创建补全提测文档 Agent", variant: "success" });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      testSubmissionCreationInFlight.current = false;
      setCreatingTestSubmissionAgent(false);
    }
  }

  async function handleCreateHuatuoCoverageAgent() {
    const targetMrUrl = mrUrl.trim();
    if (
      branchLoading ||
      !targetMrUrl ||
      targetMrUrl === DEFAULT_MR_URL ||
      huatuoCoverageCreationInFlight.current
    ) {
      return;
    }

    huatuoCoverageCreationInFlight.current = true;
    setCreatingHuatuoCoverageAgent(true);
    setToast(null);
    try {
      await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: "codex/gpt-6-astra",
          modeId: "full-access",
          thinkingOptionId: "high",
        },
        title: "提高华佗测试覆盖率",
        labels: { shortcut: "huatuo-coverage" },
        prompt: buildHuatuoCoveragePrompt(targetMrUrl),
      });
      setToast({ message: "已创建提高华佗测试覆盖率 Agent", variant: "success" });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      huatuoCoverageCreationInFlight.current = false;
      setCreatingHuatuoCoverageAgent(false);
    }
  }

  async function handleSendMrSyncPrompt() {
    const sourceBranch = gitBranch.trim();
    const targetMrUrl = mrUrl.trim();
    if (!sourceBranch || !targetMrUrl || targetMrUrl === DEFAULT_MR_URL || sendingMrSyncPrompt) {
      return;
    }

    setSendingMrSyncPrompt(true);
    setToast(null);
    try {
      await paseo.agents.ref(agentId)
        .send(`请在当前 Workspace 中根据以下 MR 链接同步目标分支的最新代码，并解决产生的冲突：
MR 链接：${JSON.stringify(targetMrUrl)}
当前 Agent 绑定分支：${JSON.stringify(sourceBranch)}

1. 先检查 Git 状态、当前分支、远端配置，以及 MR 的源分支和目标分支。请从 MR 链接或对应代码托管平台读取真实信息，不要根据分支名称猜测。
2. 确认 MR 源分支与当前 Agent 绑定分支一致；如果不一致或无法确认，请停止并说明原因。
3. 不要丢弃、覆盖或暂存无关的现有改动。如果工作区状态导致无法安全同步，请停止并说明原因。
4. 拉取 MR 目标分支的最新远端代码，并将其合并到 MR 源分支。默认使用 merge，不要 rebase 或改写已有历史。
5. 如果产生冲突，请逐项理解双方改动后解决，保留两边仍然需要的业务逻辑；不要简单使用 ours 或 theirs 覆盖。
6. 完成必要的格式检查、类型检查和测试。如果需要完成 merge，可以创建 merge commit。不要推送远端；本次操作只同步本地代码。
7. 最后汇报 MR 源分支和目标分支、同步前后的 commit、冲突文件、解决方式、验证结果、当前 Git 状态，并明确说明本次未推送远端。`);

      setToast({
        message: `已向当前 Agent 发送同步 MR 目标分支指令：${targetMrUrl}`,
        variant: "success",
      });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setSendingMrSyncPrompt(false);
    }
  }

  async function handleSendMainSyncPrompt() {
    const currentBranch = gitBranch.trim();
    if (!currentBranch || sendingMainSyncPrompt) return;

    setSendingMainSyncPrompt(true);
    setToast(null);
    try {
      await paseo.agents.ref(agentId)
        .send(`请在当前 Workspace 中为当前 Git 分支同步远端主分支的最新代码：
当前 Agent 绑定分支：${JSON.stringify(currentBranch)}

1. 先检查 Git 状态、当前分支和远端配置，并确认当前分支与上述绑定分支一致；如果不一致，请停止并说明原因。
2. 从远端 HEAD 或仓库配置确认真实的默认主分支，不要直接假设主分支名称是 main 或 master。
3. 不要丢弃、覆盖或暂存无关的现有改动。如果工作区状态导致无法安全同步，请停止并说明原因。
4. 拉取远端主分支的最新代码。如果当前分支就是主分支，请仅做安全的 fast-forward 更新；否则将最新主分支合并到当前分支。不要 rebase 或改写已有历史。
5. 如果产生冲突，请逐项理解双方改动后解决，保留两边仍然需要的业务逻辑；不要简单使用 ours 或 theirs 覆盖。
6. 完成必要的格式检查、类型检查和测试。如果需要完成 merge，可以创建 merge commit。不要推送远端；本次操作只同步本地代码。
7. 最后汇报当前分支、远端主分支、同步前后的 commit、冲突文件、解决方式、验证结果、当前 Git 状态，并明确说明本次未推送远端。`);

      setToast({
        message: `已向当前 Agent 发送同步主分支指令：${currentBranch}`,
        variant: "success",
      });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setSendingMainSyncPrompt(false);
    }
  }

  async function handleSendBitsPipelinePrompt() {
    const codeDirectory = workspaceDirectory?.trim() ?? "";
    const targetMeegoUrl = meegoUrl.trim();
    const requirementBranch = gitBranch.trim();
    if (
      branchLoading ||
      !codeDirectory ||
      !targetMeegoUrl ||
      targetMeegoUrl === DEFAULT_MEEGO_URL ||
      !requirementBranch ||
      sendingBitsPipelinePrompt
    ) {
      return;
    }

    setSendingBitsPipelinePrompt(true);
    setToast(null);
    try {
      await paseo.agents
        .ref(agentId)
        .send(buildBitsDevTaskPrompt(codeDirectory, targetMeegoUrl, requirementBranch));

      setToast({
        message: "已向当前 Agent 发送创建需求 Bits 流水线指令",
        variant: "success",
      });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setSendingBitsPipelinePrompt(false);
    }
  }

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          padding: layout.compact ? 16 : 24,
          backgroundColor: theme.colors.surface0,
        },
        title: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 18 : 20,
          fontWeight: "600",
        },
        subTitle: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 14 : 16,
          fontWeight: "500",
          marginTop: 12,
          marginBottom: 8,
        },
        infoRow: {
          height: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        infoText: {
          flex: 1,
          color: theme.colors.foreground,
        },
        fieldLabel: {
          flexShrink: 0,
          color: theme.colors.foreground,
          fontSize: layout.compact ? 13 : 14,
        },
        branchInput: {
          flex: 1,
          minWidth: 0,
          height: 40,
          paddingHorizontal: 12,
          paddingVertical: 8,
          color: theme.colors.foreground,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 8,
        },
        iconButton: {
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        iconGlyph: {
          fontSize: 20,
          lineHeight: 22,
        },
        saveGlyph: {
          color: theme.colors.accent,
        },
        cancelGlyph: {
          color: theme.colors.foregroundMuted,
        },
        pressed: {
          opacity: 0.7,
        },
        disabled: {
          opacity: 0.45,
        },
        error: {
          marginTop: 4,
          color: theme.colors.statusDanger,
          fontSize: 12,
        },
        commandButton: {
          marginTop: 4,
        },
      }),
    [layout.compact, theme],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>快捷命令</Text>
      <Text style={styles.subTitle}>当前Agent基本信息：</Text>
      <View style={styles.infoRow}>
        <Text numberOfLines={1} style={styles.infoText}>
          agentId：{agentId}
        </Text>
      </View>
      <View style={styles.infoRow}>
        <Text numberOfLines={1} style={styles.infoText}>
          workspaceId：{workspaceId}
        </Text>
      </View>
      {editingMrUrl ? (
        <View style={styles.infoRow}>
          <Text style={styles.fieldLabel}>MR 链接：</Text>
          <TextInput
            accessibilityLabel="当前 Agent 绑定的 MR 链接"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            keyboardType="url"
            onChangeText={setDraftMrUrl}
            placeholder="请输入 MR 链接"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.branchInput}
            value={draftMrUrl}
          />
          <Pressable
            accessibilityLabel="保存 MR 链接"
            accessibilityRole="button"
            disabled={!draftMrUrl.trim() || !gitBranch.trim() || savingMrUrl}
            onPress={() => void handleSaveMrUrl()}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              (!draftMrUrl.trim() || !gitBranch.trim() || savingMrUrl) && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.saveGlyph]}>
              ✓
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="取消编辑 MR 链接"
            accessibilityRole="button"
            disabled={savingMrUrl}
            onPress={handleCancelEditingMrUrl}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              savingMrUrl && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.cancelGlyph]}>
              ×
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityLabel="编辑当前 Agent 绑定的 MR 链接"
          accessibilityRole="button"
          disabled={branchLoading}
          onPress={handleStartEditingMrUrl}
          style={({ pressed }) => [styles.infoRow, pressed && styles.pressed]}
        >
          <Text style={styles.fieldLabel}>MR 链接：</Text>
          <Text numberOfLines={1} style={styles.infoText}>
            {branchLoading ? "读取中…" : mrUrl}
          </Text>
        </Pressable>
      )}
      {editingMeegoUrl ? (
        <View style={styles.infoRow}>
          <Text style={styles.fieldLabel}>Meego 链接：</Text>
          <TextInput
            accessibilityLabel="当前 Agent 绑定的 Meego 链接"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            keyboardType="url"
            onChangeText={setDraftMeegoUrl}
            placeholder="请输入 Meego 链接"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.branchInput}
            value={draftMeegoUrl}
          />
          <Pressable
            accessibilityLabel="保存 Meego 链接"
            accessibilityRole="button"
            disabled={!draftMeegoUrl.trim() || !gitBranch.trim() || savingMeegoUrl}
            onPress={() => void handleSaveMeegoUrl()}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              (!draftMeegoUrl.trim() || !gitBranch.trim() || savingMeegoUrl) && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.saveGlyph]}>
              ✓
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="取消编辑 Meego 链接"
            accessibilityRole="button"
            disabled={savingMeegoUrl}
            onPress={handleCancelEditingMeegoUrl}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              savingMeegoUrl && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.cancelGlyph]}>
              ×
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityLabel="编辑当前 Agent 绑定的 Meego 链接"
          accessibilityRole="button"
          disabled={branchLoading}
          onPress={handleStartEditingMeegoUrl}
          style={({ pressed }) => [styles.infoRow, pressed && styles.pressed]}
        >
          <Text style={styles.fieldLabel}>Meego 链接：</Text>
          <Text numberOfLines={1} style={styles.infoText}>
            {branchLoading ? "读取中…" : meegoUrl}
          </Text>
        </Pressable>
      )}
      {editingBranch ? (
        <View style={styles.infoRow}>
          <Text style={styles.fieldLabel}>git branch：</Text>
          <TextInput
            accessibilityLabel="当前 Agent 绑定的 Git 分支"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={setDraftBranch}
            placeholder="请输入绑定的 Git 分支"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.branchInput}
            value={draftBranch}
          />
          <Pressable
            accessibilityLabel="保存 Git 分支绑定"
            accessibilityRole="button"
            disabled={!draftBranch.trim() || savingBranch}
            onPress={() => void handleSaveBranch()}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              (!draftBranch.trim() || savingBranch) && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.saveGlyph]}>
              ✓
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="取消编辑 Git 分支"
            accessibilityRole="button"
            disabled={savingBranch}
            onPress={handleCancelEditing}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              savingBranch && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.cancelGlyph]}>
              ×
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityLabel="编辑当前 Agent 绑定的 Git 分支"
          accessibilityRole="button"
          disabled={branchLoading}
          onPress={handleStartEditing}
          style={({ pressed }) => [styles.infoRow, pressed && styles.pressed]}
        >
          <Text style={styles.fieldLabel}>git branch：</Text>
          <Text numberOfLines={1} style={styles.infoText}>
            {branchLoading ? "读取中…" : gitBranch || "点击设置绑定分支"}
          </Text>
        </Pressable>
      )}
      {branchError ? <Text style={styles.error}>{branchError}</Text> : null}
      <Text style={styles.subTitle}>指令：</Text>
      <Button
        accessibilityLabel="向当前 Agent 发送同步主分支最新代码的指令"
        disabled={branchLoading || !gitBranch.trim()}
        label="同步主分支"
        loading={sendingMainSyncPrompt}
        loadingLabel="正在发送指令…"
        onPress={() => void handleSendMainSyncPrompt()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="向当前 Agent 发送同步 MR 目标分支并解决冲突的指令"
        disabled={
          branchLoading || !gitBranch.trim() || !mrUrl.trim() || mrUrl.trim() === DEFAULT_MR_URL
        }
        label="同步 MR 目标分支"
        loading={sendingMrSyncPrompt}
        loadingLabel="正在发送指令…"
        onPress={() => void handleSendMrSyncPrompt()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="创建 Agent 提交并推送当前代码"
        disabled={branchLoading || !gitBranch.trim()}
        label="提交并推送当前代码"
        loading={creatingPushAgent}
        loadingLabel="正在创建 Agent…"
        onPress={() => void handleCreatePushAgent()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="向当前 Agent 发送创建需求 Bits 开发任务并运行流水线的指令"
        disabled={
          branchLoading ||
          !workspaceDirectory?.trim() ||
          !gitBranch.trim() ||
          !meegoUrl.trim() ||
          meegoUrl.trim() === DEFAULT_MEEGO_URL
        }
        label="创建需求 Bits 流水线"
        loading={sendingBitsPipelinePrompt}
        loadingLabel="正在发送指令…"
        onPress={() => void handleSendBitsPipelinePrompt()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="创建 GPT 管理 Agent 编排评审当前 MR 并生成飞书文档"
        disabled={
          branchLoading || !gitBranch.trim() || !mrUrl.trim() || mrUrl.trim() === DEFAULT_MR_URL
        }
        label="评审当前 MR"
        loading={creatingReviewManagerAgent}
        loadingLabel="正在创建管理 Agent…"
        onPress={() => void handleCreateReviewManagerAgent()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="创建 Agent 根据测试计划补全提测文档"
        disabled={branchLoading || !meegoUrl.trim() || meegoUrl.trim() === DEFAULT_MEEGO_URL}
        label="根据测试计划补全提测文档"
        loading={creatingTestSubmissionAgent}
        loadingLabel="正在创建 Agent…"
        onPress={() => void handleCreateTestSubmissionAgent()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="创建 Agent 提高华佗测试覆盖率"
        disabled={branchLoading || !mrUrl.trim() || mrUrl.trim() === DEFAULT_MR_URL}
        label="提高华佗测试覆盖率"
        loading={creatingHuatuoCoverageAgent}
        loadingLabel="正在创建 Agent…"
        onPress={() => void handleCreateHuatuoCoverageAgent()}
        style={styles.commandButton}
        theme={theme}
      />
      <Toast
        compact={layout.compact}
        message={toast?.message ?? ""}
        onDismiss={() => setToast(null)}
        theme={theme}
        variant={toast?.variant ?? "success"}
        visible={toast !== null}
      />
    </View>
  );
}
