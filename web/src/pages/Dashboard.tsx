import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import StatCard from '../components/StatCard';
import { SeverityBadge } from '../components/StatusBadge';
import Icon from '../components/Icon';

interface Overview {
  total: number;
  byStatus: { status: string; c: number }[];
  byPlatform: { platform: string; c: number }[];
  byCompliance: { compliance: string; c: number }[];
  openAlerts: number;
  silent?: number;
}

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getOverview(), api.getAlerts(false)])
      .then(([ov, al]) => {
        setOverview(ov);
        setAlerts(al.alerts.slice(0, 5));
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading || !overview) return <p style={{ color: 'var(--text-muted)' }}>Loading dashboard…</p>;

  const countFor = (arr: { c: number }[] | undefined, key: string, value: string) =>
    (arr || []).find((x: any) => x[key] === value)?.c ?? 0;

  const online = countFor(overview.byStatus, 'status', 'online');
  const offline = countFor(overview.byStatus, 'status', 'offline');
  const pending = countFor(overview.byStatus, 'status', 'pending');
  const compliant = countFor(overview.byCompliance, 'compliance', 'compliant');
  const nonCompliant = countFor(overview.byCompliance, 'compliance', 'non_compliant');

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Dashboard</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24 }}>
        Overview of all enrolled devices across Ellora EPC Pvt. Ltd.
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatCard label="Total Devices" value={overview.total} />
        <StatCard label="Online" value={online} accent="var(--success)" />
        <StatCard label="Offline" value={offline} accent="var(--danger)" />
        <StatCard label="Silent 2+ days (needs action)" value={overview.silent ?? 0} accent="var(--warning)" />
        <StatCard label="Pending Enrollment" value={pending} accent="var(--warning)" />
        <StatCard label="Open Alerts" value={overview.openAlerts} accent="var(--danger)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Devices by Platform</h3>
          {overview.byPlatform.map((p) => (
            <div key={p.platform} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ textTransform: 'capitalize', fontSize: 14 }}>{p.platform}</span>
              <span style={{ fontWeight: 700 }}>{p.c}</span>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Compliance Status</h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 14 }}>Compliant</span>
            <span style={{ fontWeight: 700, color: 'var(--success)' }}>{compliant}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontSize: 14 }}>Non-compliant</span>
            <span style={{ fontWeight: 700, color: 'var(--danger)' }}>{nonCompliant}</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700 }}>Recent Alerts</h3>
          <Link to="/alerts" style={{ fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>View all <Icon name="arrow-right" /></Link>
        </div>
        {alerts.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No open alerts. Everything looks healthy.</p>}
        {alerts.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <SeverityBadge severity={a.severity} />
            <span style={{ fontSize: 14, flex: 1 }}>{a.message}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.device_name || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
