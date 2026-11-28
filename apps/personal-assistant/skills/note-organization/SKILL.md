---
name: note-organization
description: 个人 Markdown 笔记整理、PDF 提炼归档、YAML frontmatter 规范化、双向链接维护与 _index.md 目录同步的标准操作流程。当用户要求整理笔记、归档资料、提炼 PDF 笔记或重构知识库目录时使用。
---

# 个人笔记整理标准操作流程（SOP）

## 1. 目录与边界纪律

- **原始证据区（只读）**：`evidence/raw_pdfs/` 与 `evidence/sessions/` 严禁修改、重命名或删除。
- **知识真相源（受控读写）**：所有提炼后的笔记一律写入 `knowledge/notes/`（或用户配置的 `notesDir`），并纳入 Git 版本管理。
- 修改已有笔记正文或大规模调整目录前，先展示最小变更范围与 diff 摘要，经用户确认后再合入主分支。

## 2. YAML Frontmatter 规范

每篇新建或整理后的 Markdown 笔记顶部必须包含合法的 YAML frontmatter：

```yaml
---
title: "笔记主标题"
tags:
  - 领域标签
  - 主题标签
date: 2026-11-28
updated: 2026-11-28
aliases:
  - 常用别名
sources:
  - "evidence/raw_pdfs/example.pdf#p12-p15"
---
```

约束：
1. `title`、`tags`、`date` 为必填字段；日期统一使用 `YYYY-MM-DD`。
2. 禁止在 frontmatter 中使用未转义的冒号导致 YAML 语法损坏。

## 3. 结构、双向链接与出处引用

1. **清晰标题树**：正文遵循单一 `# H1`（与 `title` 一致）-> `## H2` -> `### H3` 层级，避免跳级标题，利于后续结构感知分块与混合 RAG 检索。
2. **双向链接**：关联已有概念或笔记时使用 `[[目标笔记名]]` 或 `[[目录/笔记名|显示名]]`；写入前先核对目标笔记是否存在，不凭空制造断链。
3. **精确出处**：
   - 来自 PDF 的关键结论、数据与原话必须附页码出处，如 `[来源: evidence/raw_pdfs/report.pdf#p14]` 或 `[来源: evidence/raw_pdfs/report.pdf#p14-p16]`；
   - 来自外部网页的内容必须附原始 URL 与访问日期；
   - 严禁编造未读取页码或不存在的文件路径。

## 4. 目录索引 `_index.md` 同步与自检

1. 新增、移动或归档笔记后，同步更新所在目录及根目录 `knowledge/notes/_index.md` 的 L0/L1 一句话概览。
2. 写入完成后自检：
   - YAML frontmatter 可被标准 YAML 解析器无错解析；
   - 所有 `[[...]]` 内部链接有明确目标或标记为待建条目；
   - 原始只读证据区零改动。
