import { useEffect, useState } from 'react';
import { api } from '../api/client';

// Calendar day as YYYY-MM-DD in India time (the dashboard is IST everywhere).
function istDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return s > 0 ? '<1m' : '0m';
}

function fmtDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
}

type Range = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

export default function AppUsage({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<Range>('today');
  const [customDay, setCustomDay] = useState(istDay());
  const [user, setUser] = useState('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  function bounds(): [string, string] {
    if (range === 'today') return [istDay(), istDay()];
    if (range === 'yesterday') return [istDay(-1), istDay(-1)];
    if (range === '7d') return [istDay(-6), istDay()];
    if (range === '30d') return [istDay(-29), istDay()];
    return [customDay, customDay];
  }

  useEffect(() => {
    const [from, to] = bounds();
    setLoading(true);
    api.getUsage(deviceId, from, to, user || undefined).then(setData).finally(() => setLoading(false));
    const t = setInterval(() => api.getUsage(deviceId, from, to, user || undefined).then(setData), 60000);
    return () => clearInterval(t);
  }, [deviceId, range, customDay, user]);

  const apps: any[] = data?.apps || [];
  const daily: any[] = data?.daily || [];
  const total = apps.reduce((n, a) => n + a.seconds, 0);
  const maxApp = apps.length ? apps[0].seconds : 1;
  const maxDay = daily.reduce((n, d) => Math.max(n, d.seconds), 1);

  const chip = (r: Range, label: string) => (
    <button key={r} className={`btn btn-sm ${range === r ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRange(r)}>{label}</button>
  );

  return (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>App Usage</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Time each app was in the foreground. Idle and locked time isn't counted; only app names are recorded, never window titles or websites.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {chip('today', 'Today')}{chip('yesterday', 'Yesterday')}{chip('7d', 'Last 7 days')}{chip('30d', 'Last 30 days')}
          <input
            type="date" value={customDay} max={istDay()}
            onChange={(e) => { setCustomDay(e.target.value); setRange('custom'); }}
            style={{ padding: '5px 8px', borderColor: range === 'custom' ? 'var(--accent)' : undefined }}
            aria-label="Pick a day"
          />
          {data?.users?.length > 1 && (
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="">All users</option>
              {data.users.map((u: string) => <option key={u} value={u}>{u}</option>)}
            </select>
          )}
        </div>
      </div>

      {loading && !data ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading…</p>
      ) : apps.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 14, padding: '10px 0' }}>
          No usage recorded for this period yet. Usage appears a few minutes after the device starts reporting with the latest agent.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--navy)' }}>{fmtDuration(total)}</span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>total screen time · {apps.length} app(s)</span>
          </div>

          {daily.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 110, marginBottom: 18, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>
              {daily.map((d) => (
                <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', minWidth: 0 }}
                     title={`${fmtDay(d.date)}: ${fmtDuration(d.seconds)}`}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{fmtDuration(d.seconds)}</span>
                  <div style={{ width: '100%', maxWidth: 38, height: `${Math.max(4, (d.seconds / maxDay) * 70)}%`, background: 'var(--accent)', borderRadius: '4px 4px 0 0' }} />
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, whiteSpace: 'nowrap' }}>{fmtDay(d.date).split(',')[0]}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
            {apps.map((a) => (
              <div key={a.exe_name} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 14, marginBottom: 5 }}>
                  <span style={{ fontWeight: 600 }}>{a.app_name} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}>{a.exe_name}</span></span>
                  <span style={{ whiteSpace: 'nowrap' }}>{fmtDuration(a.seconds)} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {Math.round((a.seconds / total) * 100)}%</span></span>
                </div>
                <div style={{ height: 6, background: 'var(--bg)', borderRadius: 3 }}>
                  <div style={{ width: `${(a.seconds / maxApp) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
