import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge, ComplianceBadge, PlatformBadge } from '../components/StatusBadge';
import { formatIST, daysSince } from '../utils/formatDate';

// Must match AgentCore.AgentVersion / UpdateDownloadUrl in the desktop agent
// (desktop-agent/AgentCore.cs) — bump both together whenever a new build is
// published, so "Rollout Update" targets the right version.
const CURRENT_AGENT_VERSION = '2026.10.26.6';
const AGENT_DOWNLOAD_URL = 'https://ellora-mdm-web.it-admin-cf1.workers.dev/agent-update/';

export default function Devices() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState('');
  const [compliance, setCompliance] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newDevice, setNewDevice] = useState({ name: '', platform: 'windows', owner: '' });
  const [createdInfo, setCreatedInfo] = useState<any>(null);
  const [rollingOut, setRollingOut] = useState(false);
  const [rolloutResult, setRolloutResult] = useState<string | null>(null);

  function load() {
    setLoading(true);
    const params: Record<string, string> = {};
    if (q) params.q = q;
    if (platform) params.platform = platform;
    if (status) params.status = status;
    if (compliance) params.compliance = compliance;
    delete params.status; // 'silent' is a client-side view; the rest is filtered by the server below
    if (status && status !== 'silent') params.status = status;
    api.getDevices(params).then((d) => setDevices(d.devices)).finally(() => setLoading(false));
  }

  useEffect(load, [platform, status, compliance]);

  const isSilent = (d: any) => d.status !== 'pending' && d.last_checkin && (daysSince(d.last_checkin) ?? 0) >= 2;
  const silentDevices = devices.filter(isSilent);
  const shown = status === 'silent' ? silentDevices : devices;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const res = await api.createDevice(newDevice);
    setCreatedInfo(res.device);
    setNewDevice({ name: '', platform: 'windows', owner: '' });
    load();
  }

  async function handleDelete(e: React.MouseEvent, id: number, name: string) {
    e.stopPropagation();
    if (!confirm(`Delete "${name}" from Ellora MDM? Its agent will deregister itself on next check-in.`)) return;
    await api.deleteDevice(id);
    load();
  }

  const outdatedCount = devices.filter((d) => d.platform === 'windows' && d.api_token && d.agent_version !== CURRENT_AGENT_VERSION).length;

  async function handleRollout() {
    if (!confirm(
      `Push agent v${CURRENT_AGENT_VERSION} to ${outdatedCount} Windows device(s) not already on it?\n\n` +
      `Each device downloads and self-replaces on its next check-in (within ~15s). ` +
      `Note: devices still running a build from before self-update existed won't be able to act on this — they'll need one manual re-run to gain the capability.`
    )) return;
    setRollingOut(true);
    setRolloutResult(null);
    try {
      const res = await api.rolloutUpdate(CURRENT_AGENT_VERSION, AGENT_DOWNLOAD_URL);
      setRolloutResult(`Queued update on ${res.queued} device(s).`);
      load();
    } catch (err: any) {
      setRolloutResult(`Rollout failed: ${err.message}`);
    } finally {
      setRollingOut(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Devices</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{devices.length} device(s)</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {outdatedCount > 0 && (
            <button className="btn btn-secondary" disabled={rollingOut} onClick={handleRollout}>
              {rollingOut ? 'Rolling out…' : `Rollout Update (${outdatedCount} outdated)`}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Device</button>
        </div>
      </div>

      {silentDevices.length > 0 && status !== 'silent' && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 16, fontSize: 13, borderLeft: '4px solid var(--danger)' }}>
          {silentDevices.length} device(s) have not contacted the server for 2+ days. Their agent is not running, so the dashboard cannot
          reach them.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); setStatus('silent'); }}>Show them</a>
        </div>
      )}

      {rolloutResult && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 16, fontSize: 13 }}>
          {rolloutResult}
        </div>
      )}

      <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <input
          placeholder="Search name, serial, owner…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">All Platforms</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="android">Android</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="pending">Pending</option>
          <option value="silent">Silent 2+ days (needs action)</option>
        </select>
        <select value={compliance} onChange={(e) => setCompliance(e.target.value)}>
          <option value="">All Compliance</option>
          <option value="compliant">Compliant</option>
          <option value="non_compliant">Non-compliant</option>
          <option value="unknown">Unknown</option>
        </select>
        <button className="btn btn-secondary" onClick={load}>Search</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: 20, color: 'var(--text-muted)' }}>Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Platform</th>
                <th>Status</th>
                <th>Compliance</th>
                <th>Owner</th>
                <th>Last Check-in</th>
                <th>Agent</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const upToDate = d.agent_version === CURRENT_AGENT_VERSION;
                const silentDays = isSilent(d) ? daysSince(d.last_checkin) : null;
                return (
                  <tr key={d.id} onClick={() => navigate(`/devices/${d.id}`)}>
                    <td style={{ fontWeight: 600 }}>{d.name}</td>
                    <td><PlatformBadge platform={d.platform} /></td>
                    <td><StatusBadge status={d.status} /></td>
                    <td><ComplianceBadge compliance={d.compliance} /></td>
                    <td>{d.owner || '—'}</td>
                    <td>
                      {formatIST(d.last_checkin, 'Never')}
                      {silentDays !== null && (
                        <div style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 600 }}>
                          Silent for {silentDays} days{upToDate ? '' : ' - agent never updated; run the new EXE once as administrator'}
                        </div>
                      )}
                    </td>
                    <td style={{ color: upToDate ? 'var(--text-muted)' : 'var(--warning)', fontSize: 12 }}>
                      {d.agent_version || '—'}{!upToDate && d.agent_version ? ' (outdated)' : ''}
                      {d.agent_elevated === 0 ? ' · not admin' : ''}
                    </td>
                    <td>
                      <button className="btn btn-sm btn-secondary" onClick={(e) => handleDelete(e, d.id, d.name)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>No devices found.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(27,40,73,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={() => { setShowAdd(false); setCreatedInfo(null); }}
        >
          <div className="card" style={{ padding: 26, width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Add Device</h3>
            {createdInfo ? (
              <div>
                <p style={{ fontSize: 14, marginBottom: 10 }}>
                  Device created. Share this enrollment code with the user to run on the agent:
                </p>
                <div className="card" style={{ padding: 12, background: 'var(--bg)', fontFamily: 'monospace', fontSize: 16, textAlign: 'center', marginBottom: 16 }}>
                  {createdInfo.enrollment_code}
                </div>
                <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => { setShowAdd(false); setCreatedInfo(null); }}>
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label>Device name</label>
                  <input required style={{ width: '100%', marginTop: 6 }} value={newDevice.name} onChange={(e) => setNewDevice({ ...newDevice, name: e.target.value })} />
                </div>
                <div>
                  <label>Platform</label>
                  <select style={{ width: '100%', marginTop: 6 }} value={newDevice.platform} onChange={(e) => setNewDevice({ ...newDevice, platform: e.target.value })}>
                    <option value="windows">Windows</option>
                    <option value="macos">macOS</option>
                    <option value="android">Android</option>
                  </select>
                </div>
                <div>
                  <label>Owner / Department</label>
                  <input style={{ width: '100%', marginTop: 6 }} value={newDevice.owner} onChange={(e) => setNewDevice({ ...newDevice, owner: e.target.value })} />
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  <button type="button" className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setShowAdd(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>Create</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
