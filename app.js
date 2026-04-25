import {
  badgeClass,
  badgeLabel,
  clamp,
  dayLabel,
  fmtDur,
  fmtMMSS,
  loadPlan,
  roundToStep,
} from './js/plan.js';
import { renderActiveProgressGraph, renderDetailWorkoutChart } from './js/charts.js';
import { getCompletedDays, markDayCompleted, toggleDayCompleted } from './js/completionStore.js';
import { FtmsTreadmill } from './js/devices/ftms.js';
import { HeartRateMonitor } from './js/devices/hr.js';
import {
  buildStravaAuthUrl,
  exchangeStravaCode,
  getValidStravaToken,
  parseStravaAuthCode,
  pollUpload,
  saveStravaClientConfigFromInputs,
  stravaRedirectUri,
} from './js/strava.js';

let plan = [];
let selectedWorkout = null;
let activeSteps = [];
let activeStepIdx = 0;
let stepElapsed = 0;
let totalElapsed = 0;
let totalDuration = 0;
let timerHandle = null;
let startupWarmupRemaining = 0;

let workoutSamples = [];
let workoutStartTime = null;
let workoutName = '';
let workoutActive = false;
let awaitingWorkoutStop = false;
let workoutFinishing = false;
let hasSeenWorkoutMotion = false;
let zeroSpeedStreak = 0;
let completedMarkedForSession = false;

let currentTreadmillSpeed = null;
let currentTreadmillIncline = null;
let currentHR = null;
let wakeLockSentinel = null;
let noSleep = null;
let noSleepEnabled = false;

const STARTUP_WARMUP_SECONDS = 5;
const TIMER_RING_CIRCUMFERENCE = 327;

const treadmill = new FtmsTreadmill({
  onStatus: setConnectStatus,
  onWarning: message => setConnectStatus(message, 'err'),
  onDisconnected: () => {
    document.getElementById('btn-connect')?.classList.remove('connected');
    const label = document.getElementById('connect-label');
    if (label) label.textContent = 'Connect';
  },
  onTelemetry: ({ speed, incline }) => {
    currentTreadmillSpeed = speed;
    currentTreadmillIncline = incline;
    handleTreadmillMotionStop();
    updateActiveUI();
  },
});

const hrMonitor = new HeartRateMonitor({
  onStatus: setHRStatus,
  onDisconnected: () => {
    document.getElementById('btn-connect-hr')?.classList.remove('connected');
    const label = document.getElementById('connect-hr-label');
    if (label) label.textContent = 'Polar H10';
  },
  onHeartRate: hr => {
    currentHR = hr;
    const el = document.getElementById('active-hr');
    if (el) el.textContent = hr || '-';
  },
});

const App = {
  async init() {
    await handleStravaCallback();
    if (typeof NoSleep !== 'undefined') noSleep = new NoSleep();

    window.addEventListener('storage', onStravaStorage);
    document.addEventListener('visibilitychange', () => {
      syncWakeLock().catch(() => {});
    });

    await handleStoredStravaCode();
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
        setConnectStatus('Web Bluetooth not available - open this page in Bluefy', 'err');
        return;
      }
      try {
        const device = await treadmill.connect();
        document.getElementById('btn-connect').classList.add('connected');
        document.getElementById('connect-label').textContent = device?.name || 'Connected';
      } catch (e) {
        setConnectStatus(e.message || 'Treadmill connection failed', 'err');
      }
    });

    document.getElementById('btn-connect-hr').addEventListener('click', async () => {
      if (!navigator.bluetooth) {
        setConnectStatus('Web Bluetooth not available - open this page in Bluefy', 'err');
        return;
      }
      try {
        const device = await hrMonitor.connect();
        document.getElementById('btn-connect-hr').classList.add('connected');
        document.getElementById('connect-hr-label').textContent = device?.name || 'HR Monitor';
      } catch (e) {
        setHRStatus(e.message || 'HR connection failed', 'err');
      }
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
      `${dayLabel(w.day)} &nbsp;·&nbsp; ${w.total_minutes} min &nbsp;·&nbsp; <span class="card-badge ${badgeClass(w.workout_type)}">${badgeLabel(w.workout_type)}</span>`;

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

    renderDetailWorkoutChart(w.steps);
    document.getElementById('btn-start').disabled = w.steps.length === 0;
    showView('detail');
  },

  async startWorkout() {
    if (!selectedWorkout || selectedWorkout.steps.length === 0) return;

    clearInterval(timerHandle);
    activeSteps = selectedWorkout.steps.map(step => ({ ...step }));
    activeStepIdx = 0;
    stepElapsed = 0;
    totalElapsed = 0;
    totalDuration = activeSteps.reduce((s, x) => s + x.duration, 0);
    timerHandle = null;
    startupWarmupRemaining = STARTUP_WARMUP_SECONDS;
    workoutSamples = [];
    workoutStartTime = new Date();
    workoutName = selectedWorkout.goal;
    workoutActive = true;
    awaitingWorkoutStop = false;
    workoutFinishing = false;
    hasSeenWorkoutMotion = false;
    zeroSpeedStreak = 0;
    completedMarkedForSession = false;
    currentTreadmillSpeed = null;
    currentTreadmillIncline = null;

    document.getElementById('active-title').textContent = selectedWorkout.goal;
    showView('active');
    updateActiveControlState();
    syncWakeLock().catch(() => {});
    updateActiveUI();
    startWorkoutWarmup().catch(e => setConnectStatus(e.message || 'Could not start treadmill', 'err'));
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
    try {
      await treadmill.setSpeed(step.speed);
    } catch (e) {
      setConnectStatus(e.message || 'Speed command failed', 'err');
    }
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
    try {
      await treadmill.setIncline(step.incline);
    } catch (e) {
      setConnectStatus(e.message || 'Incline command failed', 'err');
    }
    updateActiveUI();
  },

  skipSegment() {
    if (!getActiveStep() || awaitingWorkoutStop || workoutFinishing) return;
    advanceToStep(activeStepIdx + 1);
  },

  toggleCompleted(day, event) {
    event?.stopPropagation();
    toggleDayCompleted(day);
    renderPlanList();
  },

  async uploadToStrava() {
    const btn = document.getElementById('btn-upload');
    btn.disabled = true;
    setUploadStatus('Uploading...', '');

    try {
      const token = await getValidStravaToken();
      if (!token) {
        setUploadStatus('Not connected to Strava - tap the Strava button to connect', 'err');
        btn.disabled = false;
        return;
      }

      const tcx = generateTCX();
      const blob = new Blob([tcx], { type: 'application/tcx+xml' });
      const form = new FormData();
      form.append('file', blob, 'workout.tcx');
      form.append('name', workoutName);
      form.append('sport_type', 'VirtualRun');
      form.append('trainer', '1');
      form.append('data_type', 'tcx');

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
      setUploadStatus('Processing...', '');
      const activityId = await pollUpload(token, upload.id);
      setUploadStatus(`Uploaded! View on Strava (activity ${activityId})`, 'ok');
    } catch (e) {
      setUploadStatus(`Upload failed: ${e.message}`, 'err');
      btn.disabled = false;
    }
  },

  openSettings() {
    document.getElementById('redirect-uri-hint').textContent = stravaRedirectUri();
    document.getElementById('input-client-id').value = localStorage.getItem('stravaClientId') || '';
    document.getElementById('input-client-secret').value = '';
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
    const popup = window.open(buildStravaAuthUrl(clientId), '_blank');
    if (!popup) window.location.href = buildStravaAuthUrl(clientId);
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
        // Fall through to manual copy guidance.
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

    setStravaAuthStatus('Connecting to Strava...', '');
    try {
      const athleteName = await exchangeStravaCode(code);
      document.getElementById('input-auth-code').value = '';
      updateStravaButtonState();
      renderPlanList();
      setStravaAuthStatus(`Connected as ${athleteName}`, 'ok');
      App.closeSettings();
    } catch (e) {
      console.error('Manual Strava code exchange failed', e);
      setStravaAuthStatus(`Connection failed: ${e.message}`, 'err');
    }
  },

  stravaDisconnect() {
    ['stravaAccessToken', 'stravaRefreshToken', 'stravaTokenExpiry', 'stravaAthleteName', 'stravaAthleteId', 'stravaPendingCode']
      .forEach(k => localStorage.removeItem(k));
    document.getElementById('input-auth-code').value = '';
    setStravaAuthStatus('', '');
    updateStravaButtonState();
    renderPlanList();
    App.closeSettings();
  },
};

window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());

function getActiveStep() {
  return activeSteps[activeStepIdx] || null;
}

function getDisplayedSpeed() {
  const step = getActiveStep();
  if (startupWarmupRemaining > 0) return 1.0;
  return currentTreadmillSpeed ?? step?.speed ?? null;
}

function getDisplayedIncline() {
  const step = getActiveStep();
  if (startupWarmupRemaining > 0) return 0;
  return currentTreadmillIncline ?? step?.incline ?? null;
}

function getPlannedProgressSeconds() {
  let seconds = stepElapsed;
  for (let i = 0; i < activeStepIdx; i++) seconds += activeSteps[i].duration;
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
    // Unsupported or denied.
  }
}

async function enableNoSleep() {
  if (noSleepEnabled || !noSleep || document.visibilityState !== 'visible') return;
  try {
    await noSleep.enable();
    noSleepEnabled = true;
  } catch (_) {
    // Fallback wake lock failed.
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
    // Ignore fallback failures.
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

function tick() {
  if (workoutFinishing || (!workoutActive && !awaitingWorkoutStop)) return;
  const currentStep = getActiveStep();
  if (!currentStep) return;

  if (startupWarmupRemaining > 0) {
    startupWarmupRemaining--;
    if (startupWarmupRemaining === 0) {
      applyCurrentStepTarget().catch(e => setConnectStatus(e.message || 'Could not set treadmill target', 'err'));
    }
    updateActiveUI();
    return;
  }

  totalElapsed++;
  workoutSamples.push({
    speed_kmh: getDisplayedSpeed() ?? (awaitingWorkoutStop ? 1.0 : currentStep.speed),
    hr_bpm: currentHR || 0,
    incline_pct: getDisplayedIncline() ?? (awaitingWorkoutStop ? 0 : currentStep.incline),
  });

  if (awaitingWorkoutStop) {
    updateActiveUI();
    return;
  }

  stepElapsed++;
  if (stepElapsed >= currentStep.duration) {
    advanceToStep(activeStepIdx + 1);
    return;
  }

  updateActiveUI();
}

async function applyCurrentStepTarget() {
  const step = getActiveStep();
  if (!step) return;
  await treadmill.setSpeed(step.speed);
  await treadmill.setIncline(step.incline);
  updateActiveUI();
}

async function startWorkoutWarmup() {
  await treadmill.requestControl();
  await treadmill.startResume();
  await treadmill.setSpeed(1.0, { confirmTimeoutMs: 1200 });
  await treadmill.setIncline(0);
  updateActiveUI();
}

async function startCooldownMode() {
  awaitingWorkoutStop = true;
  workoutActive = false;
  zeroSpeedStreak = 0;
  startupWarmupRemaining = 0;
  await treadmill.setSpeed(1.0, { confirmTimeoutMs: 1200 }).catch(e => setConnectStatus(e.message, 'err'));
  await treadmill.setIncline(0).catch(e => setConnectStatus(e.message, 'err'));
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

  applyCurrentStepTarget().catch(e => setConnectStatus(e.message || 'Could not change segment', 'err'));
  updateActiveUI();
}

async function finalizeWorkout(origin, sendStopCommand) {
  if (workoutFinishing || (!workoutActive && !awaitingWorkoutStop && workoutSamples.length === 0)) return;

  workoutFinishing = true;
  workoutActive = false;
  awaitingWorkoutStop = false;
  clearInterval(timerHandle);
  timerHandle = null;
  startupWarmupRemaining = 0;
  updateActiveControlState();

  if (sendStopCommand) {
    await treadmill.stop().catch(e => setConnectStatus(e.message || 'Stop command failed', 'err'));
  }

  showWorkoutDone();

  const wantsUpload = window.confirm(
    origin === 'treadmill'
      ? 'Workout stopped on the treadmill. Upload it to Strava?'
      : 'Workout stopped. Upload it to Strava?'
  );
  if (wantsUpload) setTimeout(() => App.uploadToStrava(), 0);

  resetWorkoutRuntimeState();
}

function handleTreadmillMotionStop() {
  if ((workoutActive || awaitingWorkoutStop) && !workoutFinishing && startupWarmupRemaining === 0) {
    if ((currentTreadmillSpeed ?? 0) >= 0.8) hasSeenWorkoutMotion = true;

    if (hasSeenWorkoutMotion && (currentTreadmillSpeed ?? 0) <= 0.1) {
      zeroSpeedStreak++;
      if (zeroSpeedStreak >= 2) {
        finalizeWorkout('treadmill', false).catch(() => {});
      }
    } else {
      zeroSpeedStreak = 0;
    }
  }
}

function updateActiveUI() {
  const step = getActiveStep();
  if (!step) return;

  const remaining = Math.max(0, step.duration - stepElapsed);
  const displayedSpeed = getDisplayedSpeed();
  const displayedIncline = getDisplayedIncline();

  document.getElementById('active-speed').textContent =
    displayedSpeed != null ? displayedSpeed.toFixed(1) : step.speed.toFixed(1);
  document.getElementById('active-incline').textContent =
    displayedIncline != null ? displayedIncline.toFixed(1) : step.incline.toFixed(1);

  if (startupWarmupRemaining > 0) {
    const warmupFraction = startupWarmupRemaining / STARTUP_WARMUP_SECONDS;
    document.getElementById('active-seg-time').textContent = fmtMMSS(startupWarmupRemaining);
    document.getElementById('timer-ring-fg').style.strokeDashoffset =
      TIMER_RING_CIRCUMFERENCE * (1 - warmupFraction);
    document.getElementById('active-seg-label').textContent = 'Starting workout';
    document.getElementById('active-next').textContent =
      `Walking at 1.0 km/h for ${startupWarmupRemaining}s, then ${step.speed.toFixed(1)} km/h${step.incline > 0 ? ` · ${step.incline.toFixed(1)}%` : ''}.`;
    renderActiveProgressGraph(activeSteps, 0, totalDuration, 'warmup');
    document.getElementById('progress-label').textContent =
      `Warmup ${STARTUP_WARMUP_SECONDS - startupWarmupRemaining}/${STARTUP_WARMUP_SECONDS}s`;
    updateActiveControlState();
    return;
  }

  if (awaitingWorkoutStop) {
    document.getElementById('active-seg-time').textContent = 'done';
    document.getElementById('timer-ring-fg').style.strokeDashoffset = TIMER_RING_CIRCUMFERENCE;
    document.getElementById('active-seg-label').textContent = 'Workout complete';
    document.getElementById('active-next').textContent =
      'Cooldown mode: adjust speed or incline if you want to keep going, then stop on the app or treadmill when finished.';
    renderActiveProgressGraph(activeSteps, totalDuration, totalDuration, 'complete');
    document.getElementById('progress-label').textContent = `Plan done · total ${fmtMMSS(totalElapsed)}`;
    updateActiveControlState();
    return;
  }

  document.getElementById('active-seg-time').textContent = fmtMMSS(remaining);
  const fraction = remaining / step.duration;
  document.getElementById('timer-ring-fg').style.strokeDashoffset =
    TIMER_RING_CIRCUMFERENCE * (1 - fraction);

  const inclineStr = step.incline > 0 ? ` · target ${step.incline.toFixed(1)}%` : '';
  document.getElementById('active-seg-label').textContent =
    `Segment ${activeStepIdx + 1} of ${activeSteps.length} · target ${step.speed.toFixed(1)} km/h${inclineStr}`;

  const next = activeSteps[activeStepIdx + 1];
  document.getElementById('active-next').textContent = next
    ? `Next: ${next.speed.toFixed(1)} km/h${next.incline > 0 ? ` · ${next.incline.toFixed(1)}%` : ''} for ${fmtDur(next.duration)}`
    : 'Last segment';

  const progress = getPlannedProgressSeconds();
  renderActiveProgressGraph(activeSteps, progress, totalDuration, 'active');
  document.getElementById('progress-label').textContent = `${fmtMMSS(progress)} / ${fmtMMSS(totalDuration)}`;
  updateActiveControlState();
}

function showWorkoutDone() {
  showSummary();
}

function renderPlanList() {
  const container = document.getElementById('workout-list');
  if (!container) return;
  container.innerHTML = '';
  const completed = getCompletedDays();

  for (const w of plan) {
    const card = document.createElement('div');
    const isRest = w.workout_type === 'rest';
    const isCompleted = completed.has(w.day);

    card.className = 'workout-card' +
      (isCompleted ? ' completed' : '') +
      (isRest ? ' rest' : '');

    const metaStr = isRest
      ? w.goal
      : `${w.total_minutes} min · ${w.segments.length > 60 ? w.segments.slice(0, 60) + '...' : w.segments}`;

    card.innerHTML = `
      <div class="card-date-block ${isCompleted ? 'completed' : ''}">
        <div class="card-day-num">${w.day}</div>
        <div class="card-day-name">DAY</div>
      </div>
      <div class="card-body">
        <div class="card-name">${isCompleted ? '&#10003; ' : ''}${w.goal}</div>
        <div class="card-meta">${metaStr}</div>
      </div>
      <span class="card-badge ${badgeClass(w.workout_type)}">${badgeLabel(w.workout_type)}</span>
      <button
        class="btn-complete-toggle ${isCompleted ? 'completed' : ''}"
        title="${isCompleted ? 'Mark incomplete' : 'Mark complete'}"
        aria-label="${isCompleted ? 'Mark day incomplete' : 'Mark day complete'}"
        onclick="App.toggleCompleted(${w.day}, event)"
      >${isCompleted ? '&#10003;' : ''}</button>`;

    if (!isRest) card.addEventListener('click', () => App.showDetail(w.day));
    container.appendChild(card);
  }
}

function computeStats() {
  let distanceM = 0;
  let totalHR = 0;
  let hrCount = 0;
  let maxHR = 0;
  let maxSpeedMs = 0;

  for (const s of workoutSamples) {
    const speedMs = s.speed_kmh / 3.6;
    distanceM += speedMs;
    maxSpeedMs = Math.max(maxSpeedMs, speedMs);
    if (s.hr_bpm > 0) {
      totalHR += s.hr_bpm;
      hrCount++;
      maxHR = Math.max(maxHR, s.hr_bpm);
    }
  }

  const durationSec = workoutSamples.length;
  const avgHR = hrCount ? Math.round(totalHR / hrCount) : 0;
  const avgPaceSec = distanceM > 0 ? durationSec / (distanceM / 1000) : 0;
  return { distanceM, durationSec, avgHR, maxHR, maxSpeedMs, avgPaceSec };
}

function fmtPace(secPerKm) {
  if (!secPerKm) return '-';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showSummary() {
  const stats = computeStats();
  document.getElementById('summary-title').textContent = workoutName;
  document.getElementById('summary-date').textContent =
    selectedWorkout ? `${dayLabel(selectedWorkout.day)} completed` : 'Workout completed';

  if (selectedWorkout && workoutSamples.length > 0 && !completedMarkedForSession) {
    markDayCompleted(selectedWorkout.day);
    completedMarkedForSession = true;
    renderPlanList();
  }

  const grid = document.getElementById('summary-stats');
  const cards = [
    { label: 'Distance', value: (stats.distanceM / 1000).toFixed(2) + ' km', cls: '' },
    { label: 'Time', value: fmtMMSS(stats.durationSec), cls: '' },
    { label: 'Avg Pace', value: fmtPace(stats.avgPaceSec) + ' /km', cls: '' },
    { label: 'Avg HR', value: stats.avgHR ? stats.avgHR + ' bpm' : '-', cls: 'hr' },
    { label: 'Max HR', value: stats.maxHR ? stats.maxHR + ' bpm' : '-', cls: 'hr' },
    { label: 'Max Speed', value: stats.maxSpeedMs ? (stats.maxSpeedMs * 3.6).toFixed(1) + ' km/h' : '-', cls: '' },
  ];
  grid.innerHTML = cards.map(c =>
    `<div class="stat-card ${c.cls}">
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>`
  ).join('');

  document.getElementById('btn-upload').disabled = workoutSamples.length === 0;
  document.getElementById('upload-status').className = 'upload-status hidden';
  showView('summary');
}

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

async function handleStravaCallback() {
  const code = parseStravaAuthCode(window.location.href);
  if (!code) return;
  window.history.replaceState({}, document.title, window.location.pathname);
  setUploadStatus('Connecting to Strava...', '');
  try {
    await exchangeStravaCode(code);
    updateStravaButtonState();
  } catch (e) {
    console.error('Strava token exchange failed', e);
    setUploadStatus(`Strava connect failed: ${e.message}`, 'err');
  }
}

async function handleStoredStravaCode() {
  const code = localStorage.getItem('stravaPendingCode');
  if (!code) return false;
  setStravaAuthStatus('Finishing Strava connection...', '');
  try {
    const athleteName = await exchangeStravaCode(code);
    setStravaAuthStatus(`Connected as ${athleteName}`, 'ok');
    updateStravaButtonState();
    App.closeSettings();
    return true;
  } catch (e) {
    console.error('Stored Strava code exchange failed', e);
    setStravaAuthStatus(`Connection failed: ${e.message}`, 'err');
    return false;
  }
}

function updateStravaButtonState() {
  const name = localStorage.getItem('stravaAthleteName');
  const btn = document.getElementById('btn-strava');
  const lbl = document.getElementById('strava-label');
  if (!btn || !lbl) return;

  if (name) {
    btn.classList.add('connected');
    lbl.textContent = name.split(' ')[0];
  } else {
    btn.classList.remove('connected');
    lbl.textContent = 'Strava';
  }
}

async function onStravaStorage(event) {
  if (event.key === 'stravaPendingCode' && event.newValue) {
    await handleStoredStravaCode();
    renderPlanList();
  }

  if (event.key === 'stravaAthleteName' || event.key === 'stravaAthleteId') {
    updateStravaButtonState();
    renderPlanList();
    if (event.newValue && event.key === 'stravaAthleteName') {
      setStravaAuthStatus(`Connected as ${event.newValue}`, 'ok');
      App.closeSettings();
    }
  }
}

function setConnectStatus(msg, cls) {
  const el = document.getElementById('connect-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'connect-status' + (cls ? ` ${cls}` : '');
}

function setHRStatus(msg, cls) {
  const el = document.getElementById('connect-status');
  if (!el) return;
  const existing = el.textContent;
  if (existing && !existing.includes('HR') && cls === 'ok') {
    el.textContent = existing + '  ·  HR: ' + msg;
  } else {
    el.textContent = msg;
    el.className = 'connect-status' + (cls ? ` ${cls}` : '');
  }
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

function setUploadStatus(msg, cls) {
  const el = document.getElementById('upload-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'upload-status' + (cls ? ` ${cls}` : '');
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  window.scrollTo(0, 0);
}
