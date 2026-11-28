# 个人智能体助理需求规格说明书

本文档基于《AI Agents in Depth》（`AI-Agents-in-Depth-zh-CN.pdf`）第 1 至 10 章的工程原则，结合个人使用场景逐章讨论定稿，作为基于 `pi` 二次开发个人智能体助理的总需求与架构基线。

---

## 0. 全局定位与分期总览

### 0.1 核心定位

- **产品形态**：Windows 本机常驻的个人智能体助理，基于当前仓库 `pi`（TypeScript）做二次开发，交互入口直接复用 `pi` 终端 TUI（不做 Web UI，纯文字输入）。
- **核心架构原则**：遵循 `Agent = Model + Harness`（上下文管理 + 工具接口 + 约束 + 验证 + 纠正）与全书五大设计模式（提议者-审核者、渐进式披露、只增不改、边界集+保留集、最小 diff + 可回滚）。
- **模型配置**：
  - 主决策模型：DeepSeek API（推理/思考模式）。
  - 多模态视觉模型：云端视觉 API（通过工具按需调用）。
  - 本地辅助模型（Ollama）：`bge-m3`（稠密嵌入）、本地 Reranker（如 `bge-reranker-v2-m3`）、轻量 Sidecar 风控模型。
  - 评估 Judge 模型：非 DeepSeek 的异源云端模型（防范同源偏见）。

### 0.2 分期路线图

| 阶段 | 覆盖范围 |
|---|---|
| **一期（MVP 核心）** | 场景 A（信息与知识管理、上千篇 Markdown/PDF 笔记整理）与场景 B（本地效率与数据处理自动化）；单 Agent + Skills；多会话隔离；`<agent_status>` 状态栏与可见 TODO；三层压缩与保真机制；三层分离目录 + 双层记忆 + 本地 Ollama 混合 RAG；极简核心工具 + 联网搜索 + 云端视觉分析工具；四层执行安全（目录边界、写前快照/Git 回滚、写后自动校验、两段式确认、本地 Ollama Sidecar）+ Windows Docker 沙箱；默认交付单文件交互式 HTML；`doctor` 自检与脚本沉淀为 Skill；会话内异步（安全打断、补充入队、`monitor_shell`）；RAG 召回率评估 + 端到端/轨迹前缀回归集 + 异源 Judge + 本地 Trace/成本/缓存统计 + `/feedback` + 消融开关；手动 `/evolve` 离线持续进化闭环。 |
| **二期（扩展演进）** | 场景 C（日常事务协同：邮件/日程/IM 远程渠道）；场景 D（外部网页/App 自动化：Playwright DOM/SoM + HITL Auth）；本地轻事件源（目录监听自动建索引、Cron 定时任务、Windows 桌面通知）；长期修剪体检（Curator）；多 Agent 协作（星型管理者只读调研子 Agent、HTML 渲染截图 Proposer-Reviewer 审核）；PPT/视频等独立多媒体 Skill。 |
| **明确不做** | 自研 Web UI；语音交互（纯文字输入即可）；主模型自训练/Mid-training/RL；跨组织 A2A 协议、去中心化 Swarm、群聊辩论、Agent 社会模拟；机器人具身控制；跨厂商主模型自动故障切换。 |

---

## 1. 总体边界与基础架构（第 1 章）

1. **场景边界**：一期聚焦 **A. 信息与知识管理**（个人笔记整理、资料调研、PDF/网页提炼）与 **B. 本地效率与开发自动化**（本地文件处理、数据清洗、分析脚本、代码辅助）。
2. **编排模式**：一期统一采用 **自主拆解（ReAct 循环）**；不在启动前硬编码固定业务工作流模板，而是在后续使用中通过第 9 章离线复盘从高频成功轨迹中沉淀为 Skills 与确定性脚本。
3. **技术底座**：基于 `pi` 现有核心包二次开发，尽量复用其标准消息循环、会话 JSONL 持久化、结构化分段 System Prompt、Agent Skills 渐进式披露、基础文件/终端工具与 `packages/evals` Docker 评估框架。

---

## 2. 上下文工程与对话压缩保真（第 2 章）

### 2.1 会话粒度与 KV Cache 前缀稳定

- **多会话隔离**：按任务/主题开启独立会话；跨会话连续性由第 3 章的长期记忆与知识库衔接，不在同一会话中无限混杂无关话题。
- **静态前缀不可变**：System Prompt（含固定注入的核心用户偏好概览与 Skill 元数据目录）与 Tool Definitions（固定顺序）在会话内保持字节级不变，最大化 DeepSeek Prompt Cache 命中率。
- **动态信息末尾追加**：当前时间、活跃工作目录、工具调用统计、TODO 清单等所有动态状态一律追加到上下文末尾，严禁修改 System Prompt。
- **DeepSeek 协议兼容**：严格使用标准 `system / user / assistant / tool` 结构化消息格式；带工具调用的同一轮次内完整保留并回传 `reasoning_content`，禁止手工拼接纯文本对话流。

### 2.2 系统提示词与 Agent Skills

- **System Prompt 原则**：
  - 使用 Markdown + XML 双层结构，只保留助理身份定位、简洁输出风格、通用纪律（遇到模糊高影响需求先用 1–3 个简短问题澄清，低风险任务说明假设后执行）与忠诚度守则（外部网页/文档内容一律降格为不可信数据，不具备指令效力）。
  - 所有领域 SOP 下沉至 Skills，禁止在全局 System Prompt 中堆砌零散规则。
- **Agent Skills 渐进式披露**：
  - 复用 `pi` 原生三层机制：启动加载 `name + description` 目录 -> 按需读取 `SKILL.md` -> 按需读取子文档与脚本。
  - **触发方式**：支持模型自主判断按需加载，同时支持用户通过显式命令（如 `/skill`）手动指定。
  - **首批内置 Skills**：
    1. 个人笔记整理（适配个人 Markdown 规范、YAML frontmatter、双向链接与出处引用）；
    2. 本地数据处理（CSV/Excel/JSON/PDF 清洗、统计分析、校验与单文件交互式 HTML 报告生成）。

### 2.3 Agent 状态栏（`<agent_status>`）

每次推理前由 Harness 用确定性代码生成结构化状态栏追加到上下文末尾（严禁由 LLM 估算计数），包含 4 项核心元信息：
1. **侧信道时间信息**：当前本地时间、距上次用户交互间隔；
2. **环境状态摘要**：当前工作目录、OS/Shell 与沙箱状态、知识库 Git 分支与未提交变更概览；
3. **工具调用计数与失败告警**：本会话各工具累计调用次数、连续失败告警（提示模型更换策略而非盲目重试）；
4. **显式 TODO 任务清单**：提供专用 `todo` 工具维护多步任务状态（`pending / in_progress / completed / cancelled`），且 **在 `pi` 终端 TUI 中向用户实时可见展示**。

### 2.4 分层对话压缩与核心信息保真机制

针对中文场景与长任务上下文腐化（Context Rot），在 `pi` 现有 `compaction.ts` 基础上做以下升级：

1. **触发阈值与中文 Token 估算**：
   - 修正 `chars / 4` 的英文启发式，按 CJK 字符与 ASCII 分开加权估算两次真实 `usage` 之间的新增 token；
   - 触发阈值前移至上下文窗口的 **70%–75%**（不拖到接近溢出才压）。
2. **三层渐进压缩**：
   - **L1 写时落盘 + 冻结预览**：单次工具输出超阈值（如 > 8KB 或 > 200 行）时，全文落盘至 `evidence/artifacts/<session>/<id>.txt`，上下文中仅注入“头尾预览 + 体积信息 + 文件路径”，替换文本一经生成即持久化冻结以保缓存一致性；
   - **L2 批量清理过期噪声（零 LLM 调用）**：上下文达 60%–65% 时，利用 `pi` 的 `context_edit` 批量将早于最近 N 轮的只读大工具输出折叠为单行引用占位符；
   - **L3 任务感知结构化摘要（LLM 调用）**：L2 后仍超 75% 时触发，将当前活跃 TODO 与用户目标注入压缩提示词；压缩调用使用同级别主模型，连续失败 **2 次即触发熔断**（停止自动循环，降级截断并提示用户）。
3. **不依赖纯提示词的保真四件套**：
   - **核心状态外置（不进入摘要改写）**：代码确定性采集 `SourceIndex`（已读/改文件、访问 URL、PDF 页码、落盘 artifact 路径、失败命令与错误码），配合显式工具维护的 TODO、硬约束与落盘工作文档（如 `plan.md`），压缩时不经 LLM 改写，压缩后原样重新挂载；
   - **不可压缩锚点（Pin 机制）**：支持将首轮核心需求、关键模板或用户纠正消息标记为 `pinned`，压缩切分时强制保留原文；
   - **结构化槽位 + 强制出处 + 失败路径**：摘要必须包含 `Goal / Constraints / Decisions / Failed Attempts / Next Steps`，并由代码强挂载精确出处索引（文件路径、PDF 页码、URL）；
   - **无损原文 + 按需回查 + 人类可见**：原始会话 JSONL 永不物理删除；提供只读工具 `search_session_history(query)` 供模型回查归档轮次；压缩生成的检查点对用户可见且可手动修正。

---

## 3. 用户记忆与个人知识库（第 3 章）

### 3.1 三层分离目录架构

面向 1000+ 篇 Markdown 与 PDF 个人资料，采用本地文件化三层分离设计，不依赖外部重型数据库服务：

```text
assistant-workspace/
├── evidence/                     # 1. 原始证据层（只增不改，原始素材与轨迹）
│   ├── sessions/                 #    pi 原始会话 JSONL 轨迹
│   ├── raw_pdfs/                 #    原始 PDF（只读保护）
│   └── artifacts/                #    网页快照、大工具输出落盘文件
├── knowledge/                    # 2. 知识层（唯一真相源，纳入 Git 版本管理）
│   ├── memory/
│   │   ├── profile/              #    Layer 1：基础回忆（YAML 结构化偏好卡片）
│   │   └── events/               #    Layer 2：多会话情景日志（按月 YYYY-MM.jsonl，只增不改）
│   ├── experience/               #    行动经验文档（第 9 章沉淀）
│   └── notes/                    #    个人 Markdown 笔记 + PDF 提炼笔记
│       ├── _index.md             #    目录入口索引与 L0/L1 概览
│       └── ...
└── index/                        # 3. 检索服务层（.gitignore 排除，可随时全量重建）
    ├── fts.sqlite                #    SQLite FTS5 中文分词 BM25 倒排索引
    ├── vectors.db                #    本地向量索引（sqlite-vec 或 LanceDB）
    └── manifest.json             #    文件 sha256 与 mtime，用于秒级增量更新
```

### 3.2 双层记忆存储格式（一期目标：Layer 1 基础回忆 + Layer 2 多会话检索）

1. **Layer 1 基础回忆：`knowledge/memory/profile/*.yaml`**
   - 借鉴 Advanced JSON Cards，强制包含适用范围 `scope`、背景 `backstory`、确认状态与来源引用 `evidence_refs`，防止跨场景误用：
     ```yaml
     id: pref-csv-export-encoding
     category: workflow.data_processing
     key: csv_export_encoding
     value: "导出供 Excel 打开的中文 CSV 默认使用 UTF-8-BOM，金额保留两位小数"
     scope: "仅限 CSV 导出，不适用于代码文件与 JSON"
     status: active                # active | superseded | deprecated
     confidence: confirmed         # confirmed | inferred
     backstory: "处理财务报表时遇到 Excel 打开 UTF-8 CSV 中文乱码"
     evidence_refs:
       - session: "2026-11-20-csv-clean"
         turn: 3
     created_at: "2026-11-20T14:10:00+08:00"
     updated_at: "2026-11-20T14:10:00+08:00"
     ```
   - **注入策略**：新会话启动时仅将 `status: active` 且 `confidence: confirmed` 的条目渲染为精简 `<user_profile>`（预算 ≤ 1–2K token）放入静态前缀固定区。

2. **Layer 2 多会话检索：`knowledge/memory/events/YYYY-MM.jsonl`**
   - 遵循 Mem0 v3 只增不改（ADD-only）原则，保留完整时间线与显式取代链，避免错误覆写丢失历史：
     ```json
     {
       "id": "evt-20261126-004",
       "session_id": "2026-11-26-note-refactor",
       "timestamp": "2026-11-26T21:30:00+08:00",
       "topic": "个人笔记库目录重组",
       "entities": ["Markdown", "PDF归档", "三层分离"],
       "context_prefix": "[2026-11-26 会话: 个人笔记库目录重组 | 实体: Markdown, PDF归档]",
       "summary": "决定原始 PDF 放 evidence/raw_pdfs/ 只读保留，提炼笔记放 knowledge/notes/ 并保留页码出处。",
       "decisions": ["采用三层分离架构", "检索索引作为可重建派生物"],
       "open_items": ["确定 PDF 扫描件处理方案"],
       "artifacts": ["knowledge/notes/system/note-layout.md"],
       "supersedes": null,
       "evidence_ref": "evidence/sessions/2026-11-26-note-refactor.jsonl#L120-L185"
     }
     ```
   - **冲突处理**：后续会话推翻旧结论时不删旧记录，而是追加新记录并通过 `supersedes` 指向旧记录 ID；检索返回时自动标注 `[已于 YYYY-MM-DD 被 evt-xxx 更新]`。

### 3.3 1000+ Markdown & PDF 的 RAG 切分与混合检索细则

1. **解析与清洗**：
   - **Markdown**：保留 YAML frontmatter（title/tags/date/aliases）、完整标题层级树（`H1 -> H2 -> H3`）与双链 `[[...]]`。
   - **PDF**：按页提取文本与标题结构，表格尽量转 Markdown 表格，严格保留精确页码区间 `page_range: [start, end]`；通过跨页首尾行高频重复检测剔除页眉/页脚/页码噪声；单页有效字符过低（如 < 50 且含大图）时识别为扫描件，标记并走视觉/OCR 通道，不将空文本或乱码入库。
2. **结构感知递归切分（Chunking）**：
   - **边界优先级**：Markdown 按 `H1 -> H2 -> H3 -> 空行段落 -> 句子` 递归切分；PDF 优先识别章节与自然段，合并被分页符打断的同一句子并同时记录跨页 `page_range`。
   - **原子块保护**：代码块、Markdown 表格、公式块禁止从中间切断（允许单块放宽上限至 1200 tokens）。
   - **尺寸与重叠**：目标 **350–600 tokens**（约 450–800 中文字），常规上限 800 tokens；同章节内相邻块保留 **15%（约 80–120 字）重叠**，跨大章节不重叠；< 80 字的碎片自动与同级相邻段合并。
3. **两级上下文感知前缀（Contextual Retrieval）**：
   - **L1 确定性结构前缀（全量强制，零 LLM 成本）**：入索引前统一拼接 `[文档: {title} | 路径: {rel_path} | 章节: {h1 > h2 > h3} | 页码: {page_range} | 标签: {tags} | 更新: {date}]`。
   - **L2 LLM 语义前缀（可选增强）**：针对无标题长 PDF 或杂乱摘录，可调用本地 Ollama 轻量模型补 1–2 句背景说明。
   - **增量更新**：基于 `manifest.json` 的 `sha256` 比对，仅重算新增或变动文件。
4. **基于本地 Ollama 的混合检索流水线**：
   - **双路索引**：稀疏路采用 SQLite FTS5 + 中文分词器（如 jieba/simple 分词插件）；稠密路采用本地 Ollama `bge-m3` 嵌入存入本地向量库。
   - **检索步骤**：
     1. 元数据预过滤（按 `source_type`、目录、标签、时间区间，可选）；
     2. 双路并行召回：BM25 Top-30 + 向量 Top-30；
     3. RRF 融合（`k = 60`，默认权重 `0.5 / 0.5`；含精确路径/代码/引号短语时提高 BM25 权重如 `0.7 / 0.3`），取 Top-25 候选池；
     4. 本地交叉编码器精排（如 `bge-reranker-v2-m3`），截断输出 **Top-6 至 Top-8**；
     5. 合并同文档相邻命中块，强制附带 `path`、`section`、`page_range` 与上下文摘要；需要全文时由模型按需调用 `read`。
5. **Agentic RAG 工具接口**：
   - `search_knowledge(query, type?, dir?, tags?, top_k?)`
   - `search_memory(query, time_range?, entities?, top_k?)`
   - `browse_knowledge_index(dir?)`（读取目录级 L0/L1 概览 `_index.md`）

### 3.4 更新审批与隐私范围

- **分级更新策略**：Layer 2 情景事件日志（只增不改）会话结束自动追加；修改 Layer 1 核心偏好或已有 Markdown 笔记正文时，写入工作分支/草稿区并经人工确认后合入 Git 主分支（随时可回滚）。
- **隐私脱敏**：本期暂不启用自动隐私目录隔离与脱敏流水线。

---

## 4. 工具体系、多模态感知与执行安全（第 4 章）

### 4.1 能力表达与一期核心工具集

遵循“**通用执行器 + Skills 优先，必要时退回专用工具**”与“**参数严格保真（严禁静默转义引号、改编码或私自追加参数）**”原则：

- **复用 `pi` 核心工具**：`read`（支持 offset/limit 与显式截断提示）、`grep`、`find`、`ls`、`write`、`edit`、`bash`（及容器化执行器）。
- **新增专用工具**：
  - 上下文与状态：`todo`、`search_session_history`
  - 知识与记忆：`search_knowledge`、`search_memory`、`browse_knowledge_index`
  - 外部调研：`web_search`、`fetch_url`（结果走 L1 落盘 + `<external_content source="...">` 来源包裹）
  - 多模态感知：`analyze_visual(file_path, question, page?)`（针对 PDF 复杂图表/扫描页/截图，内部调用**云端视觉 API**，仅返回针对问题的精炼文本分析，不将原图塞满 DeepSeek 主上下文）
  - 人工协作：`request_human_approval` / `request_human_input`（暂停等待人工确认，并留存批准/拒绝理由供第 9 章进化学习）
- **数据处理边界**：CSV/Excel/JSON/PDF 批量清洗与统计不拆成一堆专用工具，统一由 Agent 在 Docker 沙箱内写 Python 脚本执行 + 配合“数据处理 Skill”。

### 4.2 外部生态扩展策略

- **CLI + Skills 优先**：自定义能力优先封装为本地脚本/CLI + `SKILL.md`。
- **MCP 按需代理接入**：保留 `pi` 的 MCP 扩展能力，但必须采用 **延迟启动 + 代理工具按需发现**（会话启动只暴露轻量索引，按需将目标工具 schema 追加到轨迹末尾），防止静态前缀膨胀与 KV Cache 失效。
- **供应链门槛**：接入任何第三方 Skill 或 MCP 前必须人工审查其描述与脚本内容并锁定版本，禁止静默自动更新。

### 4.3 四层执行安全与可回滚设计（一期全量落地）

摒弃粗放的静态权限标签，按“**作用边界 + 可逆性/自动回滚 + 执行后验证 + 独立旁路风控**”构建四层防线：

1. **层 1：输入校验与目录边界**
   - 所有文件工具执行路径规范化校验（防 `../` 路径穿越）；
   - 严格区分 **只读区**（`evidence/raw_pdfs/` 与历史原始轨迹，严禁写删）、**受控读写区**（`knowledge/` 与指定任务工作目录）、**未授权区**（宿主机其余路径默认拒绝）。
2. **层 2：可逆变更的写前快照 + 写后自动验证**
   - **写前可回滚点**：修改 `knowledge/` 走 Git 工作分支/commit；修改非 Git 本地数据目录前，自动将原文件备份至 `.pi/backups/<session>/<ts>/`，支持一键恢复；
   - **写后自动验证闭环**：写/改 Python 或 TypeScript 文件后自动执行语法检查/Linter；写/改 Markdown 笔记后自动校验 YAML frontmatter 语法与双链引用合法性，将结构化报错直接随工具结果返回模型立即自修。
3. **层 3：不可逆 / 越界 / 破坏性操作两段式确认**
   - 删除文件、覆盖原始数据、高危 Shell 命令或越界访问，必须先展示精确命令、受影响文件清单或 diff 预览，经人工批准后方可执行。
4. **层 4：本地 Ollama Sidecar 旁路风控（一期同步落地）**
   - 在执行高风险工具（特别是 Shell/容器外命令与写入）前，调用本地 Ollama 轻量模型并行做独立安全审查；
   - **严格上下文隔离**：Sidecar 仅接收结构化调用数据 `{tool, args, target_scope}`，**绝不读取主模型的自由对话与外部网页文本**，防止被间接提示注入话术策反；
   - 结合命令语义解析拦截变形危险命令（如 `find -exec rm`、`$(echo rm)`、`curl -o`）；连续被 Sidecar 拒绝触发熔断，交还人工裁决。

---

## 5. Coding Agent、Windows Docker 沙箱与交付规范（第 5 章）

### 5.1 Windows + Docker 代码执行沙箱

- **隔离形态**：代码执行与本地数据处理默认统一在 **Windows Docker 容器沙箱** 内运行（预构建含 `pandas`、`openpyxl`、`pymupdf`、`duckdb`、`sympy`、`matplotlib` 等常用库的数据分析镜像），绝不把 `python venv` 当作沙箱。
- **四条硬边界**：
  1. **挂载隔离**：`evidence/` 以只读卷挂载；仅挂载独立的任务可写工作区；宿主机 `~/.ssh`、系统敏感目录及环境变量中的 API Key/Token **绝不挂载或注入沙箱**；
  2. **网络出口默认断网**：容器默认 `--network=none`（切断“读私密数据 -> 注入外传”闭环），仅在人工明确授权时按需开放受控网络；
  3. **资源与超时护栏**：严格限制容器 CPU、内存、磁盘配额与单命令超时；超时时返回结构化错误及截断的最后输出，不静默杀死；
  4. **Windows 路径与编码规范**：统一在工具边界处理 Windows 宿主机路径与 Linux 容器卷路径的双向映射、UTF-8 编码与换行符一致，严禁向模型静默篡改内容。

### 5.2 代码作为元能力与验证闭环

- **禁止心算与手抄数据**：涉及计数、统计聚合、金额/日期计算、批量清洗时，强制在沙箱编写并运行 Python 脚本，不依赖 LLM 自然语言推算或抄写大表格。
- **验证驱动完成**：脚本写完不等于完成，必须实际运行并通过数据核对断言（行数、编码、空值、目标产物可读）才可交付。
- **代码化规则守门**：笔记格式校验、CSV 编码与精度检查等高频硬规则做成确定性校验脚本，写入最终产物前自动守门。

### 5.3 故障恢复策略

- 保留四层故障防护：**流式空闲看门狗（Watchdog）** 防流式静默卡死、瞬态 429/网络异常指数退避静默重试、**重复调用指纹检测** 防无进展死循环、**防死亡螺旋**（异常退出路径禁止再触发调 LLM 的后台钩子）。
- **主模型不可用策略**：DeepSeek API 持续报错或限流重试耗尽后，**直接暂停并向用户明确报告错误与已尝试恢复动作**，不做跨厂商自动模型接管。

### 5.4 交付物、自检与工具沉淀

- **交付物默认形态**：复杂数据分析与调研汇报 **默认生成可本地浏览器直接打开的单文件交互式 HTML 报告**（由脚本直接将数据注入图表与可筛选表格，绕过 LLM 抄数），同时保留处理后的数据文件与 Markdown 笔记；PPT/视频制作等能力不内置，后续按独立 Skill 按需扩展。
- **一期内置两项自举/运维能力**：
  1. **`doctor` 自检命令**：确定性检查 DeepSeek API、云端视觉 API、本地 Ollama（`bge-m3` / Reranker / Sidecar 模型）、Docker 引擎与沙箱镜像、知识库 Git 状态及本地索引完整性；疑难日志可交由 Agent 辅助诊断；
  2. **脚本沉淀为 Skill/工具**：跑通的高频数据处理脚本支持按指令整理为参数化脚本 + `SKILL.md`，经人工确认后归档复用。

---

## 6. 交互与异步运行时（第 6 章）

1. **一期：仅会话内异步（纯文字 TUI）**
   - **取消式打断（紧急）**：用户触发中止时，立刻取消流式推理或沙箱进程，并在轨迹中为未完成工具写入显式占位符（如 `[工具已被用户中断，未完成]`，严禁伪造成功），维持同步 API 格式合法；
   - **队列式补充（常规）**：工具执行期间用户补充输入时先入队，待到达安全点（工具返回）后连同工具结果按 `[未处理事件 i/N]` 编号批量追加，防模型只看最后一条；
   - **后台长命令监控**：提供 `monitor_shell` 异步监控长耗时容器命令，仅在完成、报错或命中关键输出时唤醒模型，避免轮询烧 token。
2. **二期预留**：
   - 本地轻事件源（目录监听自动增量建 RAG 索引、Cron 定时任务、Windows 桌面 Toast 通知）；
   - 远程 IM/邮件多渠道（随场景 C）；
   - 网页/GUI 自动化（随场景 D）：遵循 **Playwright + DOM/无障碍树（SoM 结构化元素索引）** 优先，需要个人账号登录时强制 **人工接管登录（HITL Auth）** 复用会话令牌，不向 Agent 暴露明文密码。
3. **明确不做**：语音交互、机器人具身控制。

---

## 7. 评估体系与本地可观测性（第 7 章）

### 7.1 本地 RAG 混合检索召回率评估（一期标配验收）

- **黄金评测集**：从个人 1000+ Markdown/PDF 中抽样构建 **30–50 条真实查询**，覆盖 4 类难例：
  1. 精确术语/路径/代码符号（测 BM25）；
  2. 模糊概念/同义表达（测 `bge-m3` 语义）；
  3. 跨页/含指代的 PDF 片段（测切分 + 上下文前缀）；
  4. 跨会话冲突记忆（测 Layer 2 `events/` 时间与 `supersedes` 排序）。
- **验收指标与消融**：确定性脚本自动输出 **`recall@5`、`recall@10`、`MRR`、`nDCG@10`、检索失败率（未进 Top-20）与延迟**，一键跑通四组消融对照（纯 BM25 / 纯向量 / 混合 RRF / 混合 + Rerank），用实测数据定参数。

### 7.2 两层 Agent 回归评估集（复用 `packages/evals` Docker 环境）

1. **端到端回归集（初期 15–20 题）**：覆盖场景 A（整理笔记、补双链、留 PDF 页码出处）与场景 B（沙箱清洗数据、硬规则校验、生成单文件 HTML 报告），每次运行前重置容器环境，优先采用确定性代码断言终态。
2. **轨迹前缀边界集（初期 10–15 题）**：冻结历史上下文到关键决策点，验证下一步动作落在“可接受动作集合”且未触发“禁止动作”，重点覆盖：模糊需求先澄清、压缩后硬约束不丢、当前显式指令覆盖旧偏好、高危/越界操作触发确认。
3. **指标口径与评判机制**：
   - 常规能力看 `Pass@1`；安全与核心纪律（不改只读区、不伪造出处）看 **`Pass^3`（连续 3 次 0 失误）**；
   - **评判分工**：能代码断言的绝不用 LLM；开放质量维度（摘要清晰度、HTML 可读性等）采用 **多维度 Rubric + 幻觉一票否决（Veto）**，由 **非 DeepSeek 的异源模型担任 LLM-as-a-Judge**。

### 7.3 本机可观测性、成本护栏与失败回流

- **本地 Trace 账本**：记录每次会话与调用的输入/输出/思考 token、**DeepSeek Prompt Cache 命中率**、单轮与总耗时、工具成功率、RAG 召回明细、Sidecar 拦截记录及估算费用。
- **预算护栏**：配置单次任务最大迭代轮次与费用提醒阈值，防异常循环烧钱。
- **失败回流（`/feedback`）**：使用中遇到翻车（漏约束、做错、“做对了但说错了”）时，执行 `/feedback <简述>` 标记当前轨迹，离线定位首个错误步骤并沉淀为新的轨迹前缀回归用例。

### 7.4 可消融架构与提示词快照

- **独立特性开关**：状态栏、L2 微压缩、Reranker、Sidecar 等核心模块均可通过配置独立开关，支持单变量配对消融验证（如核对压缩与 Prompt Cache 命中是否互相抵消）。
- **静态前缀快照**：支持确定性导出当前渲染后的完整 System Prompt 与工具清单快照纳入 Git，每次改动前后在回归集跑配对对比。

---

## 8. 模型后训练边界（第 8 章）

1. **明确不做主模型训练**：主模型能力提升完全走外部产物（知识库 + Skills + Harness 代码）与官方模型升级（通过第 7 章评估集验证切换），不引入 Mid-training、主模型 SFT 或 RL 训练栈。
2. **远期潜在方向（暂不实施）**：仅当未来积累数百条真实轨迹且 Prompt 调优触顶时，才考虑对本地 Ollama 专职小模型（如 Sidecar 分类器或记忆提取器）做轻量 LoRA 蒸馏。
3. **低成本数据契约预留**：第 7 章黄金评估集与日常轨迹目录物理隔离，防未来数据泄漏；带打断占位符的轨迹保留元数据标记。

---

## 9. 持续进化闭环（第 9 章）

### 9.1 三层外部进化载体

原始轨迹经结果验证、过程规则检查与 `/feedback` 评价后，跨多条成功/失败轨迹对照归纳，按性质路由到 3 类载体：
1. **行动经验文档（`knowledge/experience/*.md`）**：记录“在什么条件下怎么做、有哪些例外与坑”，必须附证据轨迹 ID 与验证时间；
2. **Skill / 流程模板最小补丁**：高频流程跑顺后沉淀为新 `SKILL.md`，或对已有 Skill 做带来源的 **最小 diff 补丁**（严禁整篇重写导致旧细节流失）；
3. **确定性脚本与校验器**：高度稳定重复的处理流程编译为带 **前置/后置检查** 的参数化脚本；前置检查不通过时自动回退给完整 Agent 重新处理。

### 9.2 在线/离线分离与手动复盘时机

- **双循环分离**：在线执行只追加不可变日志，严禁运行中静默改写正式 Skill、Prompt 或代码；进化统一在独立 Git 工作分支通过离线命令 **`/evolve`** 生成候选提案（附证据链、根因、最小 diff、预期影响）。
- **手动触发 `/evolve` 的三条时机**（系统仅在 TUI 做轻量提醒，始终由人工决定运行）：
  1. **固定周节奏**：每周一次（5–10 分钟）集中审阅候选进化提案；
  2. **累积阈值提示**：未处理 `/feedback` 或 HITL 拒绝累计达 **3–5 条**（或同类错误 ≥ 2 次）、同类脚本/流程手动跑顺 **≥ 3 次**、累计新会话达 **15–20 个**，或刚升级 DeepSeek 版本；
  3. **重大事故例外**：出现严重越界、数据险损或明显幻觉误导时，即时复盘并补充回归用例。

### 9.3 安全红线、效果跟踪与二期修剪

- **不可自改的可信根**：外部网页/PDF 内容严禁未经人审进入 Skill 或指令；进化模块无权修改安全护栏/Sidecar 规则、第 7 章黄金评估集与断言脚本、以及主分支稳定版本；一期所有三类提案均须跑通 **边界集 + 保留集** 并经人工确认 diff 后合入 Git，随时一键回滚。
- **进化效果跟踪**：在本地 Trace 账本中统计新经验/Skill 的 **产物激活率** 与 **保留集无退化**，区分“写出来了”与“真正用上且有效”。
- **长期修剪体检（Curator，二期）**：定期识别长期 0 命中、重复或冲突的经验与 Skill，提出合并、归档或将全局规则下沉至领域 Skill 的清理提案。

---

## 10. 多 Agent 协作演进（第 10 章）

- **一期原则**：坚持 **纯单 Agent + Skills**，把单 Agent 架构、RAG、Docker 沙箱、评估与持续进化打磨稳定；纯角色流程切换优先通过 Skill 解决（不破 KV Cache）。
- **二期高价值多 Agent 模式**（仅在引入新信息增量或上下文隔离/并行收益显著时启用）：
  1. **管理者模式 + 上下文隔离**：主 Agent 派生短时只读子 Agent（`spawn_subagent` / `cancel_subagent`）并行消化多篇长 PDF 或大范围笔记检索，子 Agent 在独立上下文运行，仅回传精炼结构化结论与出处路径；支持父级取消级联终止；
  2. **Proposer-Reviewer 跨模态审核**：针对默认交付的单文件交互式 HTML，由独立 Reviewer 经无头浏览器渲染截图 + 云端视觉 API 审查排版与数据完整性，迭代 1–2 轮收敛（审核者只读不改代码）。
- **二期并发与风控约束**：
  - 不做去中心化 Swarm 接力、不做无外部反馈的同模型群聊辩论、不做 A2A；
  - 目录四区隔离（子 Agent 仅写私有 `/scratch/<id>`，写入共享区或 `knowledge/` 走主 Agent 汇总或 Git worktree / 乐观锁）；
  - 硬限制最大并发数（≤ 3）与单子 Agent 步数/token 预算；核心架构、知识库结构与关键决策始终由人类掌控，防范理解债与认知投降。

---

## 附录：`pi` 底座复用与一期二次开发切入点

| 需求模块 | `pi` 现有能力（可直接复用） | 一期二次开发重点 |
|---|---|---|
| 核心循环与模型协议 | `packages/agent`、`packages/ai`（中立消息与流式工具循环） | 校验 DeepSeek `reasoning_content` 回传与 Prompt Cache 统计；主模型故障暂停报错与空闲看门狗 |
| System Prompt 与 Skills | `packages/coding-agent/src/core/system-prompt.ts`、`skills.ts` | 改写为个人助理静态前缀骨架 + 注入 `<user_profile>`；新增笔记整理与数据处理首批 Skills |
| 状态栏与 TUI | `packages/coding-agent` TUI 渲染框架 | 新增上下文末尾确定性 `<agent_status>` 注入、专用 `todo` 工具与 TUI 实时 TODO 面板 |
| 上下文压缩与保真 | `packages/coding-agent/src/core/compaction/compaction.ts`、`session-manager.ts`（`context_edit`） | 修正中文 token 估算与 70%–75% 阈值；补齐 L1 写时落盘冻结预览、L2 批量清噪声、外置状态/Pin/代码挂载 `SourceIndex`、熔断器与 `search_session_history` |
| 记忆与本地混合 RAG | 无（全新模块） | 实现三层目录骨架、YAML Profile / JSONL Events、Markdown/PDF 结构感知切分、SQLite FTS5 中文 BM25 + Ollama `bge-m3` + Rerank 混合检索与 3 个 Agentic RAG 工具 |
| 工具、视觉、安全与沙箱 | `packages/coding-agent/src/core/tools/`、`mcp-servers.ts` | 增补 `web_search` / `fetch_url` / `analyze_visual`（云端视觉 API）/ HITL / `monitor_shell`；实现目录边界、写前快照、写后自动校验、本地 Ollama Sidecar 与 Windows Docker 沙箱适配器；MCP 代理延迟发现 |
| 自检、评估与持续进化 | `packages/evals`（Docker 评估与报告骨架） | 扩展 RAG 召回率评估流水线、端到端与轨迹前缀回归集、异源 LLM-as-a-Judge、本地 Trace 账本、`/feedback`、`doctor` 命令与 `/evolve` 离线提案工作流 |
