const STORE_PREFIX = 'treadmillCompletedDays';

export function profileCompletionKey() {
  const athleteId = localStorage.getItem('stravaAthleteId');
  const athleteName = localStorage.getItem('stravaAthleteName');
  const profile = athleteId || athleteName || 'local';
  return `${STORE_PREFIX}:${profile}`;
}

export function getCompletedDays() {
  try {
    const raw = localStorage.getItem(profileCompletionKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(parsed.map(Number).filter(Number.isFinite));
  } catch (_) {
    return new Set();
  }
}

export function isDayCompleted(day) {
  return getCompletedDays().has(Number(day));
}

export function markDayCompleted(day) {
  const completed = getCompletedDays();
  completed.add(Number(day));
  localStorage.setItem(profileCompletionKey(), JSON.stringify([...completed].sort((a, b) => a - b)));
}

export function unmarkDayCompleted(day) {
  const completed = getCompletedDays();
  completed.delete(Number(day));
  localStorage.setItem(profileCompletionKey(), JSON.stringify([...completed].sort((a, b) => a - b)));
}

export function toggleDayCompleted(day) {
  if (isDayCompleted(day)) {
    unmarkDayCompleted(day);
    return false;
  }
  markDayCompleted(day);
  return true;
}
