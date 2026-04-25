export function currentAppDir() {
  const path = window.location.pathname;
  return path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1);
}

export function stravaRedirectUri() {
  return window.location.origin + currentAppDir() + 'strava_callback.html';
}

export function buildStravaAuthUrl(clientId) {
  const redirect = encodeURIComponent(stravaRedirectUri());
  const scope = encodeURIComponent('activity:write,activity:read_all');
  return (
    `https://www.strava.com/oauth/authorize?client_id=${clientId}` +
    `&response_type=code&redirect_uri=${redirect}` +
    `&approval_prompt=auto&scope=${scope}`
  );
}

export function parseStravaAuthCode(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw;
  const codeMatch = raw.match(/[?&]code=([^&]+)/);
  return codeMatch ? decodeURIComponent(codeMatch[1]) : '';
}

export function saveStravaClientConfigFromInputs() {
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
  if (inputClientSecret) localStorage.setItem('stravaClientSecret', inputClientSecret);
  return { clientId, clientSecret };
}

export async function exchangeStravaCode(code) {
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
  if (data.athlete?.id) localStorage.setItem('stravaAthleteId', String(data.athlete.id));
  localStorage.removeItem('stravaPendingCode');

  return athleteName;
}

export async function getValidStravaToken() {
  const expiry = parseInt(localStorage.getItem('stravaTokenExpiry') || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  if (expiry - now > 60) return localStorage.getItem('stravaAccessToken');

  const clientId = localStorage.getItem('stravaClientId');
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

  localStorage.setItem('stravaAccessToken', data.access_token);
  localStorage.setItem('stravaRefreshToken', data.refresh_token);
  localStorage.setItem('stravaTokenExpiry', data.expires_at);
  return data.access_token;
}

export async function pollUpload(token, uploadId, attempts = 0) {
  if (attempts > 15) throw new Error('Timed out waiting for Strava to process upload');
  await new Promise(r => setTimeout(r, 2000));
  const resp = await fetch(`https://www.strava.com/api/v3/uploads/${uploadId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  if (data.activity_id) return data.activity_id;
  return pollUpload(token, uploadId, attempts + 1);
}

export async function fetchRecentStravaActivities(token, afterEpoch) {
  const activities = [];
  const baseUrl = new URL('https://www.strava.com/api/v3/athlete/activities');
  if (afterEpoch) baseUrl.searchParams.set('after', String(afterEpoch));
  baseUrl.searchParams.set('per_page', '100');

  for (let page = 1; page <= 3; page++) {
    baseUrl.searchParams.set('page', String(page));
    const resp = await fetch(baseUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      const missingScope = data?.errors?.some(error => error?.field === 'activity:read_permission');
      if (missingScope) {
        throw new Error('Reconnect Strava so the app can read private activities for sync.');
      }
      throw new Error(data?.message || `Strava sync failed with HTTP ${resp.status}`);
    }

    if (!Array.isArray(data) || data.length === 0) break;
    activities.push(...data);
    if (data.length < 100) break;
  }

  return activities;
}
