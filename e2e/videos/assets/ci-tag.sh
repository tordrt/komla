#!/bin/sh
# Tags the workspace "CI running" while its pull request's checks run, then says how they ended.
out=$(gh pr view --json state,reviewDecision,statusCheckRollup --jq '
  [.statusCheckRollup[]? | if .__typename == "StatusContext" then
      (if .state == "SUCCESS" then "pass" elif .state == "FAILURE" or .state == "ERROR" then "fail" else "pending" end)
    elif .status != "COMPLETED" then "pending"
    elif .conclusion == "SUCCESS" or .conclusion == "NEUTRAL" or .conclusion == "SKIPPED" then "pass"
    else "fail" end] as $checks
  | (if .state != "OPEN" or ($checks | length) == 0 then "none"
     elif $checks | any(. == "fail") then "fail"
     elif $checks | any(. == "pending") then "pending"
     else "pass" end) + " " + (.reviewDecision // "")' 2>&1)
case $out in
  *"no pull requests found"*) out=none ;;
esac
read -r ci review <<END
$out
END
case $ci in
  pending | pass | fail | none) ;;
  # gh couldn't say, such as offline: try again next time.
  *) exit 0 ;;
esac
state="${TMPDIR:-/tmp}/komla-ci-$KOMLA_WORKSPACE_ID"
last=$(cat "$state" 2>/dev/null)
# No open pull request with checks, such as one merged or a branch without one: its tag goes.
if [ "$ci" = none ]; then
  case $last in
    pending) komla untag "CI running" ;;
    fail) komla untag "CI failed" ;;
  esac
  rm -f "$state"
  exit 0
fi
[ "$ci" = "$last" ] && exit 0
echo "$ci" > "$state"
if [ "$ci" = pending ]; then
  komla tag "CI running" --spinner --tone info
  exit 0
fi
# Checks that ended before this script saw them run are no news.
[ "$last" = pending ] || exit 0
if [ "$ci" = fail ]; then
  komla tag "CI failed" --tone error --if "CI running"
  komla notify "CI failed" --badge CI --color error
  exit 0
fi
case $review in
  CHANGES_REQUESTED) komla tag "Needs changes" --if "CI running" ;;
  APPROVED) komla untag "CI running" ;;
  *) komla tag "In review" --if "CI running" ;;
esac
komla notify "CI passed" --badge CI --color success
