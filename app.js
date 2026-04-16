// ─────────────────────────────────────────────────────────
//  Treadmill App — FTMS Bluetooth + Workout Runner
// ─────────────────────────────────────────────────────────

// FTMS UUIDs (Bluetooth SIG standard)
const FTMS_SERVICE         = '00001826-0000-1000-8000-00805f9b34fb';
const FTMS_CONTROL_POINT   = '00002ad9-0000-1000-8000-00805f9b34fb';
const TREADMILL_DATA_CHAR  = '00002acd-0000-1000-8000-00805f9b34fb';

// Heart Rate Service UUIDs (Bluetooth SIG standard — works with Polar H10)
const HR_SERVICE           = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT       = '00002a37-0000-1000-8000-00805f9b34fb';

// Control point opcodes
const CP = {
  REQUEST_CONTROL : 0x00,
  SET_SPEED       : 0x02,   // param: uint16 le, unit = 0.01 km/h
  SET_INCLINE     : 0x03,   // param: int16  le, unit = 0.1 %
  START_RESUME    : 0x07,
  STOP_PAUSE      : 0x08,   // 0x01 = stop, 0x02 = pause
};

// ─────────────────────────────────────────────────────────
//  Segment parser
//  Handles: "10m@7.5/0 + 8x(1m@12/0 + 90s@7/0) + 12m@7/0"
// ─────────────────────────────────────────────────────────
function parseSegmentString(str) {
  function splitTopLevel(s, delimiter) {
    const parts = [];
    let depth = 0, buf = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === delimiter && depth === 0) { parts.push(buf.trim()); buf = ''; }
      else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  }

  function parseSingleStep(s) {
    // e.g. "10m@7.5/0"  or  "90s@7/0"
    const m = s.match(/^(\d+(?:\.\d+)?)(m|s)@(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const duration = m[2] === 'm' ? parseFloat(m[1]) * 60 : parseFloat(m[1]);
    return { duration, speed: parseFloat(m[3]), incline: parseFloat(m[4]) };
  }

  function parseGroup(s) {
    s = s.trim();
    // Repeat group: Nx(...)
    const rep = s.match(/^(\d+)x\((.+)\)$/);
    if (rep) {
      const n = parseInt(rep[1]);
      const inner = parseGroup(rep[2]);
      const result = [];
      for (let i = 0; i < n; i++) result.push(...inner);
      return result;
    }
    // Multiple top-level parts joined by ' + '
    const parts = splitTopLevel(s, '+');
    if (parts.length > 1) {
      const result = [];
      for (const p of parts) result.push(...parseGroup(p));
      return result;
    }
    // Single step
    const step = parseSingleStep(s);
    return step ? [step] : [];
  }

  return parseGroup(str);
}

// Badge type from workout_type
function badgeClass(type) {
  if (type.startsWith('speed'))     return 'badge-speed';
  if (type.startsWith('tempo'))     return 'badge-tempo';
  if (type.startsWith('recovery'))  return 'badge-recovery';
  if (type.includes('hill'))        return 'badge-hills';
  if (type.startsWith('long'))      return 'badge-long';
  if (type === 'goal_race')         return 'badge-race';
  if (type === 'rest')              return 'badge-rest';
  return 'badge-easy';
}

function badgeLabel(type) {
  const map = {
    speed: 'Speed', tempo: 'Tempo', easy: 'Easy', recovery: 'Recovery',
    easy_hills: 'Hills', long_easy_hills: 'Long+Hills', long_progression_hills: 'Long+Hills',
    long_progression: 'Long', long_easy: 'Long', recovery_run: 'Recovery',
    goal_race: 'RACE', rest: 'Rest',
  };
  return map[type] || type;
}

function fmtDur(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return s === 0 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtMMSS(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────
//  CSV loader
// ─────────────────────────────────────────────────────────
async function loadPlan() {
  const res = await fetch('plan_next_30_days.csv');
  if (!res.ok) throw new Error('Could not load plan_next_30_days.csv');
  const text = await res.text();
  const lines = text.trim().split('\n');
  const workouts = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) continue;
    const [day, date, workout_type, total_minutes, segments, goal] = cols;
    workouts.push({
      day: parseInt(day),
      date: date.trim(),
      workout_type: workout_type.trim(),
      total_minutes: parseInt(total_minutes),
      segments: segments.trim(),
      goal: goal.trim(),
      steps: workout_type.trim() !== 'rest' ? parseSegmentString(segments.trim()) : [],
    });
  }
  return workouts;
}

// ─────────────────────────────────────────────────────────
//  Bluetooth / FTMS
// ─────────────────────────────────────────────────────────
let btDevice = null;
let btControlPoint = null;

async function btConnect() {
  setConnectStatus('Scanning…', '');
  btDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [FTMS_SERVICE] }],
    optionalServices: [FTMS_SERVICE],
  });
  btDevice.addEventListener('gattserverdisconnected', onBtDisconnected);

  setConnectStatus('Connecting…', '');
  const server  = await btDevice.gatt.connect();
  const service = await server.getPrimaryService(FTMS_SERVICE);
  btControlPoint = await service.getCharacteristic(FTMS_CONTROL_POINT);

  // Enable indications so we get control-point responses
  await btControlPoint.startNotifications();
  btControlPoint.addEventListener('characteristicvaluechanged', onCpResponse);

  // Request control
  await writeCP(new Uint8Array([CP.REQUEST_CONTROL]));
  setConnectStatus(`Connected: ${btDevice.name || 'Treadmill'}`, 'ok');
  document.getElementById('btn-connect').classList.add('connected');
  document.getElementById('connect-label').textContent = 'Connected';
}

function onBtDisconnected() {
  btControlPoint = null;
  setConnectStatus('Disconnected — tap Connect to reconnect', 'err');
  document.getElementById('btn-connect').classList.remove('connected');
  document.getElementById('connect-label').textContent = 'Connect';
}

function onCpResponse(event) {
  // Response: [0x80, opcode, result_code]
  // result_code 0x01 = success — we silently accept; errors are logged
  const data = event.target.value;
  if (data.byteLength >= 3 && data.getUint8(2) !== 0x01) {
    console.warn('FTMS CP error', data.getUint8(2), 'for opcode', data.getUint8(1));
  }
}

async function writeCP(bytes) {
  if (!btControlPoint) return;
  await btControlPoint.writeValueWithResponse(bytes);
}

async function btSetSpeed(kmh) {
  if (!btControlPoint) return;
  const val = Math.round(kmh * 100);
  const buf = new Uint8Array(3);
  buf[0] = CP.SET_SPEED;
  buf[1] = val & 0xff;
  buf[2] = (val >> 8) & 0xff;
  await writeCP(buf);
}

async function btSetIncline(pct) {
  if (!btControlPoint) return;
  const val = Math.round(pct * 10);
  const buf = new ArrayBuffer(3);
  const view = new DataView(buf);
  view.setUint8(0, CP.SET_INCLINE);
  view.setInt16(1, val, true);
  await writeCP(new Uint8Array(buf));
}

async function btStartResume() {
  await writeCP(new Uint8Array([CP.START_RESUME]));
}

async function btStop() {
  await writeCP(new Uint8Array([CP.STOP_PAUSE, 0x01]));
}

function setConnectStatus(msg, cls) {
  const el = document.getElementById('connect-status');
  el.textContent = msg;
  el.className = 'connect-status' + (cls ? ` ${cls}` : '');
}

// ─────────────────────────────────────────────────────────
//  Heart Rate / Polar H10
// ─────────────────────────────────────────────────────────
let hrDevice = null;
let currentHR = null;

async function hrConnect() {
  setHRStatus('Scanning for Polar H10…', '');
  hrDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [HR_SERVICE] }],
    optionalServices: [HR_SERVICE],
  });
  hrDevice.addEventListener('gattserverdisconnected', onHRDisconnected);

  setHRStatus('Connecting…', '');
  const server  = await hrDevice.gatt.connect();
  const service = await server.getPrimaryService(HR_SERVICE);
  const hrChar  = await service.getCharacteristic(HR_MEASUREMENT);

  await hrChar.startNotifications();
  hrChar.addEventListener('characteristicvaluechanged', onHRMeasurement);

  setHRStatus(`${hrDevice.name || 'HR Monitor'} connected`, 'ok');
  document.getElementById('btn-connect-hr').classList.add('connected');
  document.getElementById('connect-hr-label').textContent = hrDevice.name || 'HR Monitor';
}

function onHRDisconnected() {
  currentHR = null;
  document.getElementById('active-hr').textContent = '–';
  document.getElementById('btn-connect-hr').classList.remove('connected');
  document.getElementById('connect-hr-label').textContent = 'Polar H10';
  setHRStatus('HR monitor disconnected', 'err');
}

function onHRMeasurement(event) {
  // Heart Rate Measurement characteristic format:
  // Byte 0: flags  — bit 0: 0=uint8 HR, 1=uint16 HR
  // Byte 1 (+ maybe 2): heart rate value
  const data  = event.target.value;
  const flags = data.getUint8(0);
  const hr    = (flags & 0x01) ? data.getUint16(1, true) : data.getUint8(1);
  currentHR   = hr;
  document.getElementById('active-hr').textContent = hr;
}

function setHRStatus(msg, cls) {
  const el = document.getElementById('connect-status');
  // Append to existing status if treadmill is already connected, else replace
  const existing = el.textContent;
  if (existing && !existing.includes('HR') && cls === 'ok') {
    el.textContent = existing + '  ·  HR: ' + msg;
  } else {
    el.textContent = msg;
    el.className = 'connect-status' + (cls ? ` ${cls}` : '');
  }
}

// ─────────────────────────────────────────────────────────
//  App state
// ─────────────────────────────────────────────────────────
let plan = [];
let selectedWorkout = null;
let activeSteps = [];
let activeStepIdx = 0;
let stepElapsed = 0;       // seconds elapsed in current step
let totalElapsed = 0;
let totalDuration = 0;
let paused = false;
let timerHandle = null;

// ─────────────────────────────────────────────────────────
//  App object (public API for inline handlers)
// ─────────────────────────────────────────────────────────
const App = {

  async init() {
    try {
      plan = await loadPlan();
      renderPlanList();
    } catch (e) {
      document.getElementById('workout-list').innerHTML =
        `<p style="padding:24px;color:#e74c3c">Could not load plan: ${e.message}</p>`;
    }
    document.getElementById('btn-connect').addEventListener('click', async () => {
      if (!navigator.bluetooth) {
        setConnectStatus('Web Bluetooth not available — open this page in Bluefy', 'err');
        return;
      }
      try { await btConnect(); }
      catch (e) { setConnectStatus(e.message || 'Treadmill connection failed', 'err'); }
    });

    document.getElementById('btn-connect-hr').addEventListener('click', async () => {
      if (!navigator.bluetooth) {
        setConnectStatus('Web Bluetooth not available — open this page in Bluefy', 'err');
        return;
      }
      try { await hrConnect(); }
      catch (e) { setHRStatus(e.message || 'HR connection failed', 'err'); }
    });
  },

  showPlan() {
    showView('plan');
  },

  showDetail(day) {
    const w = plan.find(x => x.day === day);
    if (!w || w.workout_type === 'rest') return;
    selectedWorkout = w;

    document.getElementById('detail-title').textContent = w.goal;
    document.getElementById('detail-meta').innerHTML =
      `${w.date} &nbsp;·&nbsp; ${w.total_minutes} min &nbsp;·&nbsp; <span class="card-badge ${badgeClass(w.workout_type)}">${badgeLabel(w.workout_type)}</span>`;

    // Render segments
    const list = document.getElementById('detail-segments');
    list.innerHTML = '';
    w.steps.forEach((step, i) => {
      const row = document.createElement('div');
      row.className = 'seg-row';
      const inclineStr = step.incline > 0 ? `, ${step.incline}% incline` : '';
      row.innerHTML = `
        <span class="seg-index">${i + 1}</span>
        <div class="seg-info">
          <div class="seg-speed">${step.speed} km/h${inclineStr}</div>
          <div class="seg-detail">${fmtDur(step.duration)}</div>
        </div>
        <span class="seg-dur">${fmtMMSS(step.duration)}</span>`;
      list.appendChild(row);
    });

    document.getElementById('btn-start').disabled = w.steps.length === 0;
    showView('detail');
  },

  startWorkout() {
    if (!selectedWorkout || selectedWorkout.steps.length === 0) return;

    activeSteps    = selectedWorkout.steps;
    activeStepIdx  = 0;
    stepElapsed    = 0;
    totalElapsed   = 0;
    totalDuration  = activeSteps.reduce((s, x) => s + x.duration, 0);
    paused         = false;

    document.getElementById('active-title').textContent = selectedWorkout.goal;
    document.getElementById('btn-pause').textContent = 'Pause';

    showView('active');
    applyStep(0);
    timerHandle = setInterval(tick, 1000);
  },

  togglePause() {
    paused = !paused;
    document.getElementById('btn-pause').textContent = paused ? 'Resume' : 'Pause';
    if (paused) {
      writeCP(new Uint8Array([CP.STOP_PAUSE, 0x02])).catch(() => {});
    } else {
      btStartResume().catch(() => {});
    }
  },

  stopWorkout() {
    clearInterval(timerHandle);
    timerHandle = null;
    btStop().catch(() => {});
    showView('plan');
  },
};

// ─────────────────────────────────────────────────────────
//  Workout tick
// ─────────────────────────────────────────────────────────
function tick() {
  if (paused) return;

  stepElapsed++;
  totalElapsed++;

  const step = activeSteps[activeStepIdx];

  // Advance step?
  if (stepElapsed >= step.duration) {
    activeStepIdx++;
    stepElapsed = 0;
    if (activeStepIdx >= activeSteps.length) {
      // Workout complete
      clearInterval(timerHandle);
      timerHandle = null;
      btStop().catch(() => {});
      showWorkoutDone();
      return;
    }
    applyStep(activeStepIdx);
  }

  updateActiveUI();
}

function applyStep(idx) {
  const step = activeSteps[idx];
  // Send BT commands (fire and forget — UI always updates regardless)
  btStartResume().catch(() => {});
  btSetSpeed(step.speed).catch(() => {});
  btSetIncline(step.incline).catch(() => {});
  updateActiveUI();
}

function updateActiveUI() {
  const step = activeSteps[activeStepIdx];
  const remaining = step.duration - stepElapsed;

  // Speed / incline
  document.getElementById('active-speed').textContent = step.speed.toFixed(1);
  document.getElementById('active-incline').textContent = step.incline;

  // Countdown
  document.getElementById('active-seg-time').textContent = fmtMMSS(remaining);

  // Ring progress (0 = full, 327 = empty)
  const CIRCUMFERENCE = 327;
  const fraction = remaining / step.duration;
  document.getElementById('timer-ring-fg').style.strokeDashoffset =
    CIRCUMFERENCE * (1 - fraction);

  // Segment label
  const inclineStr = step.incline > 0 ? ` · ${step.incline}% incline` : '';
  document.getElementById('active-seg-label').textContent =
    `Segment ${activeStepIdx + 1} of ${activeSteps.length}${inclineStr}`;

  // Next segment
  const next = activeSteps[activeStepIdx + 1];
  document.getElementById('active-next').textContent = next
    ? `Next: ${next.speed} km/h${next.incline > 0 ? ` · ${next.incline}%` : ''} for ${fmtDur(next.duration)}`
    : 'Last segment';

  // Overall progress
  const pct = Math.min(100, (totalElapsed / totalDuration) * 100);
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-label').textContent =
    `${fmtMMSS(totalElapsed)} / ${fmtMMSS(totalDuration)}`;
}

function showWorkoutDone() {
  // Simple done state — replace active-main content
  document.getElementById('active-speed').textContent = '✓';
  document.getElementById('active-incline').textContent = '–';
  document.getElementById('active-seg-time').textContent = '0:00';
  document.getElementById('active-seg-label').textContent = 'Workout complete!';
  document.getElementById('active-next').textContent = '';
  document.getElementById('progress-bar').style.width = '100%';
  document.getElementById('btn-pause').disabled = true;
}

// ─────────────────────────────────────────────────────────
//  Plan list renderer
// ─────────────────────────────────────────────────────────
function renderPlanList() {
  const container = document.getElementById('workout-list');
  container.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);

  let currentMonth = '';

  for (const w of plan) {
    // Month header
    const month = w.date.slice(0, 7); // "2026-04"
    if (month !== currentMonth) {
      currentMonth = month;
      const mh = document.createElement('div');
      mh.className = 'month-header';
      const d = new Date(w.date + 'T00:00:00');
      mh.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      container.appendChild(mh);
    }

    const card = document.createElement('div');
    const isToday = w.date === today;
    const isPast  = w.date < today;
    const isRest  = w.workout_type === 'rest';

    card.className = 'workout-card' +
      (isToday ? ' today' : '') +
      (isPast  ? ' past'  : '') +
      (isRest  ? ' rest'  : '');

    const d = new Date(w.date + 'T00:00:00');
    const dayNum  = d.getDate();
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });

    const metaStr = isRest
      ? w.goal
      : `${w.total_minutes} min · ${w.segments.length > 60 ? w.segments.slice(0, 60) + '…' : w.segments}`;

    card.innerHTML = `
      <div class="card-date-block">
        <div class="card-day-num">${dayNum}</div>
        <div class="card-day-name">${dayName}</div>
      </div>
      <div class="card-body">
        <div class="card-name">${isToday ? '▶ ' : ''}${w.goal}</div>
        <div class="card-meta">${metaStr}</div>
      </div>
      <span class="card-badge ${badgeClass(w.workout_type)}">${badgeLabel(w.workout_type)}</span>`;

    if (!isRest) {
      card.addEventListener('click', () => App.showDetail(w.day));
    }
    container.appendChild(card);
  }
}

// ─────────────────────────────────────────────────────────
//  View switcher
// ─────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  window.scrollTo(0, 0);
}

// ─────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
