#!/bin/sh
# This branch's pull request and the state of its checks, for a sidebar panel.
if ! pr=$(gh pr view --json number,title,statusCheckRollup 2>/dev/null); then
  echo '{"html": "<div class=\"k-empty\"><span class=\"k-icon\">&#xea64;</span><strong>No pull request</strong><span>Open one with gh pr create.</span></div>"}'
  exit 0
fi

echo "$pr" | jq -c --arg branch "$(git branch --show-current)" '
  def state:
    if .status != "COMPLETED" then "running"
    elif (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "passed"
    else "failed" end;
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  def mark: { passed: ["k-success", "&#xf00c;"], failed: ["k-error", "&#xf00d;"], running: ["k-info", "&#xf192;"] }[.];
  def row:
    "<li><div class=\"k-item\"><span class=\"k-grow\"><span class=\"k-clamp\">\(.name | esc)</span>"
    + "<span class=\"k-meta\"><span>\(.workflowName // "Checks" | esc)</span></span></span>"
    + "<span class=\"k-icon \(.s | mark[0])\">\(.s | mark[1])</span></div></li>";
  def section($title; $tone; $items):
    if ($items | length) == 0 then "" else
      "<details class=\"k-section\" open><summary class=\"k-section-header\"><span>\($title)</span>"
      + "<span class=\"k-count \($tone)\">\($items | length)</span></summary>"
      + "<ul class=\"k-list\">\($items | map(row) | join(""))</ul></details>"
    end;

  (.statusCheckRollup | map(. + { s: state })) as $checks
  | ($checks | map(select(.s == "failed"))) as $failed
  | ($checks | map(select(.s == "running"))) as $running
  | ($checks | map(select(.s == "passed"))) as $passed
  | (if ($failed | length) > 0 then "failed" elif ($running | length) > 0 then "running" else "passed" end) as $overall
  | {
      html: (
        "<style>"
        + ".failed .k-progress > span { background: var(--error) }"
        + ".running .k-progress > span { background: var(--info) }"
        + ".passed .k-progress > span { background: var(--success) }"
        + "</style>"
        + "<div class=\"\($overall)\"><header class=\"k-header\">"
        + "<div class=\"k-row\"><span class=\"k-grow k-clamp\">#\(.number) \(.title | esc)</span>"
        + "<span class=\"k-badge \($overall | mark[0])\">\(if $overall == "failed" then "\($failed | length) failed" elif $overall == "running" then "Running" else "All passed" end)</span></div>"
        + "<div class=\"k-progress\" style=\"--value: \(($passed | length) / ($checks | length))\"><span></span></div>"
        + "<div class=\"k-meta\"><span>\($branch | esc)</span><span class=\"k-sep\"></span><span>\($passed | length) of \($checks | length) passed</span></div>"
        + "</header>"
        + section("Failed"; "k-error"; $failed)
        + section("Running"; ""; $running)
        + section("Passed"; ""; $passed)
        + "</div>"
      ),
      buttons: (if ($failed | length) > 0 then [{ label: "Re-run failed", run: "rerun" }] else [] end)
    }'
