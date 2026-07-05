import express from 'express'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool, convertToCoreMessages } from 'ai'
import { z } from 'zod'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'

/* ---------- Config ---------- */

const POLZA_API_KEY = process.env.POLZA_API_KEY || 'pza_Ff5FZLIFt-eiLw8C9XWJ1MmKDeMk2yuu'
const PORT = process.env.PORT || 3000
const CHATS_DIR = resolve(process.cwd(), 'chats')
const DIST_DIR = resolve(process.cwd(), 'dist')

const openai = createOpenAI({
  apiKey: POLZA_API_KEY,
  baseURL: 'https://polza.ai/api/v1',
})
const model = openai.chat('deepseek/deepseek-v4-pro')

/* ---------- Chat File Storage ---------- */

interface ChatData {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: unknown[]
}

function ensureChatsDir() {
  if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true })
}

function readChatFile(id: string): ChatData | null {
  try {
    return JSON.parse(readFileSync(join(CHATS_DIR, `${id}.json`), 'utf-8'))
  } catch {
    return null
  }
}

function writeChatFile(data: ChatData) {
  ensureChatsDir()
  writeFileSync(join(CHATS_DIR, `${data.id}.json`), JSON.stringify(data, null, 2))
}

function deleteChatFile(id: string) {
  try {
    unlinkSync(join(CHATS_DIR, `${id}.json`))
  } catch {
    /* ignore */
  }
}

function listChatMetas() {
  ensureChatsDir()
  const files = readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json'))
  const metas = files
    .map((f) => {
      try {
        const data: ChatData = JSON.parse(readFileSync(join(CHATS_DIR, f), 'utf-8'))
        return {
          id: data.id,
          title: data.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean) as Array<{
    id: string
    title: string
    createdAt: number
    updatedAt: number
  }>
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

function sendJson(res: express.Response, status: number, data: unknown) {
  res.status(status).json(data)
}

/* ---------- Tools ---------- */

const tools = {
  getCurrentTime: tool({
    description: 'Получить текущее время и дату в указанном часовом поясе',
    parameters: z.object({
      timezone: z
        .string()
        .optional()
        .describe('Часовой пояс (например Europe/Moscow, Asia/Tokyo)'),
    }),
    execute: async ({ timezone }) => {
      const tz = timezone || 'Europe/Moscow'
      const now = new Date()
      return {
        iso: now.toISOString(),
        formatted: now.toLocaleString('ru-RU', {
          timeZone: tz,
          dateStyle: 'full',
          timeStyle: 'long',
        }),
        timezone: tz,
      }
    },
  }),
  calculate: tool({
    description: 'Вычислить математическое выражение',
    parameters: z.object({
      expression: z.string().describe('Математическое выражение'),
    }),
    execute: async ({ expression }) => {
      const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '')
      let result: number
      try {
        result = Function('"use strict"; return (' + sanitized + ')')()
      } catch {
        return { error: `Не удалось вычислить: ${expression}` }
      }
      return { expression, result }
    },
  }),
  searchWeb: tool({
    description:
      'Поиск актуальной информации в интернете. ' +
      'Возвращает текстовый ответ и ссылки на источники. ' +
      'Используй для новостей, фактов, текущих событий, цен, погоды.',
    parameters: z.object({
      query: z.string().describe('Поисковый запрос на русском или английском'),
    }),
    execute: async ({ query }) => {
      const resp = await fetch('https://polza.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${POLZA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat',
          messages: [
            {
              role: 'user',
              content: `Найди в интернете: ${query}. Дай краткий ответ с фактами.`,
            },
          ],
          stream: false,
          max_tokens: 500,
          plugins: [{ id: 'web', max_results: 5 }],
        }),
      })
      const data = await resp.json()
      const choice = data.choices?.[0]?.message
      const annotations = choice?.annotations || []
      const sources = annotations
        .filter((a: any) => a.type === 'url_citation')
        .map((a: any) => ({
          url: a.url_citation?.url,
          title: a.url_citation?.title,
        }))
      return {
        query,
        answer: choice?.content || 'Ничего не найдено',
        sources,
      }
    },
  }),
  readFile: tool({
    description: 'Прочитать содержимое файла (симуляция)',
    parameters: z.object({
      path: z.string().describe('Путь к файлу'),
    }),
    execute: async ({ path }) => {
      await new Promise((r) => setTimeout(r, 300))
      return {
        path,
        content: `[Демо] Содержимое "${path}" — это симулированный вывод для демонстрации работы агента.`,
        size: 1024,
        lines: 42,
      }
    },
  }),
}

/* ---------- Express App ---------- */

const app = express()
app.use(express.json({ limit: '10mb' }))

// Serve static frontend
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
}

/* ---------- API Routes ---------- */

// Streaming chat
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body
    const coreMessages = convertToCoreMessages(messages)

    const result = streamText({
      model,
      messages: coreMessages,
      system:
        'Ты — полезный AI-агент с доступом к инструментам. ' +
        'Отвечай на русском языке. Используй инструменты, когда это необходимо. ' +
        'Объясняй свои действия пользователю. Будь дружелюбным.',
      tools,
      maxSteps: 5,
    })

    result.pipeDataStreamToResponse(res, {
      onError: (error) => {
        console.error('[chat] Stream error:', error)
        return error instanceof Error ? error.message : 'Unknown error'
      },
    })
  } catch (err) {
    console.error('[chat] Error:', err)
    sendJson(res, 500, { error: 'Internal Server Error' })
  }
})

// List chats
app.get('/api/chats', (_req, res) => {
  sendJson(res, 200, listChatMetas())
})

// Create chat
app.post('/api/chats', (req, res) => {
  const id = randomUUID()
  const now = Date.now()
  const chat: ChatData = {
    id,
    title: req.body?.title || 'Новый чат',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  writeChatFile(chat)
  sendJson(res, 201, {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  })
})

// Get chat by id
app.get('/api/chats/:id', (req, res) => {
  const chat = readChatFile(req.params.id)
  if (!chat) {
    sendJson(res, 404, { error: 'Chat not found' })
    return
  }
  sendJson(res, 200, chat)
})

// Update chat
app.patch('/api/chats/:id', (req, res) => {
  const chat = readChatFile(req.params.id)
  if (!chat) {
    sendJson(res, 404, { error: 'Chat not found' })
    return
  }
  if (req.body.title !== undefined) chat.title = req.body.title
  if (req.body.messages !== undefined) chat.messages = req.body.messages
  chat.updatedAt = Date.now()
  writeChatFile(chat)
  sendJson(res, 200, {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  })
})

// Delete chat
app.delete('/api/chats/:id', (req, res) => {
  deleteChatFile(req.params.id)
  sendJson(res, 200, { ok: true })
})

// SPA fallback — serve index.html for all non-API routes
if (existsSync(DIST_DIR)) {
  app.get('*', (_req, res) => {
    res.sendFile(join(DIST_DIR, 'index.html'))
  })
}

/* ---------- Start ---------- */

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
