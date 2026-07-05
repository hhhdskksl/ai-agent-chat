import { useChat } from '@ai-sdk/react'
import { useRef, useEffect, useState, type FormEvent } from 'react'

/* ---------- Types ---------- */

interface ChatMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

interface ToolInvocationData {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  state: string
  result?: unknown
}

interface MessageData {
  id: string
  role: string
  content: string
  parts?: Array<{
    type: string
    text?: string
    toolInvocation?: ToolInvocationData
  }>
  toolInvocations?: ToolInvocationData[]
}

/* ---------- API ---------- */

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

/* ---------- Utils ---------- */

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'только что'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} мин`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} ч`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} дн`
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/* ---------- App ---------- */

function App() {
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<ChatMeta[]>('/api/chats')
      .then((data) => setChats(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleNewChat = async () => {
    const chat = await api<ChatMeta>('/api/chats', { method: 'POST' })
    setChats((prev) => [chat, ...prev])
    setActiveChatId(chat.id)
  }

  const handleSelectChat = (id: string) => {
    setActiveChatId(id)
  }

  const handleDeleteChat = async (id: string) => {
    await api(`/api/chats/${id}`, { method: 'DELETE' })
    setChats((prev) => prev.filter((c) => c.id !== id))
    if (activeChatId === id) setActiveChatId(null)
  }

  const handleUpdateChat = (id: string, updates: Partial<ChatMeta>) => {
    setChats((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, ...updates, updatedAt: Date.now() } : c
      )
    )
  }

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <button className="new-chat-btn" onClick={handleNewChat}>
            <span>+</span> Новый чат
          </button>
        </div>

        <div className="sidebar-content">
          {loading ? (
            <div className="sidebar-loading">Загрузка…</div>
          ) : chats.length > 0 ? (
            <div className="chat-list">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className={`chat-item ${activeChatId === chat.id ? 'active' : ''}`}
                  onClick={() => handleSelectChat(chat.id)}
                >
                  <span className="chat-item-icon">💬</span>
                  <div className="chat-item-info">
                    <div className="chat-item-title">{chat.title}</div>
                    <div className="chat-item-time">{relativeTime(chat.updatedAt)}</div>
                  </div>
                  <button
                    className="chat-item-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteChat(chat.id)
                    }}
                    title="Удалить"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="sidebar-empty">Нет сохранённых чатов</div>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-info">
            <p>deepseek-v4-pro · PolzaAI</p>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      <button
        className={`sidebar-toggle ${sidebarOpen ? 'is-open' : 'is-closed'}`}
        onClick={() => setSidebarOpen(!sidebarOpen)}
        title={sidebarOpen ? 'Свернуть панель' : 'Развернуть панель'}
      >
        {sidebarOpen ? '◀' : '▶'}
      </button>

      <main className="main">
        {activeChatId ? (
          <ChatArea
            key={activeChatId}
            chatId={activeChatId}
            onUpdate={handleUpdateChat}
          />
        ) : (
          <WelcomeScreen onNew={handleNewChat} loading={loading} />
        )}
      </main>
    </div>
  )
}

/* ---------- ChatArea ---------- */

function ChatArea({
  chatId,
  onUpdate,
}: {
  chatId: string
  onUpdate: (id: string, updates: Partial<ChatMeta>) => void
}) {
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    status,
    error,
    reload,
    append,
    setMessages,
  } = useChat({
    api: '/api/chat',
    id: chatId,
    onError: (err) => console.error('Chat error:', err),
  })

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const loadedRef = useRef(false)

  // Load messages from server on mount
  useEffect(() => {
    let cancelled = false
    loadedRef.current = false
    api<{ messages?: MessageData[] }>(`/api/chats/${chatId}`)
      .then((data) => {
        if (!cancelled && data.messages && data.messages.length > 0) {
          setMessages(data.messages as any)
        }
        loadedRef.current = true
      })
      .catch(() => {
        loadedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [chatId, setMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Persist messages to server (debounced)
  useEffect(() => {
    if (!loadedRef.current || messages.length === 0) return
    const t = setTimeout(() => {
      const firstUser = messages.find((m) => m.role === 'user')
      const title = firstUser?.content?.substring(0, 50).trim()
      api(`/api/chats/${chatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ messages, ...(title ? { title } : {}) }),
      }).catch(() => {})
      if (title) onUpdate(chatId, { title })
    }, 500)
    return () => clearTimeout(t)
  }, [messages, chatId, onUpdate])

  const isLoading = status === 'submitted' || status === 'streaming'

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!input.trim()) return
    handleSubmit(e)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!input.trim()) return
      handleSubmit(e as unknown as FormEvent<HTMLFormElement>)
    }
  }

  const handlePrompt = (text: string) => {
    append({ role: 'user', content: text })
  }

  return (
    <>
      <div className="chat-container">
        {messages.length === 0 && !isLoading && (
          <PromptGrid onPrompt={handlePrompt} />
        )}

        <div className="messages">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message as MessageData} />
          ))}

          {error && (
            <div className="error-banner">
              <p>Ошибка: {error.message}</p>
              <button onClick={() => reload()}>Повторить</button>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="input-area">
        <form onSubmit={onSubmit} className="input-form">
          <textarea
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Напишите сообщение..."
            rows={1}
            disabled={isLoading}
            className="chat-input"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="send-btn"
            title="Отправить"
          >
            {isLoading ? (
              <span className="spinner" />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22L11 13L2 9L22 2Z" />
              </svg>
            )}
          </button>
        </form>
        <p className="input-hint">AI-агент может искать в интернете, считать, узнавать время</p>
      </div>
    </>
  )
}

/* ---------- Welcome / Prompt Screens ---------- */

function WelcomeScreen({ onNew, loading }: { onNew: () => void; loading: boolean }) {
  return (
    <div className="welcome">
      <div className="welcome-icon">🤖</div>
      <h1 className="welcome-title">AI Агент</h1>
      <p className="welcome-subtitle">
        {loading ? 'Загрузка чатов…' : 'Создайте новый чат, чтобы начать общение'}
      </p>
      {!loading && (
        <button className="welcome-new-btn" onClick={onNew}>
          + Новый чат
        </button>
      )}
    </div>
  )
}

function PromptGrid({ onPrompt }: { onPrompt: (text: string) => void }) {
  const prompts = [
    'Сколько будет 145 * 37 + 892?',
    'Какое сейчас время в Токио?',
    'Найди в интернете новости о квантовых компьютерах',
    'Посчитай сколько дней до 1 января 2027',
  ]

  return (
    <div className="welcome prompt-screen">
      <h1 className="welcome-title">AI Агент</h1>
      <p className="welcome-subtitle">Задайте вопрос — агент использует инструменты для ответа</p>
      <div className="prompt-grid">
        {prompts.map((p) => (
          <button key={p} className="prompt-card" onClick={() => onPrompt(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------- MessageBubble ---------- */

function MessageBubble({ message }: { message: MessageData }) {
  const isUser = message.role === 'user'

  return (
    <div className={`message-row ${isUser ? 'user' : 'assistant'}`}>
      {!isUser && <div className="avatar assistant-avatar">🤖</div>}
      <div className={`message-bubble ${isUser ? 'user-bubble' : 'assistant-bubble'}`}>
        {isUser ? (
          <p className="message-text">{message.content}</p>
        ) : (
          <>
            {message.content && message.content.length > 0 && (
              <div className="message-text">
                <Markdown text={message.content} />
              </div>
            )}
            {message.toolInvocations?.map((ti) => (
              <ToolCard key={ti.toolCallId} invocation={ti} />
            ))}
            {message.parts
              ?.filter((p) => p.type === 'tool-invocation' && p.toolInvocation)
              .map((p) => (
                <ToolCard key={p.toolInvocation!.toolCallId} invocation={p.toolInvocation!} />
              ))}
          </>
        )}
      </div>
      {isUser && <div className="avatar user-avatar">👤</div>}
    </div>
  )
}

/* ---------- ToolCard ---------- */

function ToolCard({ invocation }: { invocation: ToolInvocationData }) {
  const [expanded, setExpanded] = useState(true)
  const isRunning = invocation.state === 'call' || invocation.state === 'partial-call'
  const isDone = invocation.state === 'result'
  const isError = invocation.state === 'error'

  const toolLabel = getToolLabel(invocation.toolName)
  const toolIcon = getToolIcon(invocation.toolName)
  const toolColor = getToolColor(invocation.toolName)

  return (
    <div
      className={`tool-card ${isRunning ? 'tool-running' : ''} ${isDone ? 'tool-done' : ''} ${isError ? 'tool-error' : ''}`}
      style={{ '--tool-color': toolColor } as React.CSSProperties}
    >
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">{toolIcon}</span>
        <span className="tool-name">{toolLabel}</span>
        <span className={`tool-status ${isRunning ? 'status-running' : isDone ? 'status-done' : 'status-error'}`}>
          {isRunning ? '⏳ Выполняется...' : isDone ? '✓ Готово' : '✗ Ошибка'}
        </span>
        <span className="tool-chevron">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="tool-body">
          <div className="tool-section">
            <div className="tool-section-label">Аргументы</div>
            <pre className="tool-json">{JSON.stringify(invocation.args, null, 2)}</pre>
          </div>
          {invocation.result != null && (
            <div className="tool-section">
              <div className="tool-section-label">Результат</div>
              <pre className="tool-json">{JSON.stringify(invocation.result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    getCurrentTime: 'Получение времени',
    calculate: 'Вычисление',
    searchWeb: 'Поиск в интернете',
    readFile: 'Чтение файла',
  }
  return labels[name] || name
}

function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    getCurrentTime: '🕐',
    calculate: '🔢',
    searchWeb: '🌐',
    readFile: '📄',
  }
  return icons[name] || '🔧'
}

function getToolColor(name: string): string {
  const colors: Record<string, string> = {
    getCurrentTime: '#8b5cf6',
    calculate: '#f59e0b',
    searchWeb: '#3b82f6',
    readFile: '#10b981',
  }
  return colors[name] || '#6b7280'
}

function Markdown({ text }: { text: string }) {
  const html = text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>')
    .replace(/\n/g, '<br/>')

  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

export default App
