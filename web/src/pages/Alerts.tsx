import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { SeverityBadge } from '../components/StatusBadge';
import { formatIST } from '../utils/formatDate';

export default function Alerts() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  function load() {
    setLoading(true);
    api.getAlerts(showResolved ? undefined : false).then((d) => setAlerts(d.alerts)).finally(() => setLoading(false));
  }

  useEffect(load, [showResolved]);

  async function resolve(id: number) {
    await api.resolveAlert(id);
    load();
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Alerts</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Device offline and compliance notifications</p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: 20, color: 'var(--text-muted)' }}>Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Message</th>
                <th>Device</th>
                <th>Raised</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} style={{ cursor: 'default' }}>
                  <td><SeverityBadge severity={a.severity} /></td>
                  <td>{a.message}</td>
                  <td>{a.device_id ? <Link to={`/devices/${a.device_id}`}>{a.device_name}</Link> : '—'}</td>
                  <td>{formatIST(a.created_at)}</td>
                  <td>{a.resolved ? <span className="badge badge-success">Resolved</span> : <span className="badge badge-warning">Open</span>}</td>
                  <td>
                    {!a.resolved && (
                      <button className="btn btn-secondary btn-sm" onClick={() => resolve(a.id)}>Resolve</button>
                    )}
                  </td>
                </tr>
              ))}
              {alerts.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>No alerts to show.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
