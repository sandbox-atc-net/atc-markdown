// The lint report tab: the markdownlint issues of every Markdown file in a
// folder (from `lint_folder`). Rules can be picked to filter; a file's issues
// are drawn when it is expanded, so a folder with thousands of issues stays fast.

import type { LintRule } from "./settings";

export interface FolderIssue {
  rule: string;
  message: string;
  line: number;
  column: number;
  fixable: boolean;
}

export interface FileLint {
  path: string;
  /** Path below the folder, with `/`. */
  relative: string;
  /** Its issues in line order, at most 50 of each rule (the backend caps the list). */
  issues: FolderIssue[];
  /** All issues, including those not listed. */
  total: number;
  /** All issues per rule id. */
  ruleCounts: Record<string, number>;
  error: string | null;
}

export interface RuleCount {
  rule: string;
  issues: number;
  files: number;
}

export interface FolderLint {
  root: string;
  scanned: number;
  files: FileLint[];
  truncated: boolean;
  configErrors: string[];
  rules: RuleCount[];
}

export interface LintReportActions {
  /** Opens a file in the editor at a position. */
  open(path: string, line: number, column: number): void;
  /** Lints the folder again. */
  rerun(): void;
}

/** Identity of a lint report tab for a folder. */
export const LINT_REPORT_PREFIX = "atc-markdown:lint:";

export const lintReportPath = (root: string): string => `${LINT_REPORT_PREFIX}${root}`;

/** The files to list with a rule filter (all files without one), and their issue counts. */
export function visibleFiles(report: FolderLint, rule: string | null): { file: FileLint; count: number }[] {
  if (rule === null) return report.files.map((file) => ({ file, count: file.total }));
  return report.files
    .map((file) => ({ file, count: file.ruleCounts[rule] ?? 0 }))
    .filter(({ count }) => count > 0);
}

const number = new Intl.NumberFormat("en-US");
const plural = (n: number, word: string): string => `${number.format(n)} ${word}${n === 1 ? "" : "s"}`;

/** UI state that survives showing the tab again. */
interface ViewState {
  rule: string | null;
  open: Set<string>;
}
const viewStates = new WeakMap<FolderLint, ViewState>();

export function renderLintReport(
  container: HTMLElement,
  report: FolderLint,
  rules: readonly LintRule[],
  actions: LintReportActions,
): void {
  let view = viewStates.get(report);
  if (!view) {
    view = { rule: null, open: new Set() };
    viewStates.set(report, view);
  }
  const state = view;
  const ruleInfo = new Map(rules.map((r) => [r.id, r]));
  const total = report.files.reduce((sum, f) => sum + f.total, 0);
  const withIssues = report.files.filter((f) => f.total > 0).length;

  const title = document.createElement("h1");
  title.textContent = "Lint report";

  const meta = document.createElement("div");
  meta.className = "report-meta";
  const folder = document.createElement("code");
  folder.textContent = report.root;
  const summary = document.createElement("span");
  summary.textContent =
    total === 0
      ? `${plural(report.scanned, "file")} checked – no issues ✓`
      : `${plural(report.scanned, "file")} checked · ${plural(total, "issue")} in ${plural(withIssues, "file")}`;
  const rerun = document.createElement("button");
  rerun.type = "button";
  rerun.className = "settings-reset";
  rerun.textContent = "Run again";
  rerun.title = "Lint the folder again (F5)";
  rerun.addEventListener("click", () => actions.rerun());
  meta.append(folder, summary, rerun);

  const notes: HTMLElement[] = [];
  if (report.truncated) notes.push(note(`Only the first ${plural(report.scanned, "file")} were checked.`));
  for (const error of report.configErrors) notes.push(note(`Configuration file not used: ${error}`));
  const unreadable = report.files.filter((f) => f.error !== null).length;
  if (unreadable > 0) notes.push(note(`${plural(unreadable, "file")} could not be read.`));

  const ruleList = document.createElement("div");
  ruleList.className = "report-rules";
  ruleList.setAttribute("role", "group");
  ruleList.setAttribute("aria-label", "Filter by rule");
  const fileList = document.createElement("div");
  fileList.className = "report-files";

  const drawRules = () => {
    const chip = (rule: string | null, label: string, hint: string) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "report-rule";
      button.textContent = label;
      button.title = hint;
      button.setAttribute("aria-pressed", String(state.rule === rule));
      button.addEventListener("click", () => {
        state.rule = state.rule === rule ? null : rule;
        drawRules();
        drawFiles();
      });
      return button;
    };
    ruleList.replaceChildren(
      chip(null, `All rules · ${number.format(total)}`, "Show every issue"),
      ...report.rules.map((count) => {
        const info = ruleInfo.get(count.rule);
        const name = info ? `${count.rule} ${info.alias}` : count.rule;
        const hint = `${info?.description ?? count.rule}\n${plural(count.issues, "issue")} in ${plural(count.files, "file")}${
          info?.fixable ? " · can be fixed" : ""
        }`;
        return chip(count.rule, `${name} · ${number.format(count.issues)}`, hint);
      }),
    );
  };

  const drawFiles = () => {
    const files = visibleFiles(report, state.rule);
    fileList.replaceChildren(...files.map(({ file, count }) => fileEntry(file, count)));
  };

  const fileEntry = (file: FileLint, count: number): HTMLElement => {
    const details = document.createElement("details");
    details.className = "report-file";
    const head = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "report-file-name";
    name.textContent = file.relative;
    const badge = document.createElement("span");
    badge.className = file.error ? "report-count error" : "report-count";
    badge.textContent = file.error ? "not read" : number.format(count);
    head.append(name, badge);
    details.append(head);

    const fill = () => {
      if (details.childElementCount > 1) return;
      details.append(issueList(file));
    };
    details.addEventListener("toggle", () => {
      if (details.open) {
        state.open.add(file.path);
        fill();
      } else {
        state.open.delete(file.path);
      }
    });
    if (state.open.has(file.path)) {
      details.open = true;
      fill();
    }
    return details;
  };

  const issueList = (file: FileLint): HTMLElement => {
    if (file.error) {
      const p = document.createElement("p");
      p.className = "report-error";
      p.textContent = file.error;
      return p;
    }
    const list = document.createElement("ul");
    list.className = "report-issues";
    const shown = state.rule === null ? file.issues : file.issues.filter((i) => i.rule === state.rule);
    for (const issue of shown) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.title = "Open in the editor at this line";
      const where = span("report-where", `${issue.line}:${issue.column}`);
      const alias = ruleInfo.get(issue.rule)?.alias;
      const rule = span("report-rule-id", alias ? `${issue.rule}/${alias}` : issue.rule);
      const text = span("report-message", issue.message);
      button.append(where, rule, text);
      if (issue.fixable) button.append(span("report-fixable", "fixable"));
      button.addEventListener("click", () => actions.open(file.path, issue.line, issue.column));
      item.append(button);
      list.append(item);
    }
    const all = state.rule === null ? file.total : (file.ruleCounts[state.rule] ?? 0);
    if (all > shown.length) {
      const rest = document.createElement("li");
      rest.className = "report-more";
      rest.textContent = `… and ${plural(all - shown.length, "more issue")} – open the file to see all`;
      list.append(rest);
    }
    return list;
  };

  drawRules();
  drawFiles();
  container.replaceChildren(title, meta, ...notes, ...(total > 0 || unreadable > 0 ? [ruleList, fileList] : []));
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "report-note";
  p.textContent = text;
  return p;
}

function span(className: string, text: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}
