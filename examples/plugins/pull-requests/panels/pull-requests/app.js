// The Pull requests panel. The plugin's code, main.ts, asks the GitHub CLI for the repository's
// open pull requests and posts them to the page, which gets them from komla.onData. Titles,
// branches and names come from GitHub, so they go in as text, never as HTML.

const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']);
const ICONS = { failing: '', pending: '', passing: '', none: '' };

const lists = document.querySelector('#lists');
const filter = document.querySelector('#filter');
const notice = document.querySelector('#notice');
const repoLink = document.querySelector('#repo');
const updated = document.querySelector('#updated');
const refreshButton = document.querySelector('#refresh');

let state = { me: '', repo: null, prs: [] };
let receivedAt = 0;
const open = new Set();
const collapsed = new Set(['others']);
const showingAll = new Set();
/** How many pull requests a section shows before "Show more". */
const SHOWN = 8;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
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

function say(message, isError = false) {
  notice.hidden = !message;
  notice.textContent = message ?? '';
  notice.classList.toggle('k-error', isError);
}

async function startAgent(kind, pr, button) {
  button.disabled = true;
  say(null);
  try {
    // Komla asks the user first, showing the prompt, and starts the agent once they allow it.
    await komla.agent.launch({ destination: 'workspace', ...agentTask(kind, pr) });
    say(`Started an agent for #${pr.number} in a new workspace.`);
  } catch (error) {
    if (error.code !== 'DECLINED') say(error.message, true);
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
      const button = el('button', {
        class: `k-button${index === 0 ? ' k-primary' : ''}`,
        text: label,
        onclick: () => startAgent(kind, pr, button),
      });
      return button;
    }),
    el('a', { class: 'k-button k-ghost', href: pr.url, text: 'Open on GitHub' })
  );
}

function detail(pr, c) {
  const named = [...c.failing, ...c.pending].slice(0, 8);
  return el(
    'div',
    { class: 'detail' },
    named.length
      ? el(
          'ul',
          { class: 'checks' },
          ...named.map((check) =>
            el(
              'li',
              {},
              el('span', {
                class: `k-dot ${FAILING.has(check.state) ? 'k-error' : 'k-warning'}`,
              }),
              check.url
                ? el('a', { class: 'k-truncate', href: check.url, text: check.name })
                : el('span', { class: 'k-truncate', text: check.name })
            )
          )
        )
      : null,
    actionsFor(pr, c)
  );
}

function row(pr) {
  const c = checks(pr);
  const expanded = open.has(pr.number);
  return el(
    'li',
    { class: 'pr' },
    el(
      'button',
      {
        class: 'k-item',
        'aria-expanded': String(expanded),
        title: checkLabel(c),
        onclick: () => {
          if (expanded) open.delete(pr.number);
          else open.add(pr.number);
          render();
        },
      },
      el('span', { class: `state ${tone[c.summary]}`, text: ICONS[c.summary], 'aria-label': checkLabel(c) }),
      el(
        'span',
        { class: 'k-grow' },
        el('span', { class: 'title', text: pr.title }),
        el(
          'span',
          { class: 'meta' },
          el('span', { class: 'number', text: `#${pr.number}` }),
          el('span', { text: pr.author?.login ?? '' }),
          el('span', { text: ago(pr.updatedAt) }),
          el(
            'span',
            { class: 'size' },
            el('span', { class: 'added', text: `+${pr.additions}` }),
            ' ',
            el('span', { class: 'removed', text: `−${pr.deletions}` })
          ),
          reviewBadge(pr),
          pr.mergeable === 'CONFLICTING' ? el('span', { class: 'k-badge k-error', text: 'Conflicts' }) : null
        )
      )
    ),
    expanded ? detail(pr, c) : null
  );
}

function section(key, title, prs, empty) {
  const all = showingAll.has(key) || prs.length <= SHOWN + 2;
  const shown = all ? prs : prs.slice(0, SHOWN);
  const node = el(
    'details',
    { class: 'section', open: !collapsed.has(key) },
    el(
      'summary',
      {},
      el('h2', { class: 'k-section-title', text: title }),
      el('span', { class: 'k-badge', text: String(prs.length) })
    ),
    prs.length
      ? el('ul', { class: 'k-list' }, ...shown.map(row))
      : el('p', { class: 'k-muted', text: empty }),
    all
      ? null
      : el('button', {
          class: 'k-button k-ghost more',
          text: `Show ${prs.length - SHOWN} more`,
          onclick: () => {
            showingAll.add(key);
            render();
          },
        })
  );
  node.addEventListener('toggle', () => {
    if (node.open) collapsed.delete(key);
    else collapsed.add(key);
  });
  return node;
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
  lists.replaceChildren(
    section('review', 'Waiting on your review', prs.filter(asked), 'Nobody is waiting on you.'),
    section('mine', 'Yours', prs.filter(mine), 'You have no open pull requests here.'),
    section('others', 'Everything else', prs.filter((pr) => !mine(pr) && !asked(pr)), 'Nothing else is open.')
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
      { class: 'problem k-stack' },
      el('p', { class: 'k-muted', text: message }),
      hint.length ? el('p', {}, ...hint) : null
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
    repoLink.textContent = data.repo?.nameWithOwner ?? 'Pull requests';
    repoLink.href = data.repo?.url ?? '#';
    updatedLabel();
    render();
    return;
  }
  const problem = error ?? (typeof data === 'string' ? data || 'The GitHub CLI printed nothing.' : '');
  if (!problem) return;
  // A failed refresh after one that worked keeps the list, and says above it what failed.
  if (state.prs.length > 0) say(`GitHub didn't answer: ${problem}`, true);
  else showProblem(problem);
});

// The plugin's code asks GitHub again, and posts what it says.
refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.classList.add('k-spinning');
  try {
    await komla.send({ type: 'refresh' });
    say(null);
  } catch (error) {
    say(error.message, true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove('k-spinning');
  }
});

filter.addEventListener('input', render);
setInterval(updatedLabel, 30_000);
