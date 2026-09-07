# omp-agents extension: Claude agent MD → oh-my-pi agents

## Goal

新增 skillshare 参考扩展 `extensions/omp-agents/`，把 Claude 风格的 Markdown subagent（frontmatter + body）转换为 oh-my-pi（OMP）的 task agent 格式，作为与 `extensions/codex-agents` 同级的参考扩展，并在用户级（`~/.omp/agent/agents/`）与项目级（`.omp/agents/`）两种目标下可用。

## Background（仓库证据）

- OMP agent 定义本身就是 Markdown：frontmatter 必需 `name`、`description`，正文即 system prompt；可选 `model`、`tools`（CSV 或数组）、`spawns`、`thinking-level` 等字段。来源：`oh-my-pi/docs/task-agent-discovery.md`（"Agent definition shape"、`parseAgentFields()`，实现于 `src/discovery/helpers.ts`）。
- 发现路径：项目级 `.omp/agents/*.md`（覆盖用户级），用户级 `~/.omp/agent/agents/*.md`；`.claude/agents`、`.codex/agents` 等跨 harness 目录被有意跳过——因此需要一个写入 `.omp` 目标的扩展。同文档 "Filesystem and discovery" 节。
- 未知 frontmatter key 不致命：解析失败仅当缺 `name` 或 `description`；坏文件跳过、不中断发现。因此透传不会因多余字段失败，缺字段的文件由 OMP 侧跳过。
- skillshare 扩展契约：`extension.yaml`（`run` / `output_ext` / `description`）+ stdin→stdout 转换脚本；`SS_REL_PATH` 提供相对路径。来源：`extensions/README.md`、`skills/skillshare/references/extras.md`。
- `output_ext` 省略时保留源扩展名（`.md`），符合 Markdown→Markdown 场景。
- 用户级/项目级由 extras targets 的两个 `path` 表达（`~/.omp/agent/agents` 与 `.omp/agents`），扩展本身同一份即可；扩展目录本身也同时支持项目级 `.skillshare/extensions/` 与全局 `~/.config/skillshare/extensions/`。
- 文档先例（codex-agents 出现处，需同步新增 omp-agents）：
  - `skills/skillshare/references/extras.md`（"Official extensions" 表）
  - `website/docs/reference/commands/extras.md`（"Recipe: Codex agents" 同级的 recipe 章节）
- 文件约定：输出与源文件统一 LF 换行、UTF-8 编码（无 BOM）。

## Requirements

- R1 新建 `extensions/omp-agents/`：`extension.yaml` + `convert.js` + 复用的 Markdown 帮助库（按 codex-agents 的 `md-toml.js` 模式提供 `md-agent.js` 或等效物）。
- R2 `extension.yaml`：`run: ["node", "convert.js"]`，省略 `output_ext`（保持 `.md`），description 说明目标格式。
- R3 `convert.js` 容错转换，任何输入都不以错误退出：
  - `name` 缺省时回退为文件名 stem（`SS_REL_PATH` 派生）；
  - `description`、body 缺省时原样输出（空即空）；OMP 侧对缺 `description` 的文件仅跳过并告警，不中断发现；
  - 所有 frontmatter 字段（含未识别 key）与 body 透传，值不变。
- R4 输出规范：LF 换行、UTF-8 无 BOM；末尾单个换行。
- R5 文档同步（不改 `extensions/README.md`）：
  - `skills/skillshare/references/extras.md` "Official extensions" 表加一行；
  - `website/docs/reference/commands/extras.md` 新增 "Recipe: oh-my-pi agents"，示例 extras config 同时展示用户级与项目级两个 target。

## Out of Scope

- 不做 Claude model 别名（`sonnet`/`opus`/`haiku`）到 OMP selector 的映射：OMP 对无法解析的 model 项回退父会话模型，透传安全；需要路由时用户应在 source 里写 `@role` 或 `provider/model`。
- 不修改 `extensions/README.md`（用户决定）。
- 不修改 skillshare Go 代码（扩展机制已完备）。
- 不改动 oh-my-pi 仓库。
- 不新增测试文件：参考扩展的验证方式是仓库既有的本地管道测试命令（见验收标准）。

## Acceptance Criteria

- [ ] `extensions/omp-agents/extension.yaml` 存在且 `run` 指向 `node convert.js`，无 `output_ext`。
- [ ] 管道测试通过：`printf '%s\n' '---' 'name: reviewer' 'description: Review changes' '---' 'Review the change.' | SS_REL_PATH=reviewer.md node extensions/omp-agents/convert.js` 输出合法 OMP agent Markdown：frontmatter 含 `name`、`description`，正文保留，LF 换行、UTF-8 无 BOM、文件以单个换行结尾。
- [ ] 缺 `name` 的输入（`SS_REL_PATH=reviewer.md`）退出码 0，frontmatter `name` 回退为 `reviewer`。
- [ ] 缺 `description` 或空 body 的输入退出码 0，内容原样透传，不报错。
- [ ] 含额外 frontmatter 字段（如 `tools: read, grep`、`model: "@review"`）的输入透传后字段值不变。
- [ ] `skills/skillshare/references/extras.md` 与 `website/docs/reference/commands/extras.md` 均含 omp-agents 条目/recipe，recipe 覆盖用户级与项目级两个 target path；`extensions/README.md` 无改动。
