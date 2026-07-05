import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
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
import type { IncomingMessage, ServerResponse } from 'http'

/* ---------- PolzaAI Provider ---------- */

const POLZA_API_KEY =
  process.env.POLZA_API_KEY || 'pza_Ff5FZLIFt-eiLw8C9XWJ1MmKDeMk2yuu'

const openai = createOpenAI({
  apiKey: POLZA_API_KEY,
  baseURL: 'https://polza.ai/api/v1',
})

const model = openai.chat('deepseek/deepseek-v4-pro')

/* ---------- Chat File Storage ---------- */

const CHATS_DIR = resolve(process.cwd(), 'chats')

interface ChatData {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: unknown[]
}

function ensureChatsDir() {
  if (!existsSync(CHATS_DIR)) {
    mkdirSync(CHATS_DIR, { recursive: true })
  }
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

/* ---------- HTTP Helpers ---------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => resolve(body))
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

/* ---------- Chat Streaming Handler ---------- */

async function handleChatStream(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req)
  try {
    const { messages } = JSON.parse(body)
    const coreMessages = convertToCoreMessages(messages)

    const result = streamText({
      model,
      messages: coreMessages,
      system:
        'Ты — полезный AI-агент с доступом к инструментам. ' +
        'Отвечай на русском языке. Используй инструменты, когда это необходимо. ' +
        'Объясняй свои действия пользователю. Будь дружелюбным.',
      tools: {
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
      },
      maxSteps: 5,
    })

    result.pipeDataStreamToResponse(res, {
      onError: (error) => {
        console.error('[chat] Stream error:', error)
        return error instanceof Error ? error.message : 'Unknown error'
      },
    })
  } catch (err) {
    console.error('[chat] Handler error:', err)
    sendJson(res, 500, { error: 'Internal Server Error' })
  }
}

/* ---------- CRUD Handlers ---------- */

async function handleListChats(res: ServerResponse) {
  sendJson(res, 200, listChatMetas())
}

async function handleCreateChat(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req)
  const data = body ? JSON.parse(body) : {}
  const chat: ChatData = {
    id: randomUUID(),
    title: data.title || 'Новый чат',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  }
  writeChatFile(chat)
  sendJson(res, 201, {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  })
}

async function handleGetChat(id: string, res: ServerResponse) {
  const chat = readChatFile(id)
  if (!chat) {
    sendJson(res, 404, { error: 'Chat not found' })
    return
  }
  sendJson(res, 200, chat)
}

async function handleUpdateChat(
  id: string,
  req: IncomingMessage,
  res: ServerResponse
) {
  const chat = readChatFile(id)
  if (!chat) {
    sendJson(res, 404, { error: 'Chat not found' })
    return
  }
  const body = await readBody(req)
  const updates = JSON.parse(body)
  if (updates.title !== undefined) chat.title = updates.title
  if (updates.messages !== undefined) chat.messages = updates.messages
  chat.updatedAt = Date.now()
  writeChatFile(chat)
  sendJson(res, 200, {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  })
}

async function handleDeleteChat(id: string, res: ServerResponse) {
  deleteChatFile(id)
  sendJson(res, 200, { ok: true })
}

/* ---------- Vite Plugin ---------- */

function apiPlugin(): Plugin {
  return {
    name: 'chat-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '', 'http://localhost')
        const path = url.pathname

        if (!path.startsWith('/api/')) {
          return next()
        }

        try {
          // /api/chat — streaming
          if (path === '/api/chat' && req.method === 'POST') {
            return handleChatStream(req, res)
          }

          // /api/chats — collection
          if (path === '/api/chats') {
            if (req.method === 'GET') return handleListChats(res)
            if (req.method === 'POST') return handleCreateChat(req, res)
          }

          // /api/chats/:id — single chat
          const match = path.match(/^\/api\/chats\/([^/]+)$/)
          if (match) {
            const id = decodeURIComponent(match[1])
            if (req.method === 'GET') return handleGetChat(id, res)
            if (req.method === 'PATCH') return handleUpdateChat(id, req, res)
            if (req.method === 'DELETE') return handleDeleteChat(id, res)
          }

          return next()
        } catch (err) {
          console.error('[api] Error:', err)
          sendJson(res, 500, { error: 'Internal Server Error' })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
})
