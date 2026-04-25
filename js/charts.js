import { fmtDur, fmtMMSS } from './plan.js';

function stepEffortScore(step) {
  return step.speed + step.incline * 0.35;
}

function effortFillColor(step) {
  const score = stepEffortScore(step);
  const t = Math.min(1, Math.max(0, (score - 6.5) / 8));
  const eased = Math.pow(t, 1.08);
  const hue = 165 - eased * 165;
  const sat = 70 + eased * 12;
  const light = 54 - eased * 8;
  return `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
}

function fmtChartSpeed(speed) {
  return Number.isInteger(speed) ? String(speed) : speed.toFixed(1);
}

function buildStepAreaPath(points, baselineY) {
  if (!points.length) return '';
  const path = [
    `M ${points[0].x0.toFixed(2)} ${baselineY.toFixed(2)}`,
    `L ${points[0].x0.toFixed(2)} ${points[0].y.toFixed(2)}`,
    `L ${points[0].x1.toFixed(2)} ${points[0].y.toFixed(2)}`,
  ];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    path.push(`L ${curr.x0.toFixed(2)} ${prev.y.toFixed(2)}`);
    path.push(`L ${curr.x0.toFixed(2)} ${curr.y.toFixed(2)}`);
    path.push(`L ${curr.x1.toFixed(2)} ${curr.y.toFixed(2)}`);
  }
  const last = points[points.length - 1];
  path.push(`L ${last.x1.toFixed(2)} ${baselineY.toFixed(2)}`);
  path.push('Z');
  return path.join(' ');
}

function buildStepOutlinePath(points) {
  if (!points.length) return '';
  const path = [
    `M ${points[0].x0.toFixed(2)} ${points[0].y.toFixed(2)}`,
    `L ${points[0].x1.toFixed(2)} ${points[0].y.toFixed(2)}`,
  ];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    path.push(`L ${curr.x0.toFixed(2)} ${prev.y.toFixed(2)}`);
    path.push(`L ${curr.x0.toFixed(2)} ${curr.y.toFixed(2)}`);
    path.push(`L ${curr.x1.toFixed(2)} ${curr.y.toFixed(2)}`);
  }
  return path.join(' ');
}

function chartGeometry(steps, options = {}) {
  const totalSec = steps.reduce((s, x) => s + x.duration, 0);
  const W = options.width || 380;
  const H = options.height || 166;
  const padL = options.padL ?? 40;
  const padR = options.padR ?? 14;
  const padT = options.padT ?? 18;
  const padB = options.padB ?? 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const baselineY = padT + chartH;
  const maxSpeed = Math.max(...steps.map(s => s.speed), 0.1);
  const points = [];
  let cum = 0;

  for (const step of steps) {
    const x0 = padL + (cum / totalSec) * chartW;
    const segW = Math.max(1.2, (step.duration / totalSec) * chartW);
    const x1 = x0 + segW;
    const barH = (step.speed / maxSpeed) * chartH;
    const y = baselineY - barH;
    points.push({ x0, x1, y, step, startSec: cum, endSec: cum + step.duration });
    cum += step.duration;
  }

  return { W, H, padL, padR, padT, padB, chartW, chartH, baselineY, maxSpeed, totalSec, points };
}

function markerForProgress(geom, elapsedSec) {
  const clamped = Math.min(geom.totalSec, Math.max(0, elapsedSec));
  const x = geom.padL + (clamped / geom.totalSec) * geom.chartW;
  const point = geom.points.find(p => clamped <= p.endSec) || geom.points[geom.points.length - 1];
  return { x, y: point?.y ?? geom.baselineY };
}

export function renderDetailWorkoutChart(steps) {
  const wrap = document.getElementById('detail-chart-wrap');
  if (!wrap) return;
  if (!steps || steps.length === 0) {
    wrap.innerHTML = '';
    wrap.classList.add('hidden');
    return;
  }

  const geom = chartGeometry(steps);
  if (geom.totalSec <= 0) {
    wrap.innerHTML = '';
    wrap.classList.add('hidden');
    return;
  }

  const overlays = [];
  const separators = [];
  for (let i = 0; i < geom.points.length; i++) {
    const point = geom.points[i];
    const step = point.step;
    const segW = point.x1 - point.x0;
    const barH = geom.baselineY - point.y;
    const fill = effortFillColor(step);
    const label = `${step.speed} km/h${step.incline > 0 ? ` · ${step.incline}%` : ''} · ${fmtDur(step.duration)}`;
    const radius = Math.min(10, segW / 2);
    const glossH = Math.min(barH, Math.max(8, barH * 0.55));
    overlays.push(`
      <g>
        <rect x="${point.x0.toFixed(2)}" y="${point.y.toFixed(2)}" width="${segW.toFixed(2)}" height="${barH.toFixed(2)}" rx="${radius.toFixed(2)}" fill="${fill}" opacity="0.18"/>
        <rect x="${point.x0.toFixed(2)}" y="${point.y.toFixed(2)}" width="${segW.toFixed(2)}" height="${glossH.toFixed(2)}" rx="${radius.toFixed(2)}" fill="url(#profileGloss)" opacity="0.28"/>
        <rect x="${point.x0.toFixed(2)}" y="${point.y.toFixed(2)}" width="${segW.toFixed(2)}" height="${barH.toFixed(2)}" rx="${radius.toFixed(2)}" fill="transparent">
          <title>${label}</title>
        </rect>
      </g>`);
    if (i > 0) {
      separators.push(`<line x1="${point.x0.toFixed(2)}" y1="${geom.padT + 4}" x2="${point.x0.toFixed(2)}" y2="${geom.baselineY.toFixed(2)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`);
    }
  }

  const totalMin = geom.totalSec / 60;
  const guides = [0, 0.33, 0.66, 1].map(f => ({
    y: geom.baselineY - geom.chartH * f,
    speed: f === 1 ? geom.maxSpeed : Math.round(geom.maxSpeed * f * 2) / 2,
  }));

  const svg = `
<svg class="detail-chart-svg" viewBox="0 0 ${geom.W} ${geom.H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
  ${chartDefs('detail')}
  <rect x="0.5" y="0.5" width="${geom.W - 1}" height="${geom.H - 1}" rx="18" fill="url(#detailChartSurface)" stroke="rgba(255,255,255,0.05)"/>
  <rect x="0.5" y="0.5" width="${geom.W - 1}" height="${geom.H - 1}" rx="18" fill="url(#detailChartGlow)"/>
  ${guides.map(({ y, speed }) => `
    <line x1="${geom.padL}" y1="${y.toFixed(2)}" x2="${(geom.padL + geom.chartW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    <text x="${geom.padL - 8}" y="${(y + 3).toFixed(2)}" text-anchor="end" fill="#8f99a3" font-size="10" font-family="system-ui,sans-serif">${fmtChartSpeed(speed)}</text>
  `).join('')}
  <line x1="${geom.padL}" y1="${geom.padT}" x2="${geom.padL}" y2="${geom.baselineY}" stroke="rgba(255,255,255,0.12)" stroke-width="1.25"/>
  <line x1="${geom.padL}" y1="${geom.baselineY}" x2="${geom.padL + geom.chartW}" y2="${geom.baselineY}" stroke="rgba(255,255,255,0.12)" stroke-width="1.25"/>
  ${separators.join('')}
  <path d="${buildStepAreaPath(geom.points, geom.baselineY)}" fill="url(#detailProfileArea)"/>
  ${overlays.join('')}
  <path d="${buildStepOutlinePath(geom.points)}" fill="none" stroke="#c8fff2" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" filter="url(#detailProfileGlow)"/>
  <path d="${buildStepOutlinePath(geom.points)}" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
  <text x="${geom.padL}" y="${geom.H - 8}" fill="#8f99a3" font-size="10" font-family="system-ui,sans-serif">0 min</text>
  <text x="${geom.padL + geom.chartW / 2}" y="${geom.H - 8}" text-anchor="middle" fill="#8f99a3" font-size="10" font-family="system-ui,sans-serif">${totalMin < 10 ? (totalMin / 2).toFixed(1) : (totalMin / 2).toFixed(0)} min</text>
  <text x="${geom.padL + geom.chartW}" y="${geom.H - 8}" text-anchor="end" fill="#8f99a3" font-size="10" font-family="system-ui,sans-serif">${totalMin < 10 ? totalMin.toFixed(1) : totalMin.toFixed(0)} min</text>
  <text x="${geom.padL}" y="12" fill="#8f99a3" font-size="10" font-family="system-ui,sans-serif">Speed</text>
</svg>`;

  wrap.innerHTML = `
    <div class="detail-chart-title-row">
      <div class="detail-chart-title">Workout profile</div>
      <div class="detail-chart-caption">${steps.length} blocks · ${fmtDur(geom.totalSec)}</div>
    </div>
    <div class="detail-chart-panel">
      ${svg}
      <div class="detail-chart-legend">
        <span><i style="background:${effortFillColor({ speed: 7, incline: 0 })}"></i> Easy</span>
        <span><i style="background:${effortFillColor({ speed: 10, incline: 0 })}"></i> Steady</span>
        <span><i style="background:${effortFillColor({ speed: 13.5, incline: 0 })}"></i> Hard</span>
        <span class="detail-chart-note">Width = duration · height = speed</span>
      </div>
    </div>`;
  wrap.classList.remove('hidden');
}

export function renderActiveProgressGraph(steps, elapsedSec, totalSec, state = 'active') {
  const wrap = document.getElementById('active-progress-graph');
  if (!wrap || !steps?.length || totalSec <= 0) return;

  const geom = chartGeometry(steps, {
    width: 380,
    height: 118,
    padL: 8,
    padR: 8,
    padT: 12,
    padB: 14,
  });
  const pct = state === 'complete' ? 1 : Math.min(1, Math.max(0, elapsedSec / totalSec));
  const fillW = geom.chartW * pct;
  const marker = markerForProgress(geom, state === 'warmup' ? 0 : elapsedSec);
  const areaPath = buildStepAreaPath(geom.points, geom.baselineY);
  const outlinePath = buildStepOutlinePath(geom.points);
  const separators = geom.points.slice(1).map(point =>
    `<line x1="${point.x0.toFixed(2)}" y1="${geom.padT}" x2="${point.x0.toFixed(2)}" y2="${geom.baselineY.toFixed(2)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`
  ).join('');

  wrap.innerHTML = `
<svg class="active-progress-svg" viewBox="0 0 ${geom.W} ${geom.H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
  ${chartDefs('active')}
  <rect x="0" y="0" width="${geom.W}" height="${geom.H}" rx="10" fill="rgba(255,255,255,0.035)"/>
  <path d="${areaPath}" fill="rgba(255,255,255,0.06)"/>
  ${separators}
  <clipPath id="activeProgressClip"><rect x="${geom.padL}" y="0" width="${fillW.toFixed(2)}" height="${geom.H}"/></clipPath>
  <g clip-path="url(#activeProgressClip)">
    <path d="${areaPath}" fill="url(#activeProfileArea)"/>
    <path d="${outlinePath}" fill="none" stroke="#7ff5da" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" filter="url(#activeProfileGlow)"/>
  </g>
  <path d="${outlinePath}" fill="none" stroke="rgba(255,255,255,0.42)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <line x1="${marker.x.toFixed(2)}" y1="${geom.padT}" x2="${marker.x.toFixed(2)}" y2="${geom.baselineY}" stroke="rgba(255,255,255,0.65)" stroke-width="1.5"/>
  <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="5.5" fill="#ffffff"/>
  <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="3.2" fill="#00d4aa"/>
  <text x="${geom.padL}" y="${geom.H - 3}" fill="#8f99a3" font-size="10" font-family="system-ui,sans-serif">0</text>
  <text x="${geom.W - geom.padR}" y="${geom.H - 3}" text-anchor="end" fill="#8f99a3" font-size="10" font-family="system-ui,sans-serif">${fmtMMSS(totalSec)}</text>
</svg>`;
}

function chartDefs(prefix) {
  return `
  <defs>
    <linearGradient id="${prefix}ChartSurface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#171a1d"/>
      <stop offset="100%" stop-color="#0d0f11"/>
    </linearGradient>
    <linearGradient id="${prefix}ChartGlow" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="#00d4aa" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#ff6b35" stop-opacity="0.12"/>
    </linearGradient>
    <linearGradient id="${prefix}ProfileArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7ff5da" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#7ff5da" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="profileGloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.44"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="${prefix}ProfileGlow" x="-10%" y="-10%" width="120%" height="140%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>`;
}
