const API_BASE = `${import.meta.env.VITE_API_URL || ''}/api`;

let authToken: string | null = localStorage.getItem('ellora_mdm_token');

export function setToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem('ellora_mdm_token', token);
  else localStorage.removeItem('ellora_mdm_token');
}

export function getToken() {
  return authToken;
}

async function request(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined)
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  // A 401 on the login call itself just means wrong credentials: show the
  // server's message instead of treating it as an expired session.
  if (res.status === 401 && path !== '/auth/login') {
    setToken(null);
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

export const api = {
  login: (email: string, password: string) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  getOverview: () => request('/devices/stats/overview'),
  getDevices: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/devices${qs ? `?${qs}` : ''}`);
  },
  getDevice: (id: string | number) => request(`/devices/${id}`),
  getEvents: (id: string | number, level: 'critical' | 'error' | 'all') => request(`/devices/${id}/events?level=${level}`),
  getUsage: (id: string | number, from: string, to: string, user?: string) =>
    request(`/devices/${id}/usage?from=${from}&to=${to}${user ? `&user=${encodeURIComponent(user)}` : ''}`),
  createDevice: (payload: any) => request('/devices', { method: 'POST', body: JSON.stringify(payload) }),
  deleteDevice: (id: string | number) => request(`/devices/${id}`, { method: 'DELETE' }),
  rolloutUpdate: (targetVersion: string, downloadUrl: string) =>
    request('/devices/rollout-update', { method: 'POST', body: JSON.stringify({ target_version: targetVersion, download_url: downloadUrl }) }),
  sendCommand: (deviceId: string | number, type: string, payload?: any, adminPassword?: string) =>
    request(`/devices/${deviceId}/commands`, { method: 'POST', body: JSON.stringify({ type, payload, admin_password: adminPassword }) }),
  assignPolicy: (deviceId: string | number, policyId: string | number) =>
    request(`/devices/${deviceId}/policies/${policyId}`, { method: 'POST' }),
  unassignPolicy: (deviceId: string | number, policyId: string | number) =>
    request(`/devices/${deviceId}/policies/${policyId}`, { method: 'DELETE' }),

  getPolicies: () => request('/policies'),
  getPolicy: (id: string | number) => request(`/policies/${id}`),
  createPolicy: (payload: any) => request('/policies', { method: 'POST', body: JSON.stringify(payload) }),
  updatePolicy: (id: string | number, payload: any) =>
    request(`/policies/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePolicy: (id: string | number) => request(`/policies/${id}`, { method: 'DELETE' }),

  getAlerts: (resolved?: boolean) =>
    request(`/alerts${resolved !== undefined ? `?resolved=${resolved}` : ''}`),
  resolveAlert: (id: string | number) => request(`/alerts/${id}/resolve`, { method: 'POST' })
};
