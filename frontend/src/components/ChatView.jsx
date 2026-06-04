import React, { useState, useEffect, useRef } from 'react'
import {
  Send, Plus, Loader2, MessageSquare, PanelRightOpen, PanelRightClose,
  Trash2, Clock, Sparkles, ToggleLeft, ToggleRight, Paperclip, X, FileText,
} from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'

const API = '/api'
const apiFetch = (url, opts) => fetch(url, opts).then(async r => {
  if (!r.ok) throw new Error(await r.text())
  return r.json()
})

export default function ChatView() {
  const orgName = useOrgStore(s => s.orgName)
  const pendingChatMessages = useOrgStore(s => s.pendingChatMessages || [])

  const [conversations, setConversations] = useState([])
  const [activeConvId, setActiveConvId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])  // {id, name, mime_type, kind, data, preview}
  const [sending, setSending] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [temporary, setTemporary] = useState(false)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => { loadConversations() }, [])

  // Pick up task-completed messages pushed via WebSocket
  useEffect(() => {
    if (pendingChatMessages.length > 0) {
      setMessages(prev => [...prev, ...pendingChatMessages])
      useOrgStore.setState({ pendingChatMessages: [] })
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }, [pendingChatMessages])

  async function loadConversations() {
    try {
      const data = await apiFetch(`${API}/conversations`)
      setConversations(data)
    } catch {}
  }

  async function loadMessages(convId) {
    try {
      const data = await apiFetch(`${API}/conversations/${convId}/messages`)
      // Hydrate actions from metadata for history messages
      for (const msg of data) {
        if (msg.metadata?.actions) {
          msg.actions = msg.metadata.actions
        }
        if (msg.metadata?.attachments) {
          msg.attachments = msg.metadata.attachments
        }
      }
      setMessages(data)
    } catch {}
  }

  function startNewChat() {
    setActiveConvId(null)
    setMessages([])
    setInput('')
    setAttachments([])
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  // Toggling Temporary always starts a fresh, isolated chat window. The prior
  // (persisted) conversation is left untouched; ephemeral context is discarded
  // when toggled off or navigated away.
  function toggleTemporary() {
    setTemporary(t => !t)
    setActiveConvId(null)
    setMessages([])
    setInput('')
    setAttachments([])
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  async function openConversation(conv) {
    setActiveConvId(conv.id)
    setTemporary(false)
    await loadMessages(conv.id)
  }

  async function deleteConversation(convId, e) {
    e.stopPropagation()
    await apiFetch(`${API}/conversations/${convId}`, { method: 'DELETE' })
    if (activeConvId === convId) startNewChat()
    loadConversations()
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || [])
    for (const file of files) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)  // data: URI
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const kind = file.type.startsWith('image/') ? 'image' : 'document'
      setAttachments(prev => [...prev, {
        id: crypto.randomUUID(),
        name: file.name,
        mime_type: file.type || 'application/octet-stream',
        kind,
        data,
        preview: kind === 'image' ? data : null,
      }])
    }
  }

  function removeAttachment(id) {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  async function handleSend() {
    if ((!input.trim() && attachments.length === 0) || sending) return
    const text = input.trim()
    const sentAttachments = attachments
    setInput('')
    setAttachments([])
    setSending(true)

    const convId = activeConvId || crypto.randomUUID()
    if (!activeConvId) setActiveConvId(convId)

    // For temporary chats, send the in-screen history so the CEO has context
    // for the duration of this window only — nothing is persisted server-side.
    const history = temporary
      ? messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, content: m.content }))
      : []

    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      from_agent_id: 'user',
      attachments: sentAttachments.map(a => ({
        id: a.id, name: a.name, mime_type: a.mime_type, kind: a.kind, url: a.preview,
      })),
      created_at: new Date().toISOString(),
    }])

    try {
      const resp = await apiFetch(`${API}/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          message: text,
          is_temporary: temporary,
          history,
          attachments: sentAttachments.map(a => ({
            name: a.name, mime_type: a.mime_type, data: a.data,
          })),
        }),
      })

      setMessages(prev => [...prev, {
        id: resp.id,
        role: 'assistant',
        content: resp.content,
        from_agent_id: resp.from_agent_id,
        action_summaries: resp.action_summaries || [],
        actions: resp.actions || [],
        created_at: new Date().toISOString(),
      }])

      if (!temporary) loadConversations()
    } catch (e) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error: ${e.message}`,
        from_agent_id: 'system',
        created_at: new Date().toISOString(),
      }])
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const isWelcome = messages.length === 0 && !activeConvId

  return (
    <div className="h-full flex">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <button
              onClick={startNewChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              <Plus size={16} /> New Chat
            </button>
          </div>
          <div className="flex items-center gap-3">
            {/* Temporary chat toggle */}
            <button
              onClick={toggleTemporary}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                temporary
                  ? 'text-amber-700 bg-amber-50 border border-amber-200'
                  : 'text-gray-500 hover:bg-gray-50 border border-gray-200'
              }`}
            >
              {temporary
                ? <><ToggleRight size={14} /> Temporary Chat</>
                : <><ToggleLeft size={14} /> Temporary Chat</>
              }
            </button>
            <button
              onClick={() => setShowHistory(h => !h)}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              title={showHistory ? 'Hide history' : 'Show history'}
            >
              {showHistory ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </button>
          </div>
        </div>

        {/* Messages or welcome (with centered input) */}
        <div className="flex-1 overflow-y-auto">
          {isWelcome ? (
            <WelcomeScreen
              orgName={orgName}
              temporary={temporary}
              inputBar={
                <InputBar
                  inputRef={inputRef}
                  input={input}
                  setInput={setInput}
                  handleKeyDown={handleKeyDown}
                  handleSend={handleSend}
                  sending={sending}
                  temporary={temporary}
                  attachments={attachments}
                  addFiles={addFiles}
                  removeAttachment={removeAttachment}
                  centered
                />
              }
            />
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
              {messages.map(msg => (
                <ChatBubble key={msg.id} message={msg} />
              ))}
              {sending && (
                <div className="flex items-center gap-2 text-gray-400 text-sm px-4">
                  <Loader2 size={14} className="animate-spin" />
                  Manager is thinking…
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input bar — only at bottom when conversation is active */}
        {!isWelcome && (
          <div className="border-t border-gray-100 px-4 py-3">
            <InputBar
              inputRef={inputRef}
              input={input}
              setInput={setInput}
              handleKeyDown={handleKeyDown}
              handleSend={handleSend}
              sending={sending}
              temporary={temporary}
              attachments={attachments}
              addFiles={addFiles}
              removeAttachment={removeAttachment}
            />
          </div>
        )}
      </div>

      {/* History sidebar */}
      {showHistory && (
        <div className="w-72 border-l border-gray-100 flex flex-col bg-gray-50/50 shrink-0">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">History</h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Clock size={20} className="mx-auto text-gray-300 mb-2" />
                <p className="text-xs text-gray-400">No conversations yet</p>
              </div>
            ) : (
              <div className="py-1">
                {conversations.map(conv => (
                  <div
                    key={conv.id}
                    onClick={() => openConversation(conv)}
                    className={`group flex items-center gap-2 px-4 py-2.5 cursor-pointer transition-colors ${
                      activeConvId === conv.id
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'hover:bg-gray-100 text-gray-700'
                    }`}
                  >
                    <MessageSquare size={14} className="shrink-0 opacity-40" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{conv.title}</p>
                      <p className="text-[10px] text-gray-400">
                        {new Date(conv.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    <button
                      onClick={e => deleteConversation(conv.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function InputBar({ inputRef, input, setInput, handleKeyDown, handleSend, sending, temporary, centered, attachments = [], addFiles, removeAttachment }) {
  const fileRef = useRef(null)

  function onPaste(e) {
    const files = Array.from(e.clipboardData?.files || [])
    if (files.length && addFiles) { e.preventDefault(); addFiles(files) }
  }

  const canSend = (input.trim() || attachments.length > 0) && !sending

  return (
    <div className={centered ? 'w-full max-w-xl mx-auto' : 'max-w-3xl mx-auto'}>
      <div className={`bg-gray-50 border border-gray-200 rounded-2xl px-4 py-2 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-400 transition-all ${centered ? 'shadow-lg shadow-gray-200/50' : ''}`}>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1 pb-2">
            {attachments.map(a => (
              <div key={a.id} className="relative group">
                {a.kind === 'image' && a.preview ? (
                  <img src={a.preview} alt={a.name} className="h-14 w-14 object-cover rounded-lg border border-gray-200" />
                ) : (
                  <div className="flex items-center gap-1.5 h-14 px-3 rounded-lg border border-gray-200 bg-white max-w-[160px]">
                    <FileText size={16} className="text-gray-400 shrink-0" />
                    <span className="text-xs text-gray-600 truncate">{a.name}</span>
                  </div>
                )}
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="absolute -top-1.5 -right-1.5 bg-gray-700 text-white rounded-full p-0.5 hover:bg-gray-900"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.md,.csv,.json,.docx"
            className="hidden"
            onChange={e => { addFiles && addFiles(e.target.files); e.target.value = '' }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            title="Attach images or files"
            className="p-2 text-gray-400 hover:text-indigo-600 rounded-xl transition-colors shrink-0"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={onPaste}
            placeholder={temporary ? 'Temporary chat — not saved to history' : 'Message Manager…'}
            rows={1}
            className="flex-1 bg-transparent resize-none outline-none text-sm py-1.5 max-h-32 placeholder:text-gray-400"
            style={{ height: 'auto', minHeight: '24px' }}
            onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="p-2 text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:hover:bg-indigo-600 rounded-xl transition-colors shrink-0"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
      {temporary && (
        <p className="text-[10px] text-amber-600 mt-1.5 text-center">
          Temporary mode — this conversation won't be saved
        </p>
      )}
    </div>
  )
}

function WelcomeScreen({ orgName, temporary, inputBar }) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-4">
      <div className="text-center space-y-4 -mt-8 w-full max-w-xl">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto shadow-lg shadow-indigo-200">
          <Sparkles size={28} className="text-white" />
        </div>
        <h1 className="text-3xl font-light text-gray-800">
          What's next{orgName ? `, ${orgName}` : ''}?
        </h1>
        <p className="text-sm text-gray-400 max-w-md mx-auto">
          Chat with your Manager agent. They'll coordinate with your team to get things done.
        </p>
        {temporary && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-full border border-amber-200">
            <ToggleRight size={12} /> Temporary chat enabled
          </div>
        )}
        <div className="pt-4">
          {inputBar}
        </div>
      </div>
    </div>
  )
}

function ActionChip({ summary, action }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-indigo-600 font-medium hover:text-indigo-800 transition-colors cursor-pointer"
      >
        <MarkdownContent text={summary} />
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && action && (
        <pre className="mt-1.5 text-[10px] leading-relaxed text-gray-500 bg-gray-200/60 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap font-mono">
          {JSON.stringify(action, null, 2)}
        </pre>
      )}
    </div>
  )
}

function ChatBubble({ message }) {
  const isUser = message.role === 'user'
  const actions = message.actions || []
  const summaries = message.action_summaries || []
  const attachments = message.attachments || []

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
        isUser
          ? 'bg-indigo-600 text-white rounded-br-md'
          : 'bg-gray-100 text-gray-800 rounded-bl-md'
      }`}>
        {!isUser && (
          <span className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wide block mb-1">Manager</span>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map(a => (
              a.kind === 'image' && a.url ? (
                <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
                  <img src={a.url} alt={a.name} className="h-28 w-28 object-cover rounded-lg border border-black/10" />
                </a>
              ) : (
                <a
                  key={a.id}
                  href={a.url || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg max-w-[180px] ${isUser ? 'bg-indigo-500/40' : 'bg-white border border-gray-200'}`}
                >
                  <FileText size={16} className="shrink-0 opacity-70" />
                  <span className="text-xs truncate">{a.name}</span>
                </a>
              )
            ))}
          </div>
        )}
        {isUser ? (
          message.content ? <div className="whitespace-pre-wrap">{message.content}</div> : null
        ) : (
          <div className="prose-sm">
            <MarkdownContent text={message.content} />
          </div>
        )}
        {/* Action chips — clickable to expand */}
        {summaries.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200/60 space-y-1.5">
            {summaries.map((s, i) => (
              <ActionChip key={i} summary={s} action={actions[i]} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MarkdownContent({ text }) {
  if (!text) return null
  // Simple markdown: **bold**, *italic*, `code`, ### headings, - lists, numbered lists
  const lines = text.split('\n')
  const elements = []
  let inList = false
  let listItems = []

  function flushList() {
    if (listItems.length > 0) {
      elements.push(<ul key={`ul-${elements.length}`} className="list-disc list-inside space-y-0.5 my-1">{listItems}</ul>)
      listItems = []
      inList = false
    }
  }

  lines.forEach((line, i) => {
    // Heading
    if (line.startsWith('### ')) {
      flushList()
      elements.push(<h4 key={i} className="font-semibold text-gray-900 mt-2 mb-0.5">{formatInline(line.slice(4))}</h4>)
    } else if (line.startsWith('## ')) {
      flushList()
      elements.push(<h3 key={i} className="font-bold text-gray-900 mt-2 mb-0.5">{formatInline(line.slice(3))}</h3>)
    } else if (/^[-•]\s/.test(line)) {
      inList = true
      listItems.push(<li key={i} className="text-gray-700">{formatInline(line.replace(/^[-•]\s/, ''))}</li>)
    } else if (/^\d+[.)]\s/.test(line)) {
      flushList()
      if (!inList) { inList = true }
      listItems.push(<li key={i} className="text-gray-700">{formatInline(line.replace(/^\d+[.)]\s/, ''))}</li>)
    } else {
      flushList()
      if (line.trim() === '') {
        elements.push(<div key={i} className="h-2" />)
      } else {
        elements.push(<p key={i} className="text-gray-700">{formatInline(line)}</p>)
      }
    }
  })
  flushList()

  return <>{elements}</>
}

function formatInline(text) {
  // **bold**, *italic*, `code`
  const parts = []
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    if (match[2]) {
      parts.push(<strong key={match.index} className="font-semibold">{match[2]}</strong>)
    } else if (match[3]) {
      parts.push(<em key={match.index}>{match[3]}</em>)
    } else if (match[4]) {
      parts.push(<code key={match.index} className="bg-gray-200/60 px-1 py-0.5 rounded text-xs font-mono">{match[4]}</code>)
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts.length > 0 ? parts : text
}
