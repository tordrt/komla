// The Pull requests panel. The plugin's code, main.ts, asks the GitHub CLI for the repository's
// open pull requests and posts them to the page, which gets them from komla.onData. Titles,
// branches and names come from GitHub, so they go in as text, never as HTML.

const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']);
// Nerd Font glyphs, which komla.css's k-icon shows in Komla's icon font.
const ICON = {
  failing: '',
  pending: '',
  passing: '',
  none: '',
  agent: '',
  external: '',
  branch: '',
  done: '',
  search: '',
};

const lists = document.querySelector('#lists');
const filter = document.querySelector('#filter');
const notice = document.querySelector('#notice');
const repoLink = document.querySelector('#repo');
const updated = document.querySelector('#updated');
const refreshButton = document.querySelector('#refresh');

let state = { me: '', repo: null, prs: [] };
let receivedAt = 0;
const open = new Set();
/** Whether the user opened or folded each section, so a refresh leaves it so. */
const opened = new Map();
const showingAll = new Set();
/** How many pull requests a section shows before "Show more". */
const SHOWN = 8;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

const icon = (glyph, className = '') => el('span', { class: `k-icon ${className}`, text: glyph, 'aria-hidden': 'true' });
const sep = () => el('span', { class: 'k-sep' });

/** A GitHub login without the app/ that bots' logins have. */
const login = (pr) => (pr.author?.login ?? '').replace(/^app\//, '');

/** Initials in a color the name always gets, since a page can't load avatars from the web. */
function avatar(name) {
  let hue = 0;
  for (const char of name) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  const initials = name.split(/[-_.\s]+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2) || '?';
  return el('span', { class: 'k-avatar', style: `--k-hue: ${hue}`, text: initials, title: name });
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
  const [unit, size] = units.find(([, size]) => seconds >= size);
  return `${Math.floor(seconds / size)}${unit} ago`;
}

/** The pull request's checks as one state, and the ones worth naming: failing, then running. */
function checks(pr) {
  const all = pr.statusCheckRollup ?? [];
  const failing = all.filter((check) => FAILING.has(check.state));
  const pending = all.filter((check) => PENDING.has(check.state));
  const passing = all.length - failing.length - pending.length;
  const summary = failing.length ? 'failing' : pending.length ? 'pending' : all.length ? 'passing' : 'none';
  return { summary, failing, pending, passing, total: all.length };
}

const tone = { failing: 'k-error', pending: 'k-warning', passing: 'k-success', none: 'k-muted' };
const checkLabel = (c) =>
  c.summary === 'none'
    ? 'No checks'
    : c.summary === 'failing'
      ? `${c.failing.length} of ${c.total} checks failing`
      : c.summary === 'pending'
        ? `${c.pending.length} of ${c.total} checks running`
        : `${c.total} checks passed`;

function reviewBadge(pr) {
  if (pr.isDraft) return el('span', { class: 'k-badge', text: 'Draft' });
  if (pr.reviewDecision === 'APPROVED') return el('span', { class: 'k-badge k-success', text: 'Approved' });
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return el('span', { class: 'k-badge k-warning', text: 'Changes requested' });
  }
  return null;
}

// Prompts name the pull request by number and link only: its title and description are text
// anyone can write, so the agent reads them itself rather than taking them as instructions.
function agentTask(kind, pr) {
  const checkout = `Check it out with \`gh pr checkout ${pr.number}\` first.`;
  if (kind === 'review') {
    return {
      name: `Review #${pr.number}`,
      prompt: `Review pull request #${pr.number} (${pr.url}). ${checkout} Read its description and diff against its base branch, run the tests that cover what it changes, and report bugs, risks and suggestions, most serious first. Don't push, approve or comment on GitHub.`,
    };
  }
  if (kind === 'fix-checks') {
    return {
      name: `Fix checks #${pr.number}`,
      prompt: `Pull request #${pr.number} (${pr.url}) has failing checks. ${checkout} Find what fails with \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\`, reproduce it locally, fix it, and push to the pull request's branch.`,
    };
  }
  return {
    name: `Address review #${pr.number}`,
    prompt: `Pull request #${pr.number} (${pr.url}) has review comments asking for changes. ${checkout} Read them with \`gh pr view ${pr.number} --comments\` and the review threads with \`gh api\`, make the changes that are right, and push to the pull request's branch. Say which comments you didn't act on and why.`,
  };
}

let sayTimer;
/** A banner above the list; a success goes by itself. */
function say(message, tone, fromRefresh = false) {
  clearTimeout(sayTimer);
  notice.dataset.fromRefresh = String(fromRefresh);
  if (tone === 'success') sayTimer = setTimeout(() => say(null), 6000);
  notice.hidden = !message;
  notice.textContent = message ?? '';
  notice.className = `k-banner ${tone ? `k-${tone}` : ''}`;
}

async function startAgent(kind, pr, button) {
  button.disabled = true;
  say(null);
  try {
    // Komla asks the user first, showing the prompt, and starts the agent once they allow it.
    await komla.agent.launch({ destination: 'workspace', ...agentTask(kind, pr) });
    say(`Started an agent for #${pr.number} in a new workspace.`, 'success');
  } catch (error) {
    if (error.code !== 'DECLINED') say(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function actionsFor(pr, c) {
  const mine = pr.author?.login === state.me;
  const buttons = [];
  if (!mine) buttons.push(['review', 'Review with an agent']);
  if (mine && c.summary === 'failing') buttons.push(['fix-checks', 'Fix checks with an agent']);
  if (mine && pr.reviewDecision === 'CHANGES_REQUESTED') {
    buttons.push(['address-review', 'Address review with an agent']);
  }
  return el(
    'div',
    { class: 'actions' },
    ...buttons.map(([kind, label], index) => {
      const button = el(
        'button',
        {
          class: `k-button k-small${index === 0 ? ' k-primary' : ''}`,
          onclick: () => startAgent(kind, pr, button),
        },
        icon(ICON.agent),
        label
      );
      return button;
    }),
    el('a', { class: 'k-button k-small', href: pr.url }, icon(ICON.external), 'GitHub')
  );
}

function detail(pr, c) {
  const named = [...c.failing, ...c.pending].slice(0, 8);
  return el(
    'div',
    { class: 'detail' },
    el(
      'div',
      { class: 'branch' },
      icon(ICON.branch),
      el('code', { class: 'head', text: pr.headRefName, title: pr.headRefName }),
      el('span', { text: '→' }),
      el('code', { text: pr.baseRefName })
    ),
    el(
      'div',
      { class: 'k-meta' },
      el(
        'span',
        { class: 'k-tabular' },
        el('span', { class: 'added', text: `+${pr.additions}` }),
        ' ',
        el('span', { class: 'removed', text: `−${pr.deletions}` })
      ),
      sep(),
      el('span', { text: checkLabel(c) })
    ),
    named.length
      ? el(
          'ul',
          { class: 'check-list' },
          ...named.map((check) => {
            const failing = FAILING.has(check.state);
            return el(
              'li',
              {},
              icon(failing ? ICON.failing : ICON.pending, failing ? 'k-error' : 'k-warning'),
              check.url
                ? el('a', { class: 'k-link k-truncate', href: check.url, text: check.name })
                : el('span', { class: 'k-truncate', text: check.name })
            );
          })
        )
      : null,
    actionsFor(pr, c)
  );
}

function row(pr) {
  const c = checks(pr);
  const expanded = open.has(pr.number);
  const name = login(pr);
  const tags = [
    reviewBadge(pr),
    pr.mergeable === 'CONFLICTING' ? el('span', { class: 'k-badge k-error', text: 'Conflicts' }) : null,
  ].filter(Boolean);
  return el(
    'li',
    { class: `pr${expanded ? ' open' : ''}` },
    el(
      'button',
      {
        class: 'k-item',
        'aria-expanded': String(expanded),
        onclick: () => {
          if (expanded) open.delete(pr.number);
          else open.add(pr.number);
          render();
        },
      },
      avatar(name || '?'),
      el(
        'span',
        { class: 'k-grow' },
        el('span', { class: 'title k-clamp', text: pr.title, title: pr.title }),
        el(
          'span',
          { class: 'k-meta' },
          el('span', { class: 'k-tabular', text: `#${pr.number}` }),
          ...(name ? [sep(), el('span', { class: 'k-truncate author', text: name })] : []),
          sep(),
          el('span', { text: ago(pr.updatedAt) })
        ),
        tags.length ? el('span', { class: 'tags' }, ...tags) : null
      ),
      el('span', {
        class: `checks-state k-icon ${tone[c.summary]}`,
        text: ICON[c.summary] ?? '',
        title: checkLabel(c),
        'aria-label': checkLabel(c),
      })
    ),
    expanded ? detail(pr, c) : null
  );
}

/** A section with its count; one with nothing in it isn't shown. */
function section(key, title, prs, { tone: countTone, open: openAtFirst = true } = {}) {
  if (prs.length === 0) return null;
  const all = showingAll.has(key) || prs.length <= SHOWN + 2;
  const shown = all ? prs : prs.slice(0, SHOWN);
  const isOpen = opened.get(key) ?? openAtFirst;
  const node = el(
    'details',
    { class: 'k-section', open: isOpen },
    el(
      'summary',
      { class: 'k-section-header' },
      el('span', { text: title }),
      el('span', { class: `k-count ${countTone ?? ''}`, text: String(prs.length) })
    ),
    el('ul', { class: 'k-list' }, ...shown.map(row)),
    all
      ? null
      : el('button', {
          class: 'k-button k-ghost k-small more',
          text: `Show ${prs.length - SHOWN} more`,
          onclick: () => {
            showingAll.add(key);
            render();
          },
        })
  );
  node.addEventListener('toggle', () => {
    // It also fires for the open it's built with, which the user didn't choose.
    if (node.open !== (opened.get(key) ?? openAtFirst)) opened.set(key, node.open);
  });
  return node;
}

function empty(glyph, title, text) {
  return el('div', { class: 'k-empty' }, icon(glyph), el('strong', { text: title }), el('span', { text }));
}

function matches(pr, query) {
  if (!query) return true;
  const text = `#${pr.number} ${pr.title} ${pr.author?.login ?? ''} ${pr.headRefName}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

function render() {
  const query = filter.value.trim();
  const prs = [...state.prs]
    .filter((pr) => matches(pr, query))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const mine = (pr) => pr.author?.login === state.me;
  const asked = (pr) => !mine(pr) && (pr.reviewRequests ?? []).some((request) => request.login === state.me);
  if (prs.length === 0) {
    lists.replaceChildren(
      query
        ? empty(ICON.search, 'Nothing matches', `No open pull request has “${query}” in it.`)
        : empty(ICON.done, 'No open pull requests', 'Nothing here needs you.')
    );
    return;
  }
  const waiting = prs.filter(asked);
  const yours = prs.filter(mine);
  lists.replaceChildren(
    ...[
      section('review', 'Waiting on your review', waiting, { tone: 'k-warning' }),
      section('mine', 'Yours', yours),
      // Folded under the ones that need the user, unless it's all there is.
      section('others', 'Everything else', prs.filter((pr) => !mine(pr) && !asked(pr)), {
        open: waiting.length + yours.length === 0,
      }),
    ].filter(Boolean)
  );
}

/** What went wrong, and what to do about it: most often, the GitHub CLI isn't set up here. */
function showProblem(message) {
  const hint = /not found|command not found/i.test(message)
    ? ['Install the GitHub CLI, ', el('code', { text: 'gh' }), ', where this workspace runs.']
    : /auth|login|logged/i.test(message)
      ? ['Sign in with ', el('code', { text: 'gh auth login' }), ' in a terminal.']
      : /remote|repository|could not determine/i.test(message)
        ? ['This panel shows the pull requests of a workspace whose repository is on GitHub.']
        : [];
  lists.replaceChildren(
    el(
      'div',
      { class: 'k-empty' },
      icon(ICON.failing, 'k-error'),
      el('strong', { text: "Couldn't get the pull requests" }),
      hint.length ? el('span', {}, ...hint) : null,
      el('span', { class: 'k-mono problem', text: message })
    )
  );
}

function updatedLabel() {
  updated.textContent = receivedAt ? ago(new Date(receivedAt).toISOString()) : '';
}

komla.onData((data, error) => {
  if (data && typeof data === 'object' && Array.isArray(data.prs)) {
    state = data;
    receivedAt = Date.now();
    // GitHub answers again, so a failed refresh's banner is out of date.
    if (notice.dataset.fromRefresh === 'true') say(null);
    repoLink.textContent = data.repo?.nameWithOwner ?? 'Pull requests';
    repoLink.href = data.repo?.url ?? '#';
    updatedLabel();
    render();
    return;
  }
  const problem = error ?? (typeof data === 'string' ? data || 'The GitHub CLI printed nothing.' : '');
  if (!problem) return;
  // A failed refresh after one that worked keeps the list, and says above it what failed.
  if (state.prs.length > 0) say(`GitHub didn't answer: ${problem}`, 'error', true);
  else showProblem(problem);
});

// The plugin's code asks GitHub again, and posts what it says.
refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.firstElementChild.classList.add('k-spin');
  try {
    // A failed refresh comes back as a post, which onData shows.
    await komla.send({ type: 'refresh' });
  } catch (error) {
    say(error.message, 'error', true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.firstElementChild.classList.remove('k-spin');
  }
});

filter.addEventListener('input', render);
setInterval(updatedLabel, 30_000);
