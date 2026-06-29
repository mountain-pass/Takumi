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

  // ── Chat history (global sidebar) + artifact viewer ─────────────────────────
  chatConversations: [],
  activeConvId: null,
  convNonce: 0,            // bumps to tell ChatView to (re)load the active conversation
  artifact: null,          // { id, title } currently shown in the right viewer pane

  async loadChatConversations() {
    try {
      const res = await fetch(`${API}/conversations`)
      if (res.ok) set({ chatConversations: await res.json() })
    } catch {}
  },
  // Open a conversation from the sidebar (switches to Chat and signals a load).
  // Closing the artifact viewer too — it belongs to the chat we're leaving.
  openConversation(id) {
    set(s => ({ activeConvId: id, convNonce: s.convNonce + 1, pendingNav: 'chat', artifact: null }))
  },
  newChat() {
    set(s => ({ activeConvId: null, convNonce: s.convNonce + 1, pendingNav: 'chat', artifact: null }))
  },
  setActiveConvId(id) { set({ activeConvId: id }) },
  openArtifact(a) { set({ artifact: a }) },
  closeArtifact() { set({ artifact: null }) },

  // ── Workflows ────────────────────────────────────────────────────────────────
  workflows: [],
  wfRun: null,   // live run being observed: { runId, status, steps: {nodeId: {status, output, compliance}} }

  async loadWorkflows() {
    try {
      const res = await fetch(`${API}/workflows`)
      if (res.ok) { const d = await res.json(); set({ workflows: d.workflows || [] }) }
    } catch {}
  },
  async createWorkflow(body = {}) {
    const res = await fetch(`${API}/workflows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const wf = await res.json()
    get().loadWorkflows()
    return wf
  },
  async getWorkflow(id) {
    const res = await fetch(`${API}/workflows/${id}`)
    return res.ok ? await res.json() : null
  },
  async saveWorkflow(id, updates) {
    const res = await fetch(`${API}/workflows/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
    })
    const wf = await res.json()
    get().loadWorkflows()
    return wf
  },
  async deleteWorkflow(id) {
    await fetch(`${API}/workflows/${id}`, { method: 'DELETE' })
    get().loadWorkflows()
  },
  async testWorkflow(id, payload = {}) {
    set({ wfRun: { runId: null, status: 'running', steps: {} } })
    const res = await fetch(`${API}/workflows/${id}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }),
    })
    if (!res.ok) { set({ wfRun: { runId: null, status: 'failed', steps: {} } }); return null }
    const d = await res.json()
    if (d.timeout) { set({ wfRun: { runId: null, status: 'failed', steps: {}, order: [], note: d.message } }); return d }
    // Reconcile from the returned run (covers anything missed over WS).
    const steps = {}, order = []
    for (const s of (d.run?.steps || [])) { steps[s.node_id] = { status: s.status, output: s.output, input: s.input, compliance: s.compliance, error: s.error }; if (!order.includes(s.node_id)) order.push(s.node_id) }
    set({ wfRun: { runId: d.run_id, status: d.run?.status || 'success', steps, order } })
    return d
  },
  async stopTest(id) {
    try { await fetch(`${API}/workflows/${id}/stop-test`, { method: 'POST' }) } catch {}
  },
  providers: [],
  async loadProviders() {
    try {
      const res = await fetch(`${API}/providers`)
      if (res.ok) set({ providers: (await res.json()).filter(p => p.type === 'llm') })
    } catch {}
  },
  async getProviderModels(id) {
    try {
      const res = await fetch(`${API}/providers/${id}/models`)
      return res.ok ? ((await res.json()).models || []) : []
    } catch { return [] }
  },
  async formatCode(code, language) {
    try {
      const res = await fetch(`${API}/workflows/format`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language }),
      })
      return res.ok ? await res.json() : null
    } catch { return null }
  },
  async listDir(path = '') {
    const res = await fetch(`${API}/workflows/fs/list?path=${encodeURIComponent(path)}`)
    if (!res.ok) return null
    return res.json()
  },
  async executeStep(id, nodeId, payload = {}, single = false, context = null) {
    const res = await fetch(`${API}/workflows/${id}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, until: nodeId, single, context }),
    })
    if (!res.ok) return null
    const d = await res.json()
    // 'This step only' (single) re-runs one node — keep the prior run's other steps
    // so the INPUT pane (upstream outputs) doesn't vanish.
    const prev = single ? (get().wfRun || {}) : {}
    const steps = { ...(prev.steps || {}) }, order = [...(prev.order || [])]
    for (const s of (d.run?.steps || [])) { steps[s.node_id] = { status: s.status, output: s.output, input: s.input, compliance: s.compliance, error: s.error }; if (!order.includes(s.node_id)) order.push(s.node_id) }
    set({ wfRun: { runId: d.run_id, status: d.run?.status || 'success', steps, order } })
    return d.run
  },
  async getRun(runId) {
    const res = await fetch(`${API}/workflows/runs/${runId}`)
    if (!res.ok) return null
    const run = await res.json()
    const steps = {}, order = []
    for (const s of (run.steps || [])) { steps[s.node_id] = { status: s.status, output: s.output, input: s.input, compliance: s.compliance, error: s.error, input_tokens: s.input_tokens, output_tokens: s.output_tokens }; if (!order.includes(s.node_id)) order.push(s.node_id) }
    set({ wfRun: { runId: run.id, status: run.status, steps, order } })
    return run
  },
  async deleteRun(runId) {
    await fetch(`${API}/workflows/runs/${runId}`, { method: 'DELETE' })
  },
  async deleteAllRuns(workflowId) {
    await fetch(`${API}/workflows/${workflowId}/runs`, { method: 'DELETE' })
  },
  async publishWorkflow(id, live) {
    const res = await fetch(`${API}/workflows/${id}/${live ? 'publish' : 'unpublish'}`, { method: 'POST' })
    const wf = res.ok ? await res.json() : null
    get().loadWorkflows()
    return wf
  },

  // ── Notifications ────────────────────────────────────────────────────────────
  notifications: [],
  notifUnread: 0,

  async loadNotifications() {
    try {
      const res = await fetch(`${API}/notifications?limit=50`)
      if (res.ok) {
        const data = await res.json()
        set({ notifications: data.notifications || [], notifUnread: data.unread || 0 })
      }
    } catch {}
  },

  // Route the user to wherever a notification points, then mark it read.
  openNotification(n) {
    if (n.link_view === 'chat' && n.link_id) get().openConversation(n.link_id)
    else if (n.link_view) get().navigateTo(n.link_view)
    get().markNotificationRead(n.id)
  },

  async markNotificationRead(id) {
    set(s => ({
      notifications: s.notifications.map(n => n.id === id ? { ...n, read: 1 } : n),
      notifUnread: Math.max(0, s.notifUnread - (s.notifications.find(n => n.id === id && !n.read) ? 1 : 0)),
    }))
    try { await fetch(`${API}/notifications/${id}/read`, { method: 'POST' }) } catch {}
  },

  async dismissNotification(id) {
    set(s => ({
      notifications: s.notifications.filter(n => n.id !== id),
      notifUnread: Math.max(0, s.notifUnread - (s.notifications.find(n => n.id === id && !n.read) ? 1 : 0)),
    }))
    try { await fetch(`${API}/notifications/${id}`, { method: 'DELETE' }) } catch {}
  },

  async clearNotifications() {
    set({ notifications: [], notifUnread: 0 })
    try { await fetch(`${API}/notifications`, { method: 'DELETE' }) } catch {}
  },

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
    } else if (type === 'heartbeat') {
      // Periodic full-state snapshot — reconcile so a missed agent_status event
      // can't leave an agent stuck showing "Thinking" until a manual refresh.
      if (Array.isArray(payload.agents) && payload.agents.length) {
        set({ agents: payload.agents })
      }
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
    } else if (type === 'task_completed') {
      // CEO synthesized results — push to chat as a live message
      const msg = {
        id: `tc-${Date.now()}`,
        role: 'assistant',
        content: payload.message,
        timestamp: new Date().toISOString(),
        isTaskResult: true,
      }
      if (payload.artifacts && payload.artifacts.length) msg.artifacts = payload.artifacts
      set(s => ({ pendingChatMessages: [...(s.pendingChatMessages || []), msg] }))
      get().loadChatConversations()
    } else if (type === 'self_heal') {
      // A code-fixable LLM/provider error — surface a proposal (or result) in chat.
      if (payload.kind === 'proposal') {
        set(s => ({ pendingChatMessages: [...(s.pendingChatMessages || []), {
          id: `sh-${payload.incident_id}`, role: 'assistant', selfHeal: payload,
          timestamp: new Date().toISOString(),
        }] }))
      } else if (payload.kind === 'result') {
        set(s => ({ pendingChatMessages: [...(s.pendingChatMessages || []), {
          id: `shr-${payload.incident_id}`, role: 'assistant', content: payload.message,
          isTaskResult: true, timestamp: new Date().toISOString(),
        }] }))
      }
    } else if (type === 'risk_hold') {
      // A task is held on a compliance review — surface an approve/reject card.
      set(s => ({ pendingChatMessages: [...(s.pendingChatMessages || []), {
        id: `risk-${payload.task_id}`, role: 'assistant', riskHold: payload,
        timestamp: new Date().toISOString(),
      }] }))
    } else if (type === 'notification') {
      // Live push from the backend — prepend (or refresh a deduped one).
      set(s => {
        const existing = s.notifications.find(n => n.id === payload.id)
        const list = existing
          ? s.notifications.map(n => n.id === payload.id ? payload : n)
          : [payload, ...s.notifications].slice(0, 50)
        const unread = list.filter(n => !n.read).length
        return { notifications: list, notifUnread: unread }
      })
    } else if (type === 'workflow_run') {
      set(s => ({ wfRun: { ...(s.wfRun || { steps: {} }), runId: payload.run_id, status: payload.status } }))
    } else if (type === 'workflow_step') {
      set(s => {
        const run = s.wfRun && s.wfRun.runId === payload.run_id ? s.wfRun : { runId: payload.run_id, status: 'running', steps: {}, order: [] }
        const order = (run.order || []).includes(payload.node_id) ? run.order : [...(run.order || []), payload.node_id]
        return { wfRun: { ...run, order, steps: { ...run.steps, [payload.node_id]: {
          status: payload.status, output: payload.output, compliance: payload.compliance, error: payload.error,
        } } } }
      })
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
