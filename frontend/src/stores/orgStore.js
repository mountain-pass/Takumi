/**
 * Zustand store — single source of truth for org state.
 * Populated via WebSocket + REST API.
 */
import { create } from 'zustand'

const API = '/api'

export const useOrgStore = create((set, get) => ({
  agents: [],       // AgentState[]
  tasks: [],        // Task[]
  messages: [],     // AgentMessage[]
  connected: false,
  selectedAgentId: null,
  ws: null,

  // ── Navigation ─────────────────────────────────────────────────────────────
  pendingNav: null,
  navigateTo(view) { set({ pendingNav: view }) },
  clearNav() { set({ pendingNav: null }) },

  // ── Org / setup ────────────────────────────────────────────────────────────
  orgName: '',
  orgDescription: '',
  setupDone: null,   // null = loading, false = needs setup, true = ready

  async fetchOrg() {
    try {
      const res = await fetch(`${API}/org`)
      const data = await res.json()
      set({ orgName: data.org_name, orgDescription: data.org_description, setupDone: !!data.configured })
    } catch {
      set({ setupDone: false })
    }
  },

  async saveOrg(org_name, org_description) {
    await fetch(`${API}/org`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_name, org_description }),
    })
    set({ orgName: org_name, orgDescription: org_description })
  },

  async saveLLMSettings(settings) {
    await fetch(`${API}/settings/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
  },

  async testLLM(settings) {
    const res = await fetch(`${API}/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(err)
    }
    return res.json()
  },

  async enhancePrompt(payload) {
    const res = await fetch(`${API}/prompt-enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async completeSetup() {
    await fetch(`${API}/setup/complete`, { method: 'POST' })
    set({ setupDone: true })
  },

  // ── WebSocket ──────────────────────────────────────────────────────────────
  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`)

    ws.onopen = () => set({ connected: true })
    ws.onclose = () => {
      set({ connected: false })
      setTimeout(() => get().connect(), 3000)   // auto-reconnect
    }
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data)
      get()._handleWS(event)
    }
    set({ ws })
  },

  _handleWS(event) {
    const { type, payload } = event
    if (type === 'init') {
      set({ agents: payload.agents, tasks: payload.tasks, messages: payload.messages || [] })
    } else if (type === 'agent_status') {
      set(s => ({
        agents: s.agents.map(a => a.config.id === payload.config.id ? payload : a)
      }))
    } else if (type === 'agent_message') {
      set(s => ({ messages: [...s.messages.slice(-499), payload] }))
    } else if (type === 'task_update') {
      set(s => ({
        tasks: s.tasks.some(t => t.id === payload.id)
          ? s.tasks.map(t => t.id === payload.id ? payload : t)
          : [...s.tasks, payload]
      }))
    } else if (type === 'agent_added') {
      // Reload agents list
      get().fetchAgents()
    } else if (type === 'agent_removed') {
      set(s => ({ agents: s.agents.filter(a => a.config.id !== payload.agent_id) }))
    }
  },

  // ── REST ───────────────────────────────────────────────────────────────────
  async fetchAgents() {
    const res = await fetch(`${API}/agents`)
    const agents = await res.json()
    set({ agents })
  },

  async fetchTasks() {
    const res = await fetch(`${API}/tasks`)
    const tasks = await res.json()
    set({ tasks })
  },

  async createAgent(data) {
    const res = await fetch(`${API}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(await res.text())
    await get().fetchAgents()
  },

  async removeAgent(id) {
    await fetch(`${API}/agents/${id}`, { method: 'DELETE' })
  },

  async updateAgent(id, data) {
    const res = await fetch(`${API}/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(await res.text())
    await get().fetchAgents()
  },

  async submitTask(title, description) {
    const res = await fetch(`${API}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    })
    const task = await res.json()
    set(s => ({ tasks: [...s.tasks, task] }))
    return task
  },

  selectAgent(id) { set({ selectedAgentId: id }) },
  clearSelected() { set({ selectedAgentId: null }) },

  // ── Connections ──────────────────────────────────────────────────────────
  async fetchConnections() {
    const res = await fetch(`${API}/connections`)
    return res.json()
  },

  async createConnection(from_id, to_id, label = '') {
    const res = await fetch(`${API}/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_id, to_id, label }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async updateConnection(from_id, to_id, label) {
    await fetch(`${API}/connections/${from_id}/${to_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    })
  },

  async deleteConnection(from_id, to_id) {
    await fetch(`${API}/connections/${from_id}/${to_id}`, { method: 'DELETE' })
  },

  // ── Canvas positions ────────────────────────────────────────────────────
  async saveCanvasPositions(positions) {
    await fetch(`${API}/canvas/positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions }),
    })
  },

  // ── Message history ─────────────────────────────────────────────────────
  async fetchMessageHistory(fromAgent, toAgent, limit = 100) {
    const params = new URLSearchParams()
    if (fromAgent) params.set('from_agent', fromAgent)
    if (toAgent) params.set('to_agent', toAgent)
    params.set('limit', limit)
    const res = await fetch(`${API}/messages/history?${params}`)
    return res.json()
  },
}))
