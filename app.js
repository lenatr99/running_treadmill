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
let btTreadmillData = null;
let btCommandChain = Promise.resolve();
let currentTreadmillSpeed = null;
let currentTreadmillIncline = null;
let wakeLockSentinel = null;
let noSleep = null;
let noSleepEnabled = false;

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
  btTreadmillData = await service.getCharacteristic(TREADMILL_DATA_CHAR);
  btCommandChain = Promise.resolve();

  // Enable indications so we get control-point responses
  await btControlPoint.startNotifications();
  btControlPoint.addEventListener('characteristicvaluechanged', onCpResponse);

  // Subscribe to live treadmill telemetry so the UI reflects actual speed/incline.
  await btTreadmillData.startNotifications();
  btTreadmillData.addEventListener('characteristicvaluechanged', onTreadmillData);

  // Request control
  await writeCP(new Uint8Array([CP.REQUEST_CONTROL]));
  setConnectStatus(`Connected: ${btDevice.name || 'Treadmill'}`, 'ok');
  document.getElementById('btn-connect').classList.add('connected');
  document.getElementById('connect-label').textContent = 'Connected';
}

function onBtDisconnected() {
  btControlPoint = null;
  btTreadmillData = null;
  btCommandChain = Promise.resolve();
  currentTreadmillSpeed = null;
  currentTreadmillIncline = null;
  setConnectStatus('Disconnected — tap Connect to reconnect', 'err');
  document.getElementById('btn-connect').classList.remove('connected');
  document.getElementById('connect-label').textContent = 'Connect';
  updateActiveUI();
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
  const op = btCommandChain.then(() => btControlPoint.writeValueWithResponse(bytes));
  btCommandChain = op.catch(() => {});
  await op;
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

function onTreadmillData(event) {
  const data = event.target.value;
  if (data.byteLength < 4) return;

  const flags = data.getUint16(0, true);
  let offset = 2;

  // Bit 0 is inverted in FTMS treadmill data: 0 means instantaneous speed is present.
  if ((flags & 0x0001) === 0 && data.byteLength >= offset + 2) {
    currentTreadmillSpeed = data.getUint16(offset, true) / 100;
    offset += 2;
  }

  if (flags & 0x0002) offset += 2; // Average speed
  if (flags & 0x0004) offset += 3; // Total distance

  if (flags & 0x0008 && data.byteLength >= offset + 4) {
    currentTreadmillIncline = data.getInt16(offset, true) / 10;
  }

  if ((workoutActive || awaitingWorkoutStop) && !workoutFinishing && startupWarmupRemaining === 0) {
    if ((currentTreadmillSpeed ?? 0) >= 0.8) {
      hasSeenWorkoutMotion = true;
    }

    if (hasSeenWorkoutMotion && (currentTreadmillSpeed ?? 0) <= 0.1) {
      zeroSpeedStreak++;
      if (zeroSpeedStreak >= 2) {
        finalizeWorkout('treadmill', false).catch(() => {});
        return;
      }
    } else {
      zeroSpeedStreak = 0;
    }
  }

  updateActiveUI();
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
let startupWarmupRemaining = 0;

// Workout recording
let workoutSamples = [];   // [{speed_kmh, hr_bpm, incline_pct}] one per second
let workoutStartTime = null;
let workoutName = '';
let workoutActive = false;
let awaitingWorkoutStop = false;
let workoutFinishing = false;
let hasSeenWorkoutMotion = false;
let zeroSpeedStreak = 0;
const STARTUP_WARMUP_SECONDS = 5;

function roundToStep(value, step) {
  return Number((Math.round(value / step) * step).toFixed(3));
}

function clamp(value, min, max = Infinity) {
  return Math.min(max, Math.max(min, value));
}

function getActiveStep() {
  return activeSteps[activeStepIdx] || null;
}

function getDisplayedSpeed() {
  const step = getActiveStep();
  return currentTreadmillSpeed ?? step?.speed ?? null;
}

function getDisplayedIncline() {
  const step = getActiveStep();
  return currentTreadmillIncline ?? step?.incline ?? null;
}

function getPlannedProgressSeconds() {
  let seconds = stepElapsed;
  for (let i = 0; i < activeStepIdx; i++) {
    seconds += activeSteps[i].duration;
  }
  return seconds;
}

function shouldHoldWakeLock() {
  return workoutActive || awaitingWorkoutStop || startupWarmupRemaining > 0;
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLockSentinel || document.visibilityState !== 'visible') return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    });
  } catch (_) {
    // Ignore unsupported or denied wake lock requests.
  }
}

async function enableNoSleep() {
  if (noSleepEnabled || !noSleep || document.visibilityState !== 'visible') return;
  try {
    await noSleep.enable();
    noSleepEnabled = true;
  } catch (_) {
    // Ignore fallback wake lock failures.
  }
}

async function releaseWakeLock() {
  if (!wakeLockSentinel) return;
  try {
    await wakeLockSentinel.release();
  } catch (_) {
    // Ignore release failures.
  }
  wakeLockSentinel = null;
}

function disableNoSleep() {
  if (!noSleepEnabled || !noSleep) return;
  try {
    noSleep.disable();
  } catch (_) {
    // Ignore fallback wake lock failures.
  }
  noSleepEnabled = false;
}

async function syncWakeLock() {
  if (shouldHoldWakeLock()) {
    await requestWakeLock();
    await enableNoSleep();
  } else {
    await releaseWakeLock();
    disableNoSleep();
  }
}

function resetWorkoutRuntimeState() {
  activeSteps = [];
  activeStepIdx = 0;
  stepElapsed = 0;
  totalElapsed = 0;
  totalDuration = 0;
  paused = false;
  timerHandle = null;
  startupWarmupRemaining = 0;
  workoutActive = false;
  awaitingWorkoutStop = false;
  workoutFinishing = false;
  hasSeenWorkoutMotion = false;
  zeroSpeedStreak = 0;
  currentTreadmillSpeed = null;
  currentTreadmillIncline = null;
  syncWakeLock().catch(() => {});
}

function updateActiveControlState() {
  const skipBtn = document.getElementById('btn-skip');
  const stopBtn = document.getElementById('btn-stop-active');
  const adjustButtons = document.querySelectorAll('.btn-adjust');
  if (!skipBtn || !stopBtn) return;

  skipBtn.disabled = awaitingWorkoutStop;
  adjustButtons.forEach(btn => { btn.disabled = workoutFinishing; });
  stopBtn.textContent = awaitingWorkoutStop ? 'Finish' : 'Stop';
}

// ─────────────────────────────────────────────────────────
//  App object (public API for inline handlers)
// ─────────────────────────────────────────────────────────
const App = {

  async init() {
    // Handle Strava OAuth callback before rendering anything else
    await handleStravaCallback();
    if (typeof NoSleep !== 'undefined') {
      noSleep = new NoSleep();
    }
    window.addEventListener('storage', onStravaStorage);
    await handleStoredStravaCode();
    document.addEventListener('visibilitychange', () => {
      syncWakeLock().catch(() => {});
    });
    updateStravaButtonState();

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

    clearInterval(timerHandle);
    activeSteps      = selectedWorkout.steps.map(step => ({ ...step }));
    activeStepIdx    = 0;
    stepElapsed      = 0;
    totalElapsed     = 0;
    totalDuration    = activeSteps.reduce((s, x) => s + x.duration, 0);
    paused           = false;
    workoutSamples   = [];
    workoutStartTime = new Date();
    workoutName      = selectedWorkout.goal;
    workoutActive    = true;
    awaitingWorkoutStop = false;
    workoutFinishing = false;
    hasSeenWorkoutMotion = false;
    zeroSpeedStreak = 0;
    startupWarmupRemaining = STARTUP_WARMUP_SECONDS;
    currentTreadmillSpeed = null;
    currentTreadmillIncline = null;

    document.getElementById('active-title').textContent = selectedWorkout.goal;

    showView('active');
    updateActiveControlState();
    syncWakeLock().catch(() => {});
    startWorkoutWarmup();
    timerHandle = setInterval(tick, 1000);
  },

  async stopWorkout() {
    await finalizeWorkout('app', true);
  },

  async adjustSpeed(delta) {
    const step = getActiveStep();
    if (!step || workoutFinishing) return;

    const baseSpeed = startupWarmupRemaining > 0 ? step.speed : (getDisplayedSpeed() ?? step.speed);
    step.speed = roundToStep(clamp(baseSpeed + delta, 0), 0.1);
    if (startupWarmupRemaining > 0) {
      updateActiveUI();
      return;
    }
    currentTreadmillSpeed = step.speed;
    await btSetSpeed(step.speed).catch(() => {});
    updateActiveUI();
  },

  async adjustIncline(delta) {
    const step = getActiveStep();
    if (!step || workoutFinishing) return;

    const baseIncline = startupWarmupRemaining > 0 ? step.incline : (getDisplayedIncline() ?? step.incline);
    step.incline = roundToStep(clamp(baseIncline + delta, 0), 0.5);
    if (startupWarmupRemaining > 0) {
      updateActiveUI();
      return;
    }
    currentTreadmillIncline = step.incline;
    await btSetIncline(step.incline).catch(() => {});
    updateActiveUI();
  },

  skipSegment() {
    if (!getActiveStep() || awaitingWorkoutStop || workoutFinishing) return;
    advanceToStep(activeStepIdx + 1);
  },
};

// ─────────────────────────────────────────────────────────
//  Workout tick
// ─────────────────────────────────────────────────────────
function tick() {
  if (workoutFinishing || (!workoutActive && !awaitingWorkoutStop)) return;

  const currentStep = getActiveStep();
  if (!currentStep) return;

  if (startupWarmupRemaining > 0) {
    startupWarmupRemaining--;
    currentTreadmillSpeed = 1.0;
    currentTreadmillIncline = 0;
    if (startupWarmupRemaining === 0) {
      currentTreadmillSpeed = null;
      currentTreadmillIncline = null;
      applyCurrentStepTarget().catch(() => {});
    }
    updateActiveUI();
    return;
  }

  totalElapsed++;

  workoutSamples.push({
    speed_kmh:   getDisplayedSpeed() ?? (awaitingWorkoutStop ? 1.0 : currentStep.speed),
    hr_bpm:      currentHR || 0,
    incline_pct: getDisplayedIncline() ?? (awaitingWorkoutStop ? 0 : currentStep.incline),
  });

  if (awaitingWorkoutStop) {
    updateActiveUI();
    return;
  }

  stepElapsed++;

  // Advance step?
  if (stepElapsed >= currentStep.duration) {
    advanceToStep(activeStepIdx + 1);
    return;
  }

  updateActiveUI();
}

async function applyCurrentStepTarget() {
  const step = getActiveStep();
  if (!step) return;
  await btSetSpeed(step.speed).catch(() => {});
  await btSetIncline(step.incline).catch(() => {});
  updateActiveUI();
}

async function startWorkoutWarmup() {
  await btStartResume().catch(() => {});
  currentTreadmillSpeed = 1.0;
  currentTreadmillIncline = 0;
  await btSetSpeed(1.0).catch(() => {});
  await btSetIncline(0).catch(() => {});
  updateActiveUI();
}

async function startCooldownMode() {
  awaitingWorkoutStop = true;
  workoutActive = false;
  paused = false;
  zeroSpeedStreak = 0;
  startupWarmupRemaining = 0;
  currentTreadmillSpeed = 1.0;
  currentTreadmillIncline = 0;

  await btSetSpeed(1.0).catch(() => {});
  await btSetIncline(0).catch(() => {});
  updateActiveControlState();
  syncWakeLock().catch(() => {});
  updateActiveUI();
}

function advanceToStep(nextIdx) {
  activeStepIdx = nextIdx;
  stepElapsed = 0;

  if (activeStepIdx >= activeSteps.length) {
    activeStepIdx = Math.max(0, activeSteps.length - 1);
    stepElapsed = getActiveStep()?.duration || 0;
    startCooldownMode().catch(() => {});
    return;
  }

  applyCurrentStepTarget().catch(() => {});
  updateActiveUI();
}

async function finalizeWorkout(origin, sendStopCommand) {
  if (workoutFinishing || (!workoutActive && !awaitingWorkoutStop && workoutSamples.length === 0)) return;

  workoutFinishing = true;
  workoutActive = false;
  awaitingWorkoutStop = false;
  paused = false;
  clearInterval(timerHandle);
  timerHandle = null;
  startupWarmupRemaining = 0;
  updateActiveControlState();

  if (sendStopCommand) {
    currentTreadmillSpeed = 0;
    currentTreadmillIncline = 0;
    updateActiveUI();
    await btStop().catch(() => {});
  }

  showWorkoutDone();

  const wantsUpload = window.confirm(
    origin === 'treadmill'
      ? 'Workout stopped on the treadmill. Upload it to Strava?'
      : 'Workout stopped. Upload it to Strava?'
  );

  if (wantsUpload) {
    setTimeout(() => App.uploadToStrava(), 0);
  }

  resetWorkoutRuntimeState();
}

function updateActiveUI() {
  const step = getActiveStep();
  if (!step) return;
  const remaining = Math.max(0, step.duration - stepElapsed);
  const displayedSpeed = getDisplayedSpeed();
  const displayedIncline = getDisplayedIncline();
  const CIRCUMFERENCE = 327;

  // Actual speed / incline from treadmill notifications when available.
  document.getElementById('active-speed').textContent =
    displayedSpeed != null ? displayedSpeed.toFixed(1) : step.speed.toFixed(1);
  document.getElementById('active-incline').textContent =
    displayedIncline != null ? displayedIncline.toFixed(1) : step.incline.toFixed(1);

  if (startupWarmupRemaining > 0) {
    const warmupFraction = startupWarmupRemaining / STARTUP_WARMUP_SECONDS;
    document.getElementById('active-seg-time').textContent = fmtMMSS(startupWarmupRemaining);
    document.getElementById('timer-ring-fg').style.strokeDashoffset =
      CIRCUMFERENCE * (1 - warmupFraction);
    document.getElementById('active-seg-label').textContent = 'Starting workout';
    document.getElementById('active-next').textContent =
      `Walking at 1.0 km/h for ${startupWarmupRemaining}s, then ${step.speed.toFixed(1)} km/h${step.incline > 0 ? ` · ${step.incline.toFixed(1)}%` : ''}.`;
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-label').textContent =
      `Warmup ${STARTUP_WARMUP_SECONDS - startupWarmupRemaining}/${STARTUP_WARMUP_SECONDS}s`;
    updateActiveControlState();
    return;
  }

  if (awaitingWorkoutStop) {
    document.getElementById('active-seg-time').textContent = 'done';
    document.getElementById('timer-ring-fg').style.strokeDashoffset = CIRCUMFERENCE;
    document.getElementById('active-seg-label').textContent = 'Workout complete';
    document.getElementById('active-next').textContent =
      'Cooldown mode: adjust speed or incline if you want to keep going, then stop on the app or treadmill when finished.';
    document.getElementById('progress-bar').style.width = '100%';
    document.getElementById('progress-label').textContent =
      `Plan done · total ${fmtMMSS(totalElapsed)}`;
    updateActiveControlState();
    return;
  }

  // Countdown
  document.getElementById('active-seg-time').textContent = fmtMMSS(remaining);

  // Ring progress (0 = full, 327 = empty)
  const fraction = remaining / step.duration;
  document.getElementById('timer-ring-fg').style.strokeDashoffset =
    CIRCUMFERENCE * (1 - fraction);

  // Segment label + current segment targets
  const inclineStr = step.incline > 0 ? ` · target ${step.incline.toFixed(1)}%` : '';
  document.getElementById('active-seg-label').textContent =
    `Segment ${activeStepIdx + 1} of ${activeSteps.length} · target ${step.speed.toFixed(1)} km/h${inclineStr}`;

  // Next segment
  const next = activeSteps[activeStepIdx + 1];
  document.getElementById('active-next').textContent = next
    ? `Next: ${next.speed.toFixed(1)} km/h${next.incline > 0 ? ` · ${next.incline.toFixed(1)}%` : ''} for ${fmtDur(next.duration)}`
    : 'Last segment';

  // Overall plan progress
  const pct = Math.min(100, (getPlannedProgressSeconds() / totalDuration) * 100);
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-label').textContent =
    `${fmtMMSS(getPlannedProgressSeconds())} / ${fmtMMSS(totalDuration)}`;
  updateActiveControlState();
}

function showWorkoutDone() {
  showSummary();
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
//  Workout summary + stats
// ─────────────────────────────────────────────────────────
function computeStats() {
  let distanceM = 0, totalHR = 0, hrCount = 0, maxHR = 0, maxSpeedMs = 0;
  for (const s of workoutSamples) {
    const speedMs = s.speed_kmh / 3.6;
    distanceM += speedMs;
    maxSpeedMs = Math.max(maxSpeedMs, speedMs);
    if (s.hr_bpm > 0) { totalHR += s.hr_bpm; hrCount++; maxHR = Math.max(maxHR, s.hr_bpm); }
  }
  const durationSec = workoutSamples.length;
  const avgHR = hrCount ? Math.round(totalHR / hrCount) : 0;
  const avgPaceSec = distanceM > 0 ? (durationSec / (distanceM / 1000)) : 0;
  return { distanceM, durationSec, avgHR, maxHR, maxSpeedMs, avgPaceSec };
}

function fmtPace(secPerKm) {
  if (!secPerKm) return '–';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showSummary() {
  const stats = computeStats();
  document.getElementById('summary-title').textContent = workoutName;
  document.getElementById('summary-date').textContent =
    workoutStartTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const grid = document.getElementById('summary-stats');
  const cards = [
    { label: 'Distance',  value: (stats.distanceM / 1000).toFixed(2) + ' km', cls: '' },
    { label: 'Time',      value: fmtMMSS(stats.durationSec),                  cls: '' },
    { label: 'Avg Pace',  value: fmtPace(stats.avgPaceSec) + ' /km',          cls: '' },
    { label: 'Avg HR',    value: stats.avgHR ? stats.avgHR + ' bpm' : '–',    cls: 'hr' },
    { label: 'Max HR',    value: stats.maxHR ? stats.maxHR + ' bpm' : '–',    cls: 'hr' },
    { label: 'Max Speed', value: stats.maxSpeedMs ? (stats.maxSpeedMs * 3.6).toFixed(1) + ' km/h' : '–', cls: '' },
  ];
  grid.innerHTML = cards.map(c =>
    `<div class="stat-card ${c.cls}">
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>`
  ).join('');

  // Show upload button only if we have samples
  document.getElementById('btn-upload').disabled = workoutSamples.length === 0;
  document.getElementById('upload-status').className = 'upload-status hidden';

  showView('summary');
}

// ─────────────────────────────────────────────────────────
//  TCX generation
// ─────────────────────────────────────────────────────────
function generateTCX() {
  let distanceM = 0;
  const trackpoints = workoutSamples.map((s, i) => {
    const t = new Date(workoutStartTime.getTime() + i * 1000);
    const speedMs = s.speed_kmh / 3.6;
    distanceM += speedMs;
    const hrTag = s.hr_bpm > 0
      ? `<HeartRateBpm><Value>${s.hr_bpm}</Value></HeartRateBpm>`
      : '';
    return `          <Trackpoint>
            <Time>${t.toISOString()}</Time>
            <DistanceMeters>${distanceM.toFixed(2)}</DistanceMeters>
            ${hrTag}
            <Extensions>
              <ns3:TPX>
                <ns3:Speed>${speedMs.toFixed(4)}</ns3:Speed>
              </ns3:TPX>
            </Extensions>
          </Trackpoint>`;
  });

  const stats = computeStats();
  const avgHRTag = stats.avgHR
    ? `<AverageHeartRateBpm><Value>${stats.avgHR}</Value></AverageHeartRateBpm>` : '';
  const maxHRTag = stats.maxHR
    ? `<MaximumHeartRateBpm><Value>${stats.maxHR}</Value></MaximumHeartRateBpm>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Activities>
    <Activity Sport="Running">
      <Id>${workoutStartTime.toISOString()}</Id>
      <Lap StartTime="${workoutStartTime.toISOString()}">
        <TotalTimeSeconds>${stats.durationSec}</TotalTimeSeconds>
        <DistanceMeters>${stats.distanceM.toFixed(2)}</DistanceMeters>
        <MaximumSpeed>${stats.maxSpeedMs.toFixed(4)}</MaximumSpeed>
        ${avgHRTag}
        ${maxHRTag}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${trackpoints.join('\n')}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}

// ─────────────────────────────────────────────────────────
//  Strava OAuth2
// ─────────────────────────────────────────────────────────
function currentAppDir() {
  const path = window.location.pathname;
  return path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1);
}

function stravaRedirectUri() {
  return window.location.origin + currentAppDir() + 'strava_callback.html';
}

function buildStravaAuthUrl(clientId) {
  const redirect = encodeURIComponent(stravaRedirectUri());
  return (
    `https://www.strava.com/oauth/authorize?client_id=${clientId}` +
    `&response_type=code&redirect_uri=${redirect}` +
    `&approval_prompt=auto&scope=activity:write`
  );
}

function parseStravaAuthCode(value) {
  const raw = (value || '').trim();
  if (!raw) return '';

  const directMatch = raw.match(/^[A-Za-z0-9_-]+$/);
  if (directMatch) return raw;

  const codeMatch = raw.match(/[?&]code=([^&]+)/);
  return codeMatch ? decodeURIComponent(codeMatch[1]) : '';
}

function setStravaAuthStatus(msg, cls) {
  const el = document.getElementById('strava-auth-status');
  if (!el) return;
  if (!msg) {
    el.textContent = '';
    el.className = 'strava-auth-status hidden';
    return;
  }
  el.textContent = msg;
  el.className = 'strava-auth-status' + (cls ? ` ${cls}` : '');
}

function saveStravaClientConfigFromInputs() {
  const inputClientId = document.getElementById('input-client-id').value.trim();
  const inputClientSecret = document.getElementById('input-client-secret').value.trim();
  const savedClientId = localStorage.getItem('stravaClientId') || '';
  const savedClientSecret = localStorage.getItem('stravaClientSecret') || '';

  const clientId = inputClientId || savedClientId;
  const clientSecret = inputClientSecret || (clientId === savedClientId ? savedClientSecret : '');
  if (!clientId || !clientSecret) {
    throw new Error('Enter Client ID and Client Secret first.');
  }

  localStorage.setItem('stravaClientId', clientId);
  if (inputClientSecret) {
    localStorage.setItem('stravaClientSecret', inputClientSecret);
  }

  return { clientId, clientSecret };
}

async function exchangeStravaCode(code) {
  const clientId = localStorage.getItem('stravaClientId');
  const clientSecret = localStorage.getItem('stravaClientSecret');
  if (!clientId || !clientSecret) {
    throw new Error('Missing Strava client settings in Bluefy.');
  }

  const resp = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(data.message || 'Token exchange failed');

  const athleteName =
    `${data.athlete?.firstname || ''} ${data.athlete?.lastname || ''}`.trim() || 'Athlete';

  localStorage.setItem('stravaAccessToken', data.access_token);
  localStorage.setItem('stravaRefreshToken', data.refresh_token);
  localStorage.setItem('stravaTokenExpiry', data.expires_at);
  localStorage.setItem('stravaAthleteName', athleteName);
  localStorage.removeItem('stravaPendingCode');

  updateStravaButtonState();
  return athleteName;
}

async function handleStravaCallback() {
  const code = parseStravaAuthCode(window.location.href);
  if (!code) return;

  // Preserve support for the old redirect URI that pointed back to the app page.
  window.history.replaceState({}, document.title, window.location.pathname);

  setUploadStatus('Connecting to Strava…', '');
  try {
    await exchangeStravaCode(code);
  } catch (e) {
    console.error('Strava token exchange failed', e);
    setUploadStatus(`Strava connect failed: ${e.message}`, 'err');
  }
}

async function handleStoredStravaCode() {
  const code = localStorage.getItem('stravaPendingCode');
  if (!code) return false;

  setStravaAuthStatus('Finishing Strava connection…', '');
  try {
    const athleteName = await exchangeStravaCode(code);
    setStravaAuthStatus(`Connected as ${athleteName}`, 'ok');
    App.closeSettings();
    return true;
  } catch (e) {
    console.error('Stored Strava code exchange failed', e);
    setStravaAuthStatus(`Connection failed: ${e.message}`, 'err');
    return false;
  }
}

async function getValidStravaToken() {
  const expiry = parseInt(localStorage.getItem('stravaTokenExpiry') || '0');
  const now = Math.floor(Date.now() / 1000);

  if (expiry - now > 60) {
    return localStorage.getItem('stravaAccessToken');
  }

  // Refresh
  const clientId     = localStorage.getItem('stravaClientId');
  const clientSecret = localStorage.getItem('stravaClientSecret');
  const refreshToken = localStorage.getItem('stravaRefreshToken');
  if (!clientId || !clientSecret || !refreshToken) return null;

  const resp = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!data.access_token) return null;

  localStorage.setItem('stravaAccessToken',  data.access_token);
  localStorage.setItem('stravaRefreshToken', data.refresh_token);
  localStorage.setItem('stravaTokenExpiry',  data.expires_at);
  return data.access_token;
}

function updateStravaButtonState() {
  const name = localStorage.getItem('stravaAthleteName');
  const btn  = document.getElementById('btn-strava');
  const lbl  = document.getElementById('strava-label');
  if (name) {
    btn.classList.add('connected');
    lbl.textContent = name.split(' ')[0]; // first name only
  } else {
    btn.classList.remove('connected');
    lbl.textContent = 'Strava';
  }
}

async function onStravaStorage(event) {
  if (event.key === 'stravaPendingCode' && event.newValue) {
    await handleStoredStravaCode();
  }

  if (event.key === 'stravaAthleteName') {
    updateStravaButtonState();
    if (event.newValue) {
      setStravaAuthStatus(`Connected as ${event.newValue}`, 'ok');
      App.closeSettings();
    }
  }
}

// ─────────────────────────────────────────────────────────
//  Strava upload
// ─────────────────────────────────────────────────────────
Object.assign(App, {
  async uploadToStrava() {
    const btn = document.getElementById('btn-upload');
    btn.disabled = true;
    setUploadStatus('Uploading…', '');

    try {
      const token = await getValidStravaToken();
      if (!token) {
        setUploadStatus('Not connected to Strava — tap the Strava button to connect', 'err');
        btn.disabled = false;
        return;
      }

      const tcx  = generateTCX();
      const blob = new Blob([tcx], { type: 'application/tcx+xml' });
      const form = new FormData();
      form.append('file', blob, 'workout.tcx');
      form.append('name',       workoutName);
      form.append('sport_type', 'VirtualRun');
      form.append('trainer',    '1');
      form.append('data_type',  'tcx');

      const uploadResp = await fetch('https://www.strava.com/api/v3/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      if (!uploadResp.ok) {
        const err = await uploadResp.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${uploadResp.status}`);
      }

      const upload = await uploadResp.json();

      // Poll until Strava finishes processing
      setUploadStatus('Processing…', '');
      const activityId = await pollUpload(token, upload.id);
      setUploadStatus(`Uploaded! View on Strava (activity ${activityId})`, 'ok');

    } catch (e) {
      setUploadStatus(`Upload failed: ${e.message}`, 'err');
      btn.disabled = false;
    }
  },

  openSettings() {
    document.getElementById('redirect-uri-hint').textContent = stravaRedirectUri();
    // Pre-fill saved values
    document.getElementById('input-client-id').value     = localStorage.getItem('stravaClientId') || '';
    document.getElementById('input-client-secret').value = '';  // never pre-fill secrets
    document.getElementById('input-auth-link').value =
      localStorage.getItem('stravaClientId') ? buildStravaAuthUrl(localStorage.getItem('stravaClientId')) : '';
    document.getElementById('input-auth-code').value = '';
    setStravaAuthStatus('', '');

    const name = localStorage.getItem('stravaAthleteName');
    if (name) {
      document.getElementById('strava-athlete-name').textContent = `Connected as ${name}`;
      document.getElementById('strava-connected-info').classList.remove('hidden');
      document.getElementById('strava-setup').classList.add('hidden');
    } else {
      document.getElementById('strava-connected-info').classList.add('hidden');
      document.getElementById('strava-setup').classList.remove('hidden');
    }

    document.getElementById('settings-overlay').classList.remove('hidden');
    document.getElementById('settings-modal').classList.remove('hidden');
  },

  closeSettings() {
    document.getElementById('settings-overlay').classList.add('hidden');
    document.getElementById('settings-modal').classList.add('hidden');
  },

  stravaAuth() {
    let clientId;
    try {
      ({ clientId } = saveStravaClientConfigFromInputs());
    } catch (e) {
      alert(e.message);
      return;
    }
    setStravaAuthStatus('', '');

    // Open in a new tab so Bluefy keeps this page (and BLE connections) alive.
    // The callback page writes the auth code to localStorage so this tab can finish the exchange.
    const popup = window.open(buildStravaAuthUrl(clientId), '_blank');
    if (!popup) {
      // Fallback: popup was blocked — navigate the whole page instead.
      window.location.href = buildStravaAuthUrl(clientId);
    }
  },

  async prepareStravaSafariAuth() {
    let clientId;
    try {
      ({ clientId } = saveStravaClientConfigFromInputs());
    } catch (e) {
      alert(e.message);
      return;
    }

    const authUrl = buildStravaAuthUrl(clientId);
    document.getElementById('input-auth-link').value = authUrl;

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(authUrl);
        setStravaAuthStatus(
          'Safari login link copied. Open it in Safari or Chrome, approve Strava, then paste the callback URL below.',
          'ok'
        );
        return;
      } catch (_) {
        // Fall through to manual long-press copy instructions.
      }
    }

    setStravaAuthStatus(
      'Open the auth link above in Safari or Chrome, approve Strava, then paste the callback URL below.',
      ''
    );
  },

  async completeStravaManualAuth() {
    try {
      saveStravaClientConfigFromInputs();
    } catch (e) {
      alert(e.message);
      return;
    }

    const raw = document.getElementById('input-auth-code').value;
    const code = parseStravaAuthCode(raw);
    if (!code) {
      setStravaAuthStatus('Paste the full callback URL or the code from the callback page.', 'err');
      return;
    }

    setStravaAuthStatus('Connecting to Strava…', '');
    try {
      const athleteName = await exchangeStravaCode(code);
      document.getElementById('input-auth-code').value = '';
      setStravaAuthStatus(`Connected as ${athleteName}`, 'ok');
      App.closeSettings();
    } catch (e) {
      console.error('Manual Strava code exchange failed', e);
      setStravaAuthStatus(`Connection failed: ${e.message}`, 'err');
    }
  },

  stravaDisconnect() {
    ['stravaAccessToken','stravaRefreshToken','stravaTokenExpiry','stravaAthleteName','stravaPendingCode']
      .forEach(k => localStorage.removeItem(k));
    document.getElementById('input-auth-code').value = '';
    setStravaAuthStatus('', '');
    updateStravaButtonState();
    App.closeSettings();
  },
});

async function pollUpload(token, uploadId, attempts = 0) {
  if (attempts > 15) throw new Error('Timed out waiting for Strava to process upload');
  await new Promise(r => setTimeout(r, 2000));
  const resp = await fetch(`https://www.strava.com/api/v3/uploads/${uploadId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.error)     throw new Error(data.error);
  if (data.activity_id) return data.activity_id;
  return pollUpload(token, uploadId, attempts + 1);
}

function setUploadStatus(msg, cls) {
  const el = document.getElementById('upload-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'upload-status' + (cls ? ` ${cls}` : '');
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
