import React, { useState, useEffect } from 'react'
import { Plug, Plus, Trash2, RefreshCw, X, CheckCircle2, AlertCircle, Loader2, Server, Lock, LogIn, LogOut } from 'lucide-react'
import { useBackdropDismiss } from './useBackdropDismiss'

const API = '/api'
const apiFetch = (url, opts) => fetch(url, opts).then(async r => {
  if (!r.ok) throw new Error(await r.text())
  return r.json()
})

const BLANK = {
  name: '', transport: 'stdio', command: '', args: '', env: '',
  url: '', headers: '', auth: 'none', enabled: true,
}

export default function SkillMarketplaceView() {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)   // server object or BLANK
  const [busyId, setBusyId] = useState(null)

  async function load(silent = false) {
    if (!silent) setLoading(true)
    try { setServers(await apiFetch(`${API}/mcp/servers`)) }
    catch (e) { console.error(e) }
    finally { if (!silent) setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // While any server is awaiting OAuth authorization, poll so the card flips to
  // "connected" once the user finishes the browser consent.
  const awaiting = servers.some(s => s.status === 'awaiting_auth')
  useEffect(() => {
    if (!awaiting) return
    const t = setInterval(() => load(true), 2500)
    return () => clearInterval(t)
  }, [awaiting])

  async function refresh(id) {
    setBusyId(id)
    try { await apiFetch(`${API}/mcp/servers/${id}/refresh`, { method: 'POST' }); await load() }
    catch (e) { alert(`Refresh failed: ${e.message}`) }
    finally { setBusyId(null) }
  }

  function authorize(s) {
    if (s.authorize_url) {
      window.open(s.authorize_url, 'mcp-oauth', 'width=600,height=760')
      load(true)
    }
  }

  async function signout(id) {
    await apiFetch(`${API}/mcp/servers/${id}/signout`, { method: 'POST' })
    load()
  }

  async function remove(id) {
    if (!confirm('Remove this MCP server?')) return
    await apiFetch(`${API}/mcp/servers/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div>
          <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <Plug size={18} /> MCP Servers
          </h2>
          <p className="text-xs text-gray-400">Connect agents to Model Context Protocol tool servers (filesystem, GitHub, Xero, …).</p>
        </div>
        <button
          onClick={() => setEditing({ ...BLANK })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg"
        >
          <Plus size={16} /> Add Server
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center text-gray-400 py-10"><Loader2 className="animate-spin" /></div>
        ) : servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-gray-400 gap-3 py-16">
            <Server size={36} strokeWidth={1.5} />
            <p className="text-sm font-medium">No MCP servers configured</p>
            <p className="text-xs max-w-xs text-center">Add a server to give your agents new tools. Grant access per agent in the agent editor.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {servers.map(s => (
              <ServerCard key={s.id} s={s} busy={busyId === s.id}
                onRefresh={() => refresh(s.id)} onEdit={() => setEditing(s)} onRemove={() => remove(s.id)}
                onAuthorize={() => authorize(s)} onSignout={() => signout(s.id)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ServerModal server={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}

function StatusBadge({ status, error }) {
  const map = {
    connected: ['text-green-700 bg-green-50', <CheckCircle2 size={12} key="i" />, 'Connected'],
    connecting: ['text-amber-700 bg-amber-50', <Loader2 size={12} className="animate-spin" key="i" />, 'Connecting'],
    awaiting_auth: ['text-blue-700 bg-blue-50', <Lock size={12} key="i" />, 'Needs sign-in'],
    error: ['text-red-700 bg-red-50', <AlertCircle size={12} key="i" />, 'Error'],
    disconnected: ['text-gray-500 bg-gray-100', <AlertCircle size={12} key="i" />, 'Offline'],
  }
  const [cls, icon, label] = map[status] || map.disconnected
  return (
    <span title={error || ''} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}`}>
      {icon} {label}
    </span>
  )
}

function ServerCard({ s, busy, onRefresh, onEdit, onRemove, onAuthorize, onSignout }) {
  return (
    <div className="border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-800">{s.name}</span>
            <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">{s.transport}</span>
            <StatusBadge status={s.status} error={s.error} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">
            {s.transport === 'stdio' ? `${s.command} ${(s.args || []).join(' ')}` : s.url}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onRefresh} disabled={busy} title="Reconnect" className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-gray-100 rounded-lg">
            <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
          </button>
          <button onClick={onEdit} title="Edit" className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">Edit</button>
          <button onClick={onRemove} title="Remove" className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-gray-100 rounded-lg">
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {s.error && <p className="text-xs text-red-600 mt-2">{s.error}</p>}

      {s.status === 'awaiting_auth' && (
        <div className="mt-3 flex items-center gap-2">
          <button onClick={onAuthorize}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
            <LogIn size={13} /> Authorize with provider
          </button>
          <span className="text-[11px] text-gray-400">Opens a sign-in window; this card updates automatically.</span>
        </div>
      )}

      {s.auth === 'oauth' && s.status === 'connected' && (
        <button onClick={onSignout}
          className="mt-3 flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-500 hover:text-red-600 hover:bg-gray-100 rounded-lg">
          <LogOut size={12} /> Sign out
        </button>
      )}

      {s.tools && s.tools.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {s.tools.map(t => (
            <span key={t.full_name} title={t.description} className="text-[11px] text-indigo-700 bg-indigo-50 rounded px-1.5 py-0.5">
              {t.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ServerModal({ server, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    ...BLANK,
    ...server,
    args: Array.isArray(server.args) ? server.args.join(' ') : (server.args || ''),
    env: server.env && typeof server.env === 'object' ? JSON.stringify(server.env, null, 2) : (server.env || ''),
    headers: server.headers && typeof server.headers === 'object' ? JSON.stringify(server.headers, null, 2) : (server.headers || ''),
  }))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    setErr('')
    let env = {}, headers = {}
    try { env = form.env.trim() ? JSON.parse(form.env) : {} } catch { setErr('Env must be valid JSON'); return }
    try { headers = form.headers.trim() ? JSON.parse(form.headers) : {} } catch { setErr('Headers must be valid JSON'); return }
    const body = {
      name: form.name.trim(),
      transport: form.transport,
      command: form.command.trim(),
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      env,
      url: form.url.trim(),
      headers,
      auth: form.transport === 'stdio' ? 'none' : form.auth,
      enabled: form.enabled,
    }
    if (!body.name) { setErr('Name is required'); return }
    if (body.transport === 'stdio' && !body.command) { setErr('Command is required for stdio'); return }
    if (body.transport !== 'stdio' && !body.url) { setErr('URL is required for http/sse'); return }
    setSaving(true)
    try {
      const isEdit = !!server.id
      await apiFetch(`${API}/mcp/servers${isEdit ? '/' + server.id : ''}`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      onSaved()
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
  }

  const isStdio = form.transport === 'stdio'
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" {...useBackdropDismiss(onClose)}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800">{server.id ? 'Edit MCP Server' : 'Add MCP Server'}</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <Field label="Name">
            <input className={inp} value={form.name} onChange={e => set('name', e.target.value)} placeholder="Filesystem" />
          </Field>

          <Field label="Transport">
            <select className={inp} value={form.transport} onChange={e => set('transport', e.target.value)}>
              <option value="stdio">stdio (local subprocess)</option>
              <option value="http">http (streamable HTTP)</option>
              <option value="sse">sse (server-sent events)</option>
            </select>
          </Field>

          {isStdio ? (
            <>
              <Field label="Command">
                <input className={inp} value={form.command} onChange={e => set('command', e.target.value)} placeholder="npx" />
              </Field>
              <Field label="Arguments (space-separated)">
                <input className={inp} value={form.args} onChange={e => set('args', e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /tmp" />
              </Field>
              <Field label="Environment (JSON, optional)">
                <textarea className={`${inp} font-mono text-xs h-20`} value={form.env} onChange={e => set('env', e.target.value)} placeholder='{"API_KEY": "..."}' />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <input className={inp} value={form.url} onChange={e => set('url', e.target.value)} placeholder="https://example.com/mcp" />
              </Field>
              <Field label="Authentication">
                <select className={inp} value={form.auth} onChange={e => set('auth', e.target.value)}>
                  <option value="none">None / static header</option>
                  <option value="oauth">OAuth 2.0 (sign in with provider)</option>
                </select>
              </Field>
              {form.auth === 'oauth' ? (
                <p className="text-[11px] text-gray-400 -mt-1">
                  After saving, click <b>Authorize with provider</b> on the server card to sign in. Tokens are stored and refreshed automatically.
                </p>
              ) : (
                <Field label="Headers (JSON, optional)">
                  <textarea className={`${inp} font-mono text-xs h-20`} value={form.headers} onChange={e => set('headers', e.target.value)} placeholder='{"Authorization": "Bearer ..."}' />
                </Field>
              )}
            </>
          )}

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-indigo-600" />
            Enabled (connect on save)
          </label>

          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg flex items-center gap-1.5">
            {saving && <Loader2 size={14} className="animate-spin" />} Save & Connect
          </button>
        </div>
      </div>
    </div>
  )
}

const inp = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none'

function Field({ label, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}
