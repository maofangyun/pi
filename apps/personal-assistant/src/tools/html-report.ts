// Self-contained single-file interactive HTML report generator and deterministic offline validator.
// Data is injected directly as JSON (bypassing LLM transcription) with inline charts and filterable/sortable tables.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface HtmlReportKpi {
	label: string;
	value: string;
	delta?: string;
}

export interface HtmlReportChart {
	title: string;
	type: "bar" | "line";
	labels: string[];
	values: number[];
	unit?: string;
}

export interface HtmlReportTable {
	title?: string;
	columns: string[];
	rows: Array<Record<string, string | number | boolean | null>>;
}

export interface HtmlReportSpec {
	title: string;
	subtitle?: string;
	generatedAt?: string;
	kpis?: HtmlReportKpi[];
	charts?: HtmlReportChart[];
	table?: HtmlReportTable;
	methodologyNotes?: string[];
}

export interface HtmlReportValidationResult {
	ok: boolean;
	errors: string[];
	warnings: string[];
	hasEmbeddedDataJson: boolean;
}

const GenerateHtmlReportParams = Type.Object({
	output_path: Type.String({ description: "输出的 .html 报告文件路径" }),
	title: Type.String({ description: "报告主标题" }),
	subtitle: Type.Optional(Type.String({ description: "报告副标题或统计周期" })),
	data_json_path: Type.Optional(
		Type.String({
			description: "由沙箱 Python 脚本产出的结构化 JSON 数据文件路径（优先通过文件注入，避免模型手工抄数）",
		}),
	),
	kpis: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String(),
				value: Type.String(),
				delta: Type.Optional(Type.String()),
			}),
		),
	),
	methodology_notes: Type.Optional(Type.Array(Type.String())),
});

/** Generate a zero-CDN, offline-ready single-file interactive HTML report with JSON data injection. */
export function generateInteractiveHtmlReport(spec: HtmlReportSpec): string {
	const safePayload = {
		title: spec.title,
		subtitle: spec.subtitle ?? "",
		generatedAt: spec.generatedAt ?? new Date().toISOString(),
		kpis: spec.kpis ?? [],
		charts: spec.charts ?? [],
		table: spec.table ?? { title: "明细数据", columns: [], rows: [] },
		methodologyNotes: spec.methodologyNotes ?? [],
	};

	// Prevent premature </script> termination when embedding arbitrary strings in JSON.
	const jsonLiteral = JSON.stringify(safePayload, null, 2).replace(/<\/script/gi, "<\\/script");

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(safePayload.title)}</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #f1f5f9; --muted: #94a3b8; --accent: #38bdf8; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 60px; }
  header { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
  h1 { margin: 0 0 6px; font-size: 26px; }
  .meta { color: var(--muted); font-size: 13px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .kpi-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi-val { font-size: 24px; font-weight: 700; margin-top: 6px; color: var(--accent); }
  .kpi-delta { font-size: 12px; color: #34d399; margin-top: 4px; }
  .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 18px; margin-bottom: 24px; }
  .chart-title { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
  svg.chart { width: 100%; height: 240px; display: block; }
  .toolbar { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; }
  input.search { background: #0b1220; border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; min-width: 260px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); }
  th { cursor: pointer; color: var(--accent); user-select: none; white-space: nowrap; }
  tr:hover td { background: rgba(56, 189, 248, 0.08); }
  ul.notes { margin: 8px 0 0; padding-left: 20px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="report-title">${escapeHtml(safePayload.title)}</h1>
    <div class="meta" id="report-meta"></div>
  </header>
  <section class="kpi-grid" id="kpi-grid"></section>
  <section class="charts-grid" id="charts-grid"></section>
  <section class="card" id="table-section" style="display:none;">
    <div class="toolbar">
      <strong id="table-title">明细数据</strong>
      <input class="search" id="table-search" type="search" placeholder="输入关键字筛选表格行..." />
    </div>
    <div class="table-wrap">
      <table>
        <thead id="table-head"></thead>
        <tbody id="table-body"></tbody>
      </table>
    </div>
  </section>
  <section class="card" id="notes-section" style="margin-top:20px; display:none;">
    <strong>口径与核对说明</strong>
    <ul class="notes" id="notes-list"></ul>
  </section>
</div>

<script id="report-data" type="application/json">
${jsonLiteral}
</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("report-data").textContent || "{}");
  document.getElementById("report-meta").textContent = [data.subtitle, "生成时间: " + (data.generatedAt || "")].filter(Boolean).join(" | ");

  var kpiGrid = document.getElementById("kpi-grid");
  (data.kpis || []).forEach(function (k) {
    var div = document.createElement("div");
    div.className = "card";
    div.innerHTML = '<div class="kpi-label"></div><div class="kpi-val"></div><div class="kpi-delta"></div>';
    div.querySelector(".kpi-label").textContent = k.label;
    div.querySelector(".kpi-val").textContent = k.value;
    div.querySelector(".kpi-delta").textContent = k.delta || "";
    kpiGrid.appendChild(div);
  });

  var chartsGrid = document.getElementById("charts-grid");
  (data.charts || []).forEach(function (ch) {
    var card = document.createElement("div");
    card.className = "card";
    var h = document.createElement("div");
    h.className = "chart-title";
    h.textContent = ch.title + (ch.unit ? " (" + ch.unit + ")" : "");
    card.appendChild(h);
    var values = ch.values || [];
    var labels = ch.labels || [];
    var maxVal = Math.max.apply(null, values.concat([1]));
    var w = 480, ht = 210, pad = 34;
    var plotW = w - pad * 2, plotH = ht - pad * 2;
    var svgParts = ['<svg class="chart" viewBox="0 0 ' + w + ' ' + ht + '">'];
    if (ch.type === "line" && values.length > 0) {
      var pts = values.map(function (v, idx) {
        var x = pad + (values.length === 1 ? plotW / 2 : (idx / (values.length - 1)) * plotW);
        var y = pad + plotH - (v / maxVal) * plotH;
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      svgParts.push('<polyline fill="none" stroke="#38bdf8" stroke-width="2.5" points="' + pts + '" />');
    } else {
      var barW = values.length > 0 ? Math.max(12, plotW / values.length - 10) : 20;
      values.forEach(function (v, idx) {
        var x = pad + idx * (plotW / Math.max(1, values.length)) + 4;
        var bh = (v / maxVal) * plotH;
        var y = pad + plotH - bh;
        svgParts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="#38bdf8" />');
        svgParts.push('<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (ht - 10) + '" fill="#94a3b8" font-size="10" text-anchor="middle">' + String(labels[idx] || "").slice(0, 10) + '</text>');
      });
    }
    svgParts.push("</svg>");
    var holder = document.createElement("div");
    holder.innerHTML = svgParts.join("");
    card.appendChild(holder.firstChild);
    chartsGrid.appendChild(card);
  });

  var table = data.table;
  if (table && Array.isArray(table.columns) && table.columns.length > 0) {
    document.getElementById("table-section").style.display = "block";
    document.getElementById("table-title").textContent = table.title || "明细数据";
    var sortCol = null, sortAsc = true;
    var searchInput = document.getElementById("table-search");
    var head = document.getElementById("table-head");
    var body = document.getElementById("table-body");

    function renderTable() {
      var q = (searchInput.value || "").trim().toLowerCase();
      var rows = (table.rows || []).filter(function (row) {
        if (!q) return true;
        return table.columns.some(function (col) { return String(row[col] == null ? "" : row[col]).toLowerCase().indexOf(q) !== -1; });
      });
      if (sortCol !== null) {
        rows = rows.slice().sort(function (a, b) {
          var av = a[sortCol], bv = b[sortCol];
          var an = Number(av), bn = Number(bv);
          var cmp = (!isNaN(an) && !isNaN(bn)) ? (an - bn) : String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv));
          return sortAsc ? cmp : -cmp;
        });
      }
      body.innerHTML = "";
      rows.forEach(function (row) {
        var tr = document.createElement("tr");
        table.columns.forEach(function (col) {
          var td = document.createElement("td");
          td.textContent = row[col] == null ? "" : String(row[col]);
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }

    var htr = document.createElement("tr");
    table.columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col;
      th.addEventListener("click", function () {
        if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
        renderTable();
      });
      htr.appendChild(th);
    });
    head.appendChild(htr);
    searchInput.addEventListener("input", renderTable);
    renderTable();
  }

  if (Array.isArray(data.methodologyNotes) && data.methodologyNotes.length > 0) {
    document.getElementById("notes-section").style.display = "block";
    var ul = document.getElementById("notes-list");
    data.methodologyNotes.forEach(function (note) {
      var li = document.createElement("li");
      li.textContent = note;
      ul.appendChild(li);
    });
  }
})();
</script>
</body>
</html>
`;
}

/** Deterministically validate a single-file interactive HTML report for offline integrity and JS/JSON correctness. */
export function validateInteractiveHtmlReport(html: string): HtmlReportValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!/<!DOCTYPE\s+html>/i.test(html)) {
		errors.push("缺少 <!DOCTYPE html> 声明。");
	}
	if (!/<html\b/i.test(html) || !/<\/html>/i.test(html)) {
		errors.push("缺少完整的 <html>...</html> 结构。");
	}
	if (!/<body\b/i.test(html) || !/<\/body>/i.test(html)) {
		errors.push("缺少完整的 <body>...</body> 结构。");
	}

	// Reject external CDN script/stylesheet links that break offline local browsing.
	if (/<script\b[^>]*\bsrc=["']https?:\/\//i.test(html)) {
		errors.push("检测到外部 CDN <script src='http(s)://...'> 依赖，违背单文件离线可打开规范。");
	}
	if (/<link\b[^>]*\bhref=["']https?:\/\//i.test(html)) {
		errors.push("检测到外部 CDN <link href='http(s)://...'> 依赖，违背单文件离线可打开规范。");
	}

	// Validate embedded JSON data block if present.
	const jsonScriptMatch = html.match(
		/<script\b[^>]*id=["']report-data["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
	);
	let hasEmbeddedDataJson = false;
	if (jsonScriptMatch) {
		hasEmbeddedDataJson = true;
		try {
			JSON.parse(jsonScriptMatch[1].trim());
		} catch (error) {
			errors.push(`内嵌 report-data JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		warnings.push('未检测到标准 <script id="report-data" type="application/json"> 内嵌数据块。');
	}

	// Parse-validate all inline executable <script> blocks without running them.
	const scriptBlocks = html.matchAll(
		/<script(?![^>]*type=["']application\/json["'])(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
	);
	let scriptIndex = 0;
	for (const match of scriptBlocks) {
		scriptIndex += 1;
		const code = match[1].trim();
		if (code.length === 0) continue;
		try {
			// Function constructor parses JS syntax without executing the body.
			new Function(code);
		} catch (error) {
			errors.push(
				`内联 <script> #${scriptIndex} 存在 JavaScript 语法错误：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		hasEmbeddedDataJson,
	};
}

/** Register the generate_html_report tool onto pi's ExtensionAPI. */
export function attachHtmlReportTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "generate_html_report",
		label: "Generate HTML Report",
		description:
			"将沙箱脚本产出的结构化 JSON 数据直接注入单文件离线交互式 HTML 报告（含 KPI 卡片、SVG 图表、可筛选排序表格）并执行确定性校验。",
		promptSnippet: "生成并校验零外链单文件交互式 HTML 数据报告",
		parameters: GenerateHtmlReportParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const outputPath = resolve(ctx.cwd, params.output_path);
			let dataSpec: Partial<HtmlReportSpec> = {};

			if (params.data_json_path) {
				const dataPath = resolve(ctx.cwd, params.data_json_path);
				dataSpec = JSON.parse(readFileSync(dataPath, "utf8")) as Partial<HtmlReportSpec>;
			}

			const html = generateInteractiveHtmlReport({
				title: params.title,
				subtitle: params.subtitle ?? dataSpec.subtitle,
				generatedAt: dataSpec.generatedAt,
				kpis: params.kpis ?? dataSpec.kpis,
				charts: dataSpec.charts,
				table: dataSpec.table,
				methodologyNotes: params.methodology_notes ?? dataSpec.methodologyNotes,
			});

			const validation = validateInteractiveHtmlReport(html);
			if (!validation.ok) {
				return {
					content: [{ type: "text", text: `HTML 报告校验失败：\n- ${validation.errors.join("\n- ")}` }],
					details: validation,
				};
			}

			mkdirSync(dirname(outputPath), { recursive: true });
			writeFileSync(outputPath, html, "utf8");

			return {
				content: [
					{
						type: "text",
						text: `已生成并通过确定性校验的单文件交互式 HTML 报告：${outputPath}（可直接本地浏览器双击打开）`,
					},
				],
				details: { outputPath, validation },
			};
		},
	});
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
