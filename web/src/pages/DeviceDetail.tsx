import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge, ComplianceBadge, PlatformBadge } from '../components/StatusBadge';
import { formatIST } from '../utils/formatDate';
import AppUsage from '../components/AppUsage';
import Icon from '../components/Icon';

export default function DeviceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [policies, setPolicies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [eventLevel, setEventLevel] = useState<'critical' | 'error' | 'all'>('critical');
  const [eventList, setEventList] = useState<any[]>([]);
  useEffect(() => { api.getEvents(id!, eventLevel).then((r) => setEventList(r.events)); }, [id, eventLevel]);
  const [rp, setRp] = useState({ username: '', newPassword: '', mustChange: true, adminPassword: '' });
  const [rpShow, setRpShow] = useState(false);
  const [rpError, setRpError] = useState('');
  const [rpDone, setRpDone] = useState('');

  function generatePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    setRp((s) => ({ ...s, newPassword: Array.from(arr, (n) => chars[n % chars.length]).join('') }));
    setRpShow(true);
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setRpError('');
    setBusy(true);
    try {
      await api.sendCommand(id!, 'reset_password',
        { username: rp.username.trim(), new_password: rp.newPassword, must_change: rp.mustChange },
        rp.adminPassword);
      setRpDone(rp.newPassword);
      setRp((s) => ({ ...s, adminPassword: '', newPassword: '' }));
      load();
    } catch (err: any) {
      setRpError(err.message || 'Failed');
    } finally {
      setBusy(false);
    }
  }
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([api.getDevice(id!), api.getPolicies()])
      .then(([d, p]) => {
        setData(d);
        setPolicies(p.policies);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  async function runCommand(type: string) {
    setBusy(true);
    try {
      await api.sendCommand(id!, type);
      load();
    } finally {
      setBusy(false);
    }
  }

  async function handleWipe() {
    setConfirmWipe(false);
    await runCommand('wipe');
  }

  async function togglePolicy(policyId: number, assigned: boolean) {
    if (assigned) await api.unassignPolicy(id!, policyId);
    else await api.assignPolicy(id!, policyId);
    load();
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await api.deleteDevice(id!);
      navigate('/devices');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !data) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

  const { device, software, policies: assignedPolicies, commands, events } = data;
  let localUsers: string[] = [];
  try { localUsers = device.local_users ? JSON.parse(device.local_users) : []; } catch { /* keep empty */ }
  const assignedIds = new Set(assignedPolicies.map((p: any) => p.id));

  return (
    <div>
      <Link to="/devices" style={{ fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="arrow-left" /> Back to Devices</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', margin: '14px 0 24px' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>{device.name}</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <PlatformBadge platform={device.platform} />
            <StatusBadge status={device.status} />
            <ComplianceBadge compliance={device.compliance} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" disabled={busy} onClick={() => runCommand('lock')}>Lock</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => runCommand('restart')}>Restart</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => runCommand('get_log')} title="Ask the agent to send its recent log">Fetch Log</button>
          {device.platform === 'windows' && (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => { setRp({ username: device.logged_in_user || '', newPassword: '', mustChange: true, adminPassword: '' }); setRpError(''); setRpDone(''); setShowReset(true); }}
            >
              Reset Password
            </button>
          )}
          <button className="btn btn-danger" disabled={busy} onClick={() => setConfirmWipe(true)}>Wipe</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmDelete(true)} title="Remove this device from Ellora MDM">Delete</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Hardware Info</h3>
          <InfoRow label="Serial Number" value={device.serial_number || '—'} />
          <InfoRow label="OS Version" value={device.os_version || '—'} />
          <InfoRow label="Architecture" value={device.arch || '—'} />
          <InfoRow label="CPU" value={device.cpu_model || '—'} />
          <InfoRow label="Memory" value={device.total_memory_mb ? `${(device.free_memory_mb / 1024).toFixed(1)} GB free / ${(device.total_memory_mb / 1024).toFixed(1)} GB total` : '—'} />
          <InfoRow label="Uptime" value={device.uptime_seconds ? formatUptime(device.uptime_seconds) : '—'} />
          <InfoRow label="Owner" value={device.owner || '—'} />
          <InfoRow label="Last Check-in" value={formatIST(device.last_checkin, 'Never')} />
          <InfoRow
            label="Location (approx.)"
            value={
              device.latitude != null
                ? `${device.location_label || `${device.latitude.toFixed(3)}, ${device.longitude.toFixed(3)}`} · updated ${formatIST(device.location_updated_at)}`
                : 'Not yet reported'
            }
          />
          {device.latitude != null && (
            <div style={{ padding: '8px 0', textAlign: 'right' }}>
              <a
                href={`https://www.google.com/maps?q=${device.latitude},${device.longitude}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13 }}
              >
                View on map <Icon name="external" size={12} />
              </a>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Approximate, IP-based location — not precise GPS.
              </div>
            </div>
          )}
          {device.status === 'pending' && (
            <InfoRow label="Enrollment Code" value={device.enrollment_code} mono />
          )}
        </div>

        <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Installed Software</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{software.length} package(s)</p>
          <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
            {software.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No software reported yet.</p>}
            {software.map((s: any) => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14 }}>{s.name}</span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{s.version}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <AppUsage deviceId={id!} />

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Policy Assignments</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {policies.map((p: any) => {
            const assigned = assignedIds.has(p.id);
            return (
              <button
                key={p.id}
                className={`btn btn-sm ${assigned ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => togglePolicy(p.id, assigned)}
              >
                {assigned ? <Icon name="check" size={13} /> : <Icon name="plus" size={13} />} {p.name}
              </button>
            );
          })}
          {policies.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No policies created yet.</p>}
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Command History</h3>
        <table>
          <thead>
            <tr><th>Type</th><th>Status</th><th>Result</th><th>Requested By</th><th>Created</th><th>Completed</th></tr>
          </thead>
          <tbody>
            {commands.map((c: any) => (
              <tr key={c.id} style={{ cursor: 'default' }}>
                <td style={{ textTransform: 'capitalize' }}>{c.type.replace('_', ' ')}</td>
                <td><CommandStatus status={c.status} /></td>
                <td style={{ maxWidth: 360, fontSize: 12, color: 'var(--text-muted)' }}><CommandResult result={c.result} /></td>
                <td>{c.created_by || '—'}</td>
                <td>{formatIST(c.created_at)}</td>
                <td>{formatIST(c.completed_at)}</td>
              </tr>
            ))}
            {commands.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>No commands issued yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Audit / Event Log</h3>
          <select value={eventLevel} onChange={(e) => setEventLevel(e.target.value as any)}>
            <option value="critical">Critical only</option>
            <option value="error">Critical + Errors</option>
            <option value="all">Everything (incl. warnings)</option>
          </select>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          Serious problems from the device's Windows event logs. Shows Critical events by default; use the filter to include Errors.
        </p>
        <table>
          <thead>
            <tr><th>Time</th><th>Log</th><th>Level</th><th>Source</th><th>Message</th></tr>
          </thead>
          <tbody>
            {eventList.map((e: any) => (
              <tr key={e.id} style={{ cursor: 'default' }}>
                <td style={{ whiteSpace: 'nowrap' }}>{formatIST(e.logged_at)}</td>
                <td>{e.log_name}</td>
                <td><EventLevel level={e.level} /></td>
                <td>{e.source || '—'}</td>
                <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.message}>{e.message}</td>
              </tr>
            ))}
            {eventList.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>No events at this severity.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showReset && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(27,40,73,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={() => setShowReset(false)}
        >
          <div className="card" style={{ padding: 26, width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Reset Windows password</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Sets a new password for a <strong>local</strong> account on <strong>{device.name}</strong>. Microsoft-account and domain logins
              can't be reset this way — for a Microsoft account the user resets it at account.microsoft.com.
            </p>
            {rpDone ? (
              <div>
                <p style={{ fontSize: 14, marginBottom: 8 }}>
                  Reset queued — the device applies it within ~15s (check Command History for the result). Give the user this temporary password:
                </p>
                <div className="card" style={{ padding: 12, background: 'var(--bg)', fontFamily: 'monospace', fontSize: 16, textAlign: 'center', marginBottom: 8, userSelect: 'all' }}>
                  {rpDone}
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                  This is shown only once and is deleted from the server as soon as the device applies it.
                </p>
                <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => { setShowReset(false); setRpDone(''); }}>Done</button>
              </div>
            ) : (
              <form onSubmit={submitReset} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {device.agent_elevated === 0 && (
                  <div style={{ fontSize: 13, background: 'var(--warning-bg)', color: 'var(--warning)', padding: '8px 12px', borderRadius: 8 }}>
                    This device's agent is not running as administrator, so Windows will refuse the reset. Re-run the latest ElloraMdmAgent.exe on it and approve the permission prompt.
                  </div>
                )}
                <div>
                  <label>Windows account</label>
                  {localUsers.length > 0 ? (
                    <select required style={{ width: '100%', marginTop: 6 }} value={rp.username} onChange={(e) => setRp({ ...rp, username: e.target.value })}>
                      <option value="" disabled>Select an account…</option>
                      {localUsers.map((u) => (
                        <option key={u} value={u}>{u}{u.toLowerCase() === (device.logged_in_user || '').toLowerCase() ? ' (currently signed in)' : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <input required style={{ width: '100%', marginTop: 6 }} value={rp.username} onChange={(e) => setRp({ ...rp, username: e.target.value })} placeholder="Account list not reported yet — type the name" />
                  )}
                </div>
                <div>
                  <label>New password (min 8 characters)</label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <input
                      required minLength={8} autoComplete="new-password"
                      type={rpShow ? 'text' : 'password'}
                      style={{ flex: 1 }} value={rp.newPassword}
                      onChange={(e) => setRp({ ...rp, newPassword: e.target.value })}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRpShow((v) => !v)}>{rpShow ? 'Hide' : 'Show'}</button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={generatePassword}>Generate</button>
                  </div>
                </div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={rp.mustChange} onChange={(e) => setRp({ ...rp, mustChange: e.target.checked })} />
                  Require the user to choose a new password at next sign-in
                </label>
                <div>
                  <label>Confirm with your MDM dashboard password</label>
                  <input required type="password" autoComplete="current-password" style={{ width: '100%', marginTop: 6 }} value={rp.adminPassword} onChange={(e) => setRp({ ...rp, adminPassword: e.target.value })} />
                </div>
                {rpError && (
                  <div style={{ color: 'var(--danger)', fontSize: 13, background: 'var(--danger-bg)', padding: '8px 12px', borderRadius: 8 }}>{rpError}</div>
                )}
                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  <button type="button" className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setShowReset(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} disabled={busy}>Reset password</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(27,40,73,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={() => setConfirmDelete(false)}
        >
          <div className="card" style={{ padding: 26, width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: 'var(--danger)' }}>Delete this device?</h3>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 20 }}>
              This removes <strong>{device.name}</strong> from Ellora MDM, including its history, commands, and events.
              Its agent will detect this on its next check-in, remove itself from auto-start, and shut down —
              freeing the device for a fresh enrollment later.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="btn btn-danger" style={{ flex: 1, justifyContent: 'center' }} disabled={busy} onClick={handleDelete}>Yes, delete device</button>
            </div>
          </div>
        </div>
      )}

      {confirmWipe && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(27,40,73,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={() => setConfirmWipe(false)}
        >
          <div className="card" style={{ padding: 26, width: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: 'var(--danger)' }}>Wipe this device?</h3>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 20 }}>
              This will queue a remote wipe command for <strong>{device.name}</strong>. This action is irreversible once executed on the device and will erase all data.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setConfirmWipe(false)}>Cancel</button>
              <button className="btn btn-danger" style={{ flex: 1, justifyContent: 'center' }} onClick={handleWipe}>Yes, wipe device</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</span>
    </div>
  );
}

function CommandStatus({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'badge-warning',
    sent: 'badge-info',
    success: 'badge-success',
    failed: 'badge-danger'
  };
  return <span className={`badge ${map[status] || 'badge-neutral'}`}>{status}</span>;
}

function CommandResult({ result }: { result: string | null }) {
  if (!result) return <>—</>;
  try {
    const r = JSON.parse(result);
    if (r.log) {
      return (
        <details>
          <summary style={{ cursor: 'pointer' }}>{r.note || 'Agent log'}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto', fontSize: 11, marginTop: 6, color: 'var(--text)' }}>{r.log}</pre>
        </details>
      );
    }
    return <>{r.error || r.note || '—'}</>;
  } catch {
    return <>{result}</>;
  }
}

function commandResultText(result: string | null): string {
  if (!result) return '—';
  try {
    const r = JSON.parse(result);
    return r.error || r.note || '—';
  } catch {
    return result;
  }
}

function EventLevel({ level }: { level: string }) {
  const map: Record<string, string> = {
    Critical: 'badge-danger',
    Error: 'badge-danger',
    Warning: 'badge-warning',
    Information: 'badge-neutral'
  };
  return <span className={`badge ${map[level] || 'badge-neutral'}`}>{level}</span>;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}
