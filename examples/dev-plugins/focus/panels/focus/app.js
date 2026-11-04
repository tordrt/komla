// The Focus panel shows the timer the plugin's code keeps, counting down here between its posts.
// The buttons ask the code to start, pause or reset it, so every window shows the same timer.
const clock = document.querySelector('#clock');
const progress = document.querySelector('#progress');
const start = document.querySelector('#start');
const note = document.querySelector('#note');
let timer = null;

function leftNow() {
  if (!timer) return 0;
  return timer.state === 'running'
    ? Math.max(0, timer.endsAt - Math.floor(Date.now() / 1000))
    : timer.left;
}

function show() {
  if (!timer) return;
  const left = leftNow();
  clock.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  progress.style.setProperty('--value', String(timer.length ? 1 - left / timer.length : 0));
  start.textContent =
    timer.state === 'running' ? 'Pause' : timer.state === 'paused' ? 'Resume' : 'Start';
  note.textContent =
    timer.state === 'done'
      ? 'Time is up. Take a break.'
      : 'One timer for every workspace, in the status bar too.';
}

komla.onData((data) => {
  if (data && typeof data === 'object') timer = data;
  show();
});
setInterval(show, 1000);

const send = async (type) => {
  timer = await komla.send({ type });
  show();
};
start.addEventListener('click', () => void send(timer?.state === 'running' ? 'pause' : 'start'));
document.querySelector('#reset').addEventListener('click', () => void send('reset'));
