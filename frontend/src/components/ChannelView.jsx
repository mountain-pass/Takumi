/**
 * ChannelView — connect messaging channels (Telegram, …) to the platform. Inbound
 * messages route into the same Manager brain as web Chat (omni-channel), and replies
 * go back out to the originating channel.
 */
import React, { useEffect, useState } from 'react'
import {
  Radio, Plus, Trash2, X, Loader2, CheckCircle2, AlertCircle, Send, MessageCircle,
} from 'lucide-react'

const TYPE_META = {
  telegram: { label: 'Telegram', icon: Send, color: '#229ED9',
    help: 'Create a bot with @BotFather in Telegram, then paste the token it gives you. Message your bot to chat with the platform.',
    fields: [{ key: 'bot_token', label: 'Bot token', placeholder: '123456:ABC-...' }] },
  slack:    { label: 'Slack', icon: MessageCircle, color: '#4A154B',
    help: 'Create a Slack app, enable Socket Mode (gives an app-level xapp- token), add the chat:write scope + message events, and install it (gives the xoxb- bot token).',
    fields: [{ key: 'bot_token', label: 'Bot token (xoxb-)', placeholder: 'xoxb-...' },
             { key: 'app_token', label: 'App-level token (xapp-)', placeholder: 'xapp-...' }] },
  discord:  { label: 'Discord', icon: MessageCircle, color: '#5865F2',
    help: 'Create a Discord app + bot, enable the MESSAGE CONTENT intent, invite it to your server, and paste the bot token. It replies in whatever channel it is messaged in.',
    fields: [{ key: 'bot_token', label: 'Bot token', placeholder: 'Bot token' }] },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, color: '#25D366',
    help: 'Meta Cloud API. Sending works right away. Inbound needs a PUBLIC webhook — point Meta at /api/channels/whatsapp/webhook using the same verify token (use a tunnel locally).',
    fields: [{ key: 'access_token', label: 'Access token' },
             { key: 'phone_number_id', label: 'Phone number ID', secret: false, placeholder: '1234567890' },
             { key: 'verify_token', label: 'Webhook verify token', secret: false, placeholder: 'any string you choose' }] },
}

const STATUS = {
  connected:    { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50 border-green-200', label: 'Connected' },
  disconnected: { icon: Radio,        color: 'text-gray-400',  bg: 'bg-gray-50 border-gray-200',   label: 'Off' },
  error:        { icon: AlertCircle,  color: 'text-red-500',   bg: 'bg-red-50 border-red-200',     label: 'Error' },
}

export default function ChannelView() {
  const [channels, setChannels] = useState([])
  const [types, setTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const [c, t] = await Promise.all([
        fetch('/api/channels').then(r => r.json()),
        fetch('/api/channels/types').then(r => r.json()),
      ])
      setChannels(Array.isArray(c) ? c : [])
      setTypes(Array.isArray(t) ? t : [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function toggle(ch) {
    setBusyId(ch.id)
    try {
      await fetch(`/api/channels/${ch.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !ch.enabled }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  async function remove(ch) {
    if (!confirm(`Remove the "${ch.name || TYPE_META[ch.type]?.label}" channel?`)) return
    setBusyId(ch.id)
    try {
      await fetch(`/api/channels/${ch.id}`, { method: 'DELETE' })
      await load()
    } finally { setBusyId(null) }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div>
          <h1 className="text-lg font-semibold text-gray-800">Channels</h1>
          <p className="text-xs text-gray-400">Talk to the platform from Telegram and more — every channel shares the same memory.</p>
        </div>
        <button onClick={() => setAdding(true)}
          className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">
          <Plus size={16} /> Add channel
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="h-full flex items-center justify-center text-gray-400"><Loader2 className="animate-spin" /></div>
        ) : channels.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
            <Radio size={40} strokeWidth={1.5} />
            <p className="text-sm font-medium">No channels connected</p>
            <button onClick={() => setAdding(true)} className="text-indigo-600 text-sm font-medium hover:underline">
              Connect your first channel
            </button>
          </div>
        ) : (
          <div className="space-y-2 max-w-3xl mx-auto">
            {channels.map(ch => {
              const meta = TYPE_META[ch.type] || { label: ch.type, icon: Radio, color: '#888' }
              const Icon = meta.icon
              const st = STATUS[ch.status] || STATUS.disconnected
              const StIcon = st.icon
              return (
                <div key={ch.id} className="flex items-center gap-4 px-4 py-3 bg-white border border-gray-200 rounded-xl">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: meta.color + '1a' }}>
                    <Icon size={18} style={{ color: meta.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-800 truncate">{ch.name || meta.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium inline-flex items-center gap-1 ${st.bg} ${st.color}`}>
                        <StIcon size={10} /> {st.label}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5 truncate">
                      {meta.label}{ch.status === 'error' && ch.status_detail ? ` · ${ch.status_detail}` : ''}
                    </div>
                  </div>
                  <label className="flex items-center cursor-pointer shrink-0" title={ch.enabled ? 'Turn off' : 'Turn on'}>
                    <input type="checkbox" className="sr-only peer" checked={ch.enabled} disabled={busyId === ch.id} onChange={() => toggle(ch)} />
                    <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:bg-indigo-600 relative transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
                  </label>
                  <button onClick={() => remove(ch)} disabled={busyId === ch.id}
                    className="p-2 text-gray-400 hover:text-red-500 shrink-0"><Trash2 size={15} /></button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {adding && <AddChannelModal types={types} onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await load() }} />}
    </div>
  )
}

function AddChannelModal({ types, onClose, onAdded }) {
  const [type, setType] = useState('telegram')
  const [name, setName] = useState('')
  const [cfg, setCfg] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const meta = TYPE_META[type] || {}
  const available = (types.find(t => t.type === type) || {}).available
  const fields = meta.fields || []

  async function submit() {
    const config = {}
    for (const f of fields) {
      const v = (cfg[f.key] || '').trim()
      if (!v) { setError(`Enter ${f.label}.`); return }
      config[f.key] = v
    }
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/channels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name: name.trim(), config, enabled: true }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Could not add channel')
      await onAdded()
    } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800">Add a channel</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <label className="block text-[11px] font-medium text-gray-500 mb-1">Channel</label>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {types.map(t => {
            const m = TYPE_META[t.type] || { label: t.type, icon: Radio }
            const Icon = m.icon
            return (
              <button key={t.type} disabled={!t.available} onClick={() => { setType(t.type); setCfg({}); setError('') }}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg border text-[11px] ${type === t.type ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200'} ${t.available ? 'hover:border-indigo-300' : 'opacity-40 cursor-not-allowed'}`}
                title={t.available ? '' : 'Coming soon'}>
                <Icon size={18} style={{ color: m.color }} /> {m.label}
              </button>
            )
          })}
        </div>

        {available ? (
          <>
            <p className="text-xs text-gray-500 mb-3 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">{meta.help}</p>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Name (optional)</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Support bot"
              className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 mb-3 outline-none focus:border-indigo-400" />
            {fields.map(f => (
              <div key={f.key} className="mb-3">
                <label className="block text-[11px] font-medium text-gray-500 mb-1">{f.label}</label>
                <input value={cfg[f.key] || ''} onChange={e => setCfg(c => ({ ...c, [f.key]: e.target.value }))}
                  type={f.secret === false ? 'text' : 'password'} placeholder={f.placeholder || ''}
                  className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400" />
              </div>
            ))}
            {error && <p className="text-[11px] text-red-500 mt-2">{error}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">Cancel</button>
              <button onClick={submit} disabled={busy}
                className="px-3 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-1.5">
                {busy && <Loader2 size={14} className="animate-spin" />} Connect & test
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400 py-6 text-center">{meta.label} support is coming soon.</p>
        )}
      </div>
    </div>
  )
}
