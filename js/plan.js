export function parseSegmentString(str) {
  function splitTopLevel(s, delimiter) {
    const parts = [];
    let depth = 0;
    let buf = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === delimiter && depth === 0) {
        parts.push(buf.trim());
        buf = '';
      } else {
        buf += ch;
      }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  }

  function parseSingleStep(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)(m|s)@(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const duration = m[2] === 'm' ? parseFloat(m[1]) * 60 : parseFloat(m[1]);
    return { duration, speed: parseFloat(m[3]), incline: parseFloat(m[4]) };
  }

  function parseGroup(s) {
    const trimmed = s.trim();
    const rep = trimmed.match(/^(\d+)x\((.+)\)$/);
    if (rep) {
      const n = parseInt(rep[1], 10);
      const inner = parseGroup(rep[2]);
      const result = [];
      for (let i = 0; i < n; i++) result.push(...inner);
      return result;
    }

    const parts = splitTopLevel(trimmed, '+');
    if (parts.length > 1) {
      const result = [];
      for (const p of parts) result.push(...parseGroup(p));
      return result;
    }

    const step = parseSingleStep(trimmed);
    return step ? [step] : [];
  }

  return parseGroup(str || '');
}

export async function loadPlan() {
  const res = await fetch('plan_next_30_days.csv');
  if (!res.ok) throw new Error('Could not load plan_next_30_days.csv');
  const text = await res.text();
  const lines = text.trim().split('\n');
  const workouts = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) continue;
    const [day, date, workoutType, totalMinutes, segments, goal] = cols;
    const type = workoutType.trim();
    const segmentText = segments.trim();
    workouts.push({
      day: parseInt(day, 10),
      date: date.trim(),
      workout_type: type,
      total_minutes: parseInt(totalMinutes, 10),
      segments: segmentText,
      goal: goal.trim(),
      steps: type !== 'rest' ? parseSegmentString(segmentText) : [],
    });
  }

  return workouts;
}

export function dayLabel(day) {
  return `Day ${day}`;
}

export function badgeClass(type) {
  if (type.startsWith('speed')) return 'badge-speed';
  if (type.startsWith('tempo')) return 'badge-tempo';
  if (type.startsWith('recovery')) return 'badge-recovery';
  if (type.includes('hill')) return 'badge-hills';
  if (type.startsWith('long')) return 'badge-long';
  if (type === 'goal_race') return 'badge-race';
  if (type === 'rest') return 'badge-rest';
  return 'badge-easy';
}

export function badgeLabel(type) {
  const map = {
    speed: 'Speed',
    tempo: 'Tempo',
    easy: 'Easy',
    recovery: 'Recovery',
    easy_hills: 'Hills',
    long_easy_hills: 'Long+Hills',
    long_progression_hills: 'Long+Hills',
    long_progression: 'Long',
    long_easy: 'Long',
    recovery_run: 'Recovery',
    goal_race: 'RACE',
    rest: 'Rest',
  };
  return map[type] || type;
}

export function fmtDur(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return s === 0 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtMMSS(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function roundToStep(value, step) {
  return Number((Math.round(value / step) * step).toFixed(3));
}

export function clamp(value, min, max = Infinity) {
  return Math.min(max, Math.max(min, value));
}
