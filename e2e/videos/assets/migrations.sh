#!/bin/sh
# This branch's database migrations, for the status bar: `status`, `popover` or `migrate`.
dir=db/migrations
db="acme_$(git branch --show-current | tr -c 'a-z0-9\n' _)"
# The demo's stand-in for the database's schema_migrations table. A branch's database starts as a
# copy of main's, so main's migrations have run there.
applied="$(git rev-parse --git-dir)/schema-migrations"
[ -f "$applied" ] || git ls-tree --name-only main "$dir/" | sed 's|.*/||; s|\.sql$||' >"$applied"

pending() {
  for file in "$dir"/*.sql; do
    name=$(basename "$file" .sql)
    [ -f "$file" ] && ! grep -qx "$name" "$applied" && echo "$name"
  done
}

# 20261028141200_create_invites → Oct 28, 14:12
stamp() {
  echo "$1" | awk '{ printf "%s %d, %s:%s", substr("JanFebMarAprMayJunJulAugSepOctNovDec", substr($0, 5, 2) * 3 - 2, 3), substr($0, 7, 2), substr($0, 9, 2), substr($0, 11, 2) }'
}

# A migration's row: its name, the first line of its SQL while it's pending, and when it was written.
row() {
  echo "<div class='row'><span class='dot'></span><div class='main'><div class='name'>${1#*_}</div>"
  if [ "$2" = pending ]; then echo "<div class='sub'>$(sed -n '1s/^-- //p' "$dir/$1.sql")</div>"; fi
  echo "</div><span class='when'>$(stamp "$1")</span></div>"
}

case $1 in
  status)
    count=$(pending | grep -c .)
    if [ "$count" -eq 0 ]; then
      printf '{"segments": [{"text": "\\uf1c0", "color": "success"}, {"text": " Migrations up to date"}]}\n'
    elif [ "$count" -eq 1 ]; then
      printf '{"segments": [{"text": "\\uf1c0", "color": "warning"}, {"text": " 1 migration pending"}]}\n'
    else
      printf '{"segments": [{"text": "\\uf1c0", "color": "warning"}, {"text": " %s migrations pending"}]}\n' "$count"
    fi
    ;;
  popover)
    todo=$(pending)
    ran=$(grep -c . "$applied")
    left=$(echo "$todo" | grep -c .)
    style="<style>
      .sheet{--tone:var(--warning)}
      .sheet.ok{--tone:var(--success)}
      .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      .muted{color:var(--muted-foreground)}
      .head{display:flex;gap:10px;align-items:center}
      .icon{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:8px;font-size:15px;color:var(--tone);background:color-mix(in oklch,var(--tone) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--tone) 30%,transparent)}
      .title{flex:1;min-width:0;line-height:1.35}
      .db{font-size:12.5px;font-weight:600}
      .small{font-size:11px}
      .badge{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;color:var(--tone);background:color-mix(in oklch,var(--tone) 15%,transparent)}
      .bar{display:flex;gap:3px;margin:12px 0 5px}
      .bar>i{flex:1;height:4px;border-radius:2px;background:var(--success)}
      .bar>i.todo{background:color-mix(in oklch,var(--warning) 40%,transparent)}
      .legend{display:flex;justify-content:space-between}
      h4{margin:12px 0 5px;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-foreground)}
      .list{padding:0 10px;border-radius:8px;background:color-mix(in oklch,var(--foreground) 4%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--border) 70%,transparent)}
      .list.pending{background:color-mix(in oklch,var(--warning) 7%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--warning) 22%,transparent)}
      .row{display:flex;gap:9px;align-items:flex-start;padding:6px 0}
      .row+.row{border-top:1px solid color-mix(in oklch,var(--border) 60%,transparent)}
      .dot{flex:none;width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--success)}
      .pending .dot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--warning);animation:pulse 1.6s ease-in-out infinite}
      @keyframes pulse{50%{box-shadow:inset 0 0 0 1.5px var(--warning),0 0 0 3px color-mix(in oklch,var(--warning) 25%,transparent)}}
      .main{flex:1;min-width:0}
      .name{overflow:hidden;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;text-overflow:ellipsis;white-space:nowrap}
      .applied .name{color:var(--muted-foreground)}
      .sub{margin-top:1px;font-size:11px;color:var(--muted-foreground)}
      .when{flex:none;font-size:11px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
    </style>"
    bar=""
    for _ in $(cat "$applied"); do bar="$bar<i></i>"; done
    for _ in $todo; do bar="$bar<i class='todo'></i>"; done
    if [ -n "$todo" ]; then
      page="<div class='sheet'>"
      badge="<span class='badge'>$left pending</span>"
      legend="<span>$ran applied</span><span>$left to run</span>"
      buttons='[{"label": "Run migrations", "run": "migrate"}]'
    else
      page="<div class='sheet ok'>"
      badge="<span class='badge'>&#xf00c; Up to date</span>"
      legend="<span>All $ran applied</span>"
      buttons='[]'
    fi
    page="$page<div class='head'><span class='icon'>&#xf1c0;</span><div class='title'><div class='db mono'>$db</div><div class='muted small'>Postgres 16 &#183; branched from main</div></div>$badge</div>"
    page="$page<div class='bar'>$bar</div><div class='legend muted small'>$legend</div>"
    if [ -n "$todo" ]; then
      page="$page<h4>Pending</h4><div class='list pending'>"
      for name in $todo; do page="$page$(row "$name" pending)"; done
      page="$page</div>"
    fi
    page="$page<h4>Recently applied</h4><div class='list applied'>"
    # The last three that ran, newest first.
    for name in $(awk '{ rows[NR] = $0 } END { for (i = NR; i > 0 && i > NR - 3; i--) print rows[i] }' "$applied"); do
      page="$page$(row "$name")"
    done
    page="$page</div></div>"
    printf '{"html": "%s", "buttons": %s}\n' "$(printf '%s' "$style$page" | tr -d '\n')" "$buttons"
    ;;
  migrate)
    todo=$(pending)
    [ -n "$todo" ] || exit 0
    komla tag "Migrating" --spinner --tone info
    for name in $todo; do
      # The demo's stand-in for `psql "$DATABASE_URL" -f "$dir/$name.sql"`.
      sleep 2
      echo "$name" >>"$applied"
    done
    komla untag "Migrating"
    komla notify "Migrations applied" --body "$db is up to date" --color success
    ;;
esac
