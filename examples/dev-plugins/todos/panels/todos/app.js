// The TODOs panel: main.ts posts { todos, words }, or an error's text. File paths and lines come
// from the repository, so they go in as text.
const list = document.querySelector('#list');
const filter = document.querySelector('#filter');
const summary = document.querySelector('#summary');
const notice = document.querySelector('#notice');
let todos = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  const query = filter.value.trim().toLowerCase();
  const shown = todos.filter(
    (todo) =>
      !query || todo.file.toLowerCase().includes(query) || todo.text.toLowerCase().includes(query)
  );
  list.replaceChildren();
  if (shown.length === 0) {
    const empty = el('div', 'k-empty');
    empty.append(
      el('span', 'k-icon', '\uf00c'),
      el('strong', '', query ? 'No matches' : 'Nothing to do')
    );
    list.append(empty);
    return;
  }
  const byFile = new Map();
  for (const todo of shown) byFile.set(todo.file, [...(byFile.get(todo.file) ?? []), todo]);
  for (const [file, rows] of byFile) {
    const section = el('details', 'k-section');
    section.open = true;
    const header = el('summary', 'k-section-header');
    header.append(
      el('span', 'k-truncate', file),
      el('span', 'k-count k-warning', String(rows.length))
    );
    const ul = el('ul', 'k-list');
    for (const todo of rows) {
      const item = el('li');
      const row = el('div', 'k-item');
      const grow = el('span', 'k-grow');
      grow.append(
        el('span', 'k-clamp', todo.text),
        el('span', 'k-meta k-mono', `line ${todo.line}`)
      );
      row.append(grow);
      item.append(row);
      ul.append(item);
    }
    section.append(header, ul);
    list.append(section);
  }
}

komla.onData((data, error) => {
  if (typeof data === 'string' || error) {
    notice.hidden = false;
    notice.textContent = String(error ?? data);
    return;
  }
  notice.hidden = true;
  todos = data.todos;
  const files = new Set(todos.map((todo) => todo.file)).size;
  summary.textContent = `${todos.length} in ${files} file${files === 1 ? '' : 's'} · ${data.words}`;
  render();
});
filter.addEventListener('input', render);
document.querySelector('#refresh').addEventListener('click', () => komla.send({ type: 'refresh' }));
