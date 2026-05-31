/**
 * TanStack Query hooks for API data fetching with cache invalidation.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

const API = '/api'

async function apiFetch(url, opts) {
  const res = await fetch(url, opts)
  if (!res.ok) {
    const text = await res.text()
    let msg = text
    try { msg = JSON.parse(text).detail || text } catch {}
    throw new Error(msg)
  }
  return res.json()
}

// ── Query keys ──────────────────────────────────────────────────────────────

export const queryKeys = {
  agents: ['agents'],
  connections: ['connections'],
  org: ['org'],
  ollamaModels: (baseUrl, apiKey) => ['ollama-models', baseUrl, apiKey],
  providers: ['providers'],
  providerModels: (id) => ['provider-models', id],
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => apiFetch(`${API}/agents`),
  })
}

export function useConnections() {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => apiFetch(`${API}/connections`),
  })
}

export function useOrg() {
  return useQuery({
    queryKey: queryKeys.org,
    queryFn: () => apiFetch(`${API}/org`),
  })
}

export function useOllamaModels(baseUrl, apiKey) {
  return useQuery({
    queryKey: queryKeys.ollamaModels(baseUrl, apiKey),
    queryFn: () => {
      const params = new URLSearchParams()
      if (baseUrl) params.set('base_url', baseUrl)
      if (apiKey) params.set('api_key', apiKey)
      return apiFetch(`${API}/ollama/models?${params}`)
    },
    enabled: !!baseUrl,
  })
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useCreateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data) => apiFetch(`${API}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.agents }),
  })
}

export function useUpdateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }) => apiFetch(`${API}/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.agents }),
  })
}

export function useRemoveAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => apiFetch(`${API}/agents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents })
      qc.invalidateQueries({ queryKey: queryKeys.connections })
    },
  })
}

export function useCreateConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ from_id, to_id, label }) => apiFetch(`${API}/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_id, to_id, label }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  })
}

export function useUpdateConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ from_id, to_id, label }) => apiFetch(`${API}/connections/${from_id}/${to_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  })
}

export function useDeleteConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ from_id, to_id }) => apiFetch(`${API}/connections/${from_id}/${to_id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  })
}

export function useSaveCanvasPositions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (positions) => apiFetch(`${API}/canvas/positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.agents }),
  })
}

export function useSaveOrg() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ org_name, org_description }) => apiFetch(`${API}/org`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_name, org_description }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.org }),
  })
}

export function useSaveLLMSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (settings) => apiFetch(`${API}/settings/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.org }),
  })
}

export function useTestLLM() {
  return useMutation({
    mutationFn: (settings) => apiFetch(`${API}/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),
  })
}

// ── API Providers ────────────────────────────────────────────────────────────

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: () => apiFetch(`${API}/providers`),
  })
}

export function useProviderModels(providerId) {
  return useQuery({
    queryKey: queryKeys.providerModels(providerId),
    queryFn: () => apiFetch(`${API}/providers/${providerId}/models`),
    enabled: !!providerId,
  })
}

export function useCreateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data) => apiFetch(`${API}/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  })
}

export function useUpdateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }) => apiFetch(`${API}/providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  })
}

export function useDeleteProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => apiFetch(`${API}/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  })
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (id) => apiFetch(`${API}/providers/${id}/test`, { method: 'POST' }),
  })
}
