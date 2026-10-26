/**
 * Formats a supervisor tick for the Actions job summary, so a run can be read without opening
 * the log. Pure: the caller supplies the counts and actions and decides where the text goes.
 * @module summary
 */

/**
 * Makes text safe inside a Markdown table cell.
 * @param {string} text
 * @returns {string}
 */
function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Renders the tick as Markdown: one table row per action (issue, action type, and the reason
 * or mode), or a single line with the issue and worker counts when nothing was decided.
 * @param {{issues: number, workers: number}} counts factory issues and active workers in the snapshot
 * @param {{type: string, issue?: number, reason?: string, mode?: string}[]} actions
 * @returns {string}
 */
export function summaryMarkdown({ issues, workers }, actions) {
  if (!actions.length) return `No actions: ${issues} factory issues, ${workers} active workers.\n`;
  const rows = actions.map((a) =>
    `| ${a.issue ? `#${a.issue}` : "-"} | ${cell(a.type)} | ${cell(a.reason ?? a.mode ?? "-")} |`);
  return ["| Issue | Action | Reason or mode |", "| --- | --- | --- |", ...rows, ""].join("\n");
}
