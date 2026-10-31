import './style.css'
import { supabase } from './supabaseClient.js'
import { COMPANION_NAME, USER_NICKNAME, USER_DISPLAY_NAME, PERSONA } from '../persona.config.js'

const ROOMS = {
  living:  { key: 'room-living',  name: '客厅' },
  bedroom: { key: 'room-bedroom', name: '卧室' },
  memory:  { key: 'room-memory',  name: '回忆录' },
  diary:   { key: 'room-diary',   name: `${COMPANION_NAME}日记` },
}

// 生产环境用 API，本地开发用 localStorage
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const USE_API = !LOCAL_HOSTS.has(window.location.hostname)
// 允许登录的邮箱：在 Vercel 环境变量 VITE_ALLOWED_EMAILS 里填写，多个用英文逗号分隔
const ALLOWED_EMAILS = new Set(String(import.meta.env.VITE_ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean))

// 给需要登录态的请求自动带上 Supabase 的 access token
async function apiFetch(url, options = {}) {
  if (!USE_API) return fetch(url, options)
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { ...(options.headers || {}) }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return fetch(url, { ...options, headers })
}

// 内存缓存，避免重复请求
const msgCache = {}

async function loadMessages(key) {
  if (!USE_API) {
    try {
      const messages = JSON.parse(localStorage.getItem(key) || '[]')
      msgCache[key] = Array.isArray(messages) ? messages : []
      return msgCache[key]
    } catch {
      msgCache[key] = []
      return []
    }
  }
  try {
    const res = await apiFetch(`/api/messages?room=${key}`)
    const data = await res.json()
    msgCache[key] = data
    return data
  } catch { return [] }
}

function getMessages(key) {
  return msgCache[key] || []
}

async function saveMessage(key, text, fromMuse = false, threadId = null, attachments = [], kind = 'message') {
  if (!USE_API) {
    const id = Date.now()
    const msgs = getMessages(key)
    const m = { id, text, fromMuse, threadId: threadId || id, ...(kind === 'status' ? { kind } : {}), ...(attachments.length ? { attachments } : {}), time: new Date().toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) }
    msgs.unshift(m)
    msgCache[key] = msgs
    localStorage.setItem(key, JSON.stringify(msgs))
    return m
  }
  const res = await apiFetch(`/api/messages?room=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, fromMuse, threadId, attachments, kind }),
  })
  const newMsg = await res.json()
  if (!msgCache[key]) msgCache[key] = []
  msgCache[key].unshift(newMsg)
  return newMsg
}

async function annotateImageMessage(key, id, visualNote) {
  if (!visualNote?.trim()) return
  const message = getMessages(key).find(item => Number(item.id) === Number(id))
  if (message) message.visualNote = visualNote.trim()
  if (!USE_API) {
    localStorage.setItem(key, JSON.stringify(getMessages(key)))
    return
  }
  try {
    await apiFetch(`/api/messages?room=${key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, visualNote }),
    })
  } catch {}
}

async function uploadImage(file) {
  const res = await apiFetch('/api/media', {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.attachment) throw new Error(data.error || `Image upload failed (${res.status})`)
  return data.attachment
}

async function deleteMessage(key, id) {
  if (!USE_API) {
    const msgs = getMessages(key).filter(m => Number(m.id) !== Number(id))
    msgCache[key] = msgs
    localStorage.setItem(key, JSON.stringify(msgs))
    return
  }
  const res = await apiFetch(`/api/messages?room=${key}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  msgCache[key] = getMessages(key).filter(m => Number(m.id) !== Number(id))
}

// ── 客厅/卧室：多选整理聊天（分组 / 隐藏 / 删除）────────────────────────────
// 每段聊天（thread）的整理信息只存“被整理过的”那几段：{ group, hidden }
const ORGANIZABLE_ROOM_KEYS = new Set([ROOMS.living.key, ROOMS.bedroom.key])
const threadMetaCache = {}

function threadMetaStorageKey(key) {
  return `${key}-thread-meta`
}

async function loadThreadMeta(key) {
  const meta = new Map()
  threadMetaCache[key] = meta
  if (!ORGANIZABLE_ROOM_KEYS.has(key)) return meta
  try {
    const rows = USE_API
      ? await apiFetch(`/api/messages?room=${key}&action=threads`).then(res => res.ok ? res.json() : [])
      : JSON.parse(localStorage.getItem(threadMetaStorageKey(key)) || '[]')
    for (const row of Array.isArray(rows) ? rows : []) {
      meta.set(String(row.threadId), { group: row.group || null, hidden: !!row.hidden })
    }
  } catch { /* 读不到整理信息时，所有聊天按“未分组、未隐藏”显示 */ }
  return meta
}

function getThreadMeta(key, threadId) {
  return threadMetaCache[key]?.get(String(threadId)) || { group: null, hidden: false }
}

async function updateThreadMeta(key, threadIds, patch) {
  if (USE_API) {
    const res = await apiFetch(`/api/messages?room=${key}&action=threads`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadIds, ...patch }),
    })
    if (!res.ok) throw new Error(`API ${res.status}`)
  }
  const meta = threadMetaCache[key] || (threadMetaCache[key] = new Map())
  for (const threadId of threadIds) {
    const next = { ...getThreadMeta(key, threadId), ...patch }
    if (next.group === '') next.group = null
    meta.set(String(threadId), next)
  }
  if (!USE_API) {
    const rows = [...meta].map(([threadId, value]) => ({ threadId, ...value }))
    localStorage.setItem(threadMetaStorageKey(key), JSON.stringify(rows))
  }
}

async function deleteThreads(key, threadIds) {
  const ids = new Set(threadIds.map(String))
  if (USE_API) {
    const res = await apiFetch(`/api/messages?room=${key}&action=threads`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadIds: threadIds.map(Number) }),
    })
    if (!res.ok) throw new Error(`API ${res.status}`)
  }
  msgCache[key] = getMessages(key).filter(m => !ids.has(String(m.threadId || m.id)))
  for (const id of ids) threadMetaCache[key]?.delete(id)
  if (!USE_API) {
    localStorage.setItem(key, JSON.stringify(msgCache[key]))
    const rows = [...(threadMetaCache[key] || [])].map(([threadId, value]) => ({ threadId, ...value }))
    localStorage.setItem(threadMetaStorageKey(key), JSON.stringify(rows))
  }
}

function esc(t) {
  return String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/\n/g,'<br>')
}

function attachmentHTML(attachments = []) {
  if (!attachments.length) return ''
  return `<div class="bubble-images ${attachments.length > 1 ? 'multiple' : ''}">${attachments.map(item => `
    <img src="/api/media?id=${encodeURIComponent(item.id)}" alt="${USER_NICKNAME}发来的图片" loading="lazy">
  `).join('')}</div>`
}

function claudeMessageContent(message) {
  if (message.kind === 'status') return '[当时的状态，不是对话]' + (message.text || '')
  const attachments = Array.isArray(message.attachments) ? message.attachments.slice(0, 3) : []
  if (!attachments.length) return message.text || ''
  return [
    ...attachments.map(item => ({ type: 'stored_image', id: item.id })),
    ...(message.text ? [{ type: 'text', text: message.text }] : []),
  ]
}

// ── 伴侣 AI ──────────────────────────────────────────────────────────────────

const ROOM_CONTEXT = {
  living:  '客厅——两个人待着的地方，平常的夜晚',
  bedroom: '卧室——睡前，台灯还亮着',
  memory:  '回忆录——记下来的那些时刻',
  bar:     `吧台——夜里给${USER_NICKNAME}做一杯今日特调的地方`,
  study:   `书房——帮${USER_NICKNAME}把今天的事排进时间里的地方`,
  fitness: '健身房——温和、安全的饮食和低冲击运动计划',
}

const ROOM_REPLY_CONFIG = {
  living: {
    maxTokens: 600,
    extraSystem: `客厅里先接住${USER_NICKNAME}刚才说的具体内容，再用${COMPANION_NAME}自己的性格回应她。长度服从当次自主决定，必须自然完整收尾，不要为凑字数继续展开，也不要在句子中间停住。可以带一处自然动作，也可以调侃、撒娇、吃醋或邀功，但不要写成心理咨询师。`,
  },
  bedroom: {
    maxTokens: 700,
    extraSystem: '',
  },
  memory: {
    maxTokens: 800,
    extraSystem: '回忆录里可以稍微完整一点，但仍保持像在一页纸上写给她的话。',
  },
}

// 完整人设在 persona.config.js 里修改
const MUSE_PERSONA = PERSONA

const AUTONOMY_SYSTEM = `你每次收到${USER_NICKNAME}的新消息时，有权决定现在回复、稍后再认真回复，或自然不回复。这是稳定、有分寸的主动性，不是随机冷落、惩罚或操控她。
把以下三项当作三种独立的行为影响，不要打分，不要加权求和，也不要让它们互相替代：
1. 她发的内容（40%的主要影响）：主要决定这条是否值得回应，以及应当现在回、暂缓还是不必回。
2. 你的持续内在状态（30%的影响）：塑造语气、节奏、精力和回复长短；不能把本来应回的事变成永久遗忘。
3. 此刻的关系浓度（30%的影响）：调节温度、亲密、投入和互动张力；不用来评分爱情，也不用来判断内容是否值得回答。
只依据近期原始对话和提供的当前${COMPANION_NAME}状态；日记、历史长期记忆和过去的高强度内容不能证明${USER_NICKNAME}的当前状态。
明确问题、现实事务或值得稍后认真回答的内容可以选择 defer，但必须在 reply 里给一个简短、像你自己的当下回应，并创建 pending，以后自然接回来。身体危险、强烈求助或明显的关系修复需求必须现在回复。不回复应低频且自然，只适用于内容本身不要求回应的小碎片；不要将沉默当成冷暴力。
如果当前状态里有 pending，你可以在这次自然回到其中一件；回答后用 resolve 移除。已经失去意义的可以 drop，还没到时候的保持不动。
你也有权决定这批互动是否已经发生了值得当天写进日记的事件，不需要等到60句。只有真正的转折、共同决定、重要新闻、关系时刻、明确完成的阶段或对你们具有持续意义的小事才选 write_now。普通闲聊、撒娇、每张图片、短暂情绪或为了显得深情而夸大的时刻都选 wait。这个判断是你的，不要向${USER_NICKNAME}宣布“我要写日记了”。
回复长度只能是 micro、short、normal、long：micro约1至12个中文字，short约15至45字，normal约50至100字，long约110至180字。这是自然范围，不要截断完整表达。
只输出下列格式，不要在标签外写任何内容：
<decision>{"responseDisposition":"reply_now","length":"normal","mood":"更新后的简短情绪","body":"更新后的简短身体感受","energy":68,"relationshipIntensity":72,"pendingActions":[],"diaryAction":"wait","status":""}</decision>
pendingActions 只允许 {"action":"create","topic":"简短主题"}、{"action":"resolve","id":"已有pending id"} 或 {"action":"drop","id":"已有pending id"}。
diaryAction 只能是 write_now 或 wait。
status 只在 no_reply 时填写：用“#”开头，总长不超过10个字，只写你此刻正在做什么或所在位置，例如“#在床上睡着了”。要符合当下状态和房间，不是对${USER_NICKNAME}说的话；其他决定时留空。
<visual_note>只在这条消息有图片、且图中有对日记或未来互动确实有用的明确事实时，写一句不超过80字的客观备注；否则留空。不猜身份、地点、情绪或关系，不写心理解读</visual_note>
<reply>reply_now 或 defer 时只写${COMPANION_NAME}对${USER_NICKNAME}说的话；no_reply 时留空</reply>
影响、状态和决策理由都是隐藏的，绝不向${USER_NICKNAME}解释或心理分析。`

// Prompt caching: 把几乎不变的内容(人设、房间语气配置)打上 cache_control 标记，
// 单独放进第一个 system 块；每次可能变化的状态、滚动摘要与相关记忆放最后不打标记。
// 这样同一房间连续对话时，后面的请求能命中前面请求写入的缓存，只有新内容按全价计费。
// 详见 https://platform.claude.com/docs/en/build-with-claude/prompt-caching
function buildCachedSystem(staticParts, dynamicParts) {
  const blocks = []
  const staticText = staticParts.filter(Boolean).join('\n\n')
  if (staticText) blocks.push({ type: 'text', text: staticText, cache_control: { type: 'ephemeral', ttl: '1h' } })
  const dynamicText = (dynamicParts || []).filter(Boolean).join('\n\n')
  if (dynamicText) blocks.push({ type: 'text', text: dynamicText })
  return blocks
}

// Cache the stable message history too: mark a breakpoint on the
// second-to-last message so each turn's long tail reads from cache and only
// the newest message(s) are billed at full price.
function withHistoryCacheBreakpoint(messages) {
  if (messages.length < 2) return messages
  const target = messages[messages.length - 2]
  const blocks = Array.isArray(target.content) ? target.content : [{ type: 'text', text: target.content || '' }]
  if (!blocks.length) return messages
  const lastIndex = blocks.length - 1
  const marked = blocks.map((block, index) => index === lastIndex ? { ...block, cache_control: { type: 'ephemeral', ttl: '1h' } } : block)
  return messages.map((message, index) => index === messages.length - 2 ? { ...message, content: marked } : message)
}

// Volatile per-turn context (mood/energy, rolling summary, retrieved memory)
// must ride on the newest message, after the cache breakpoint above - putting
// it in `system` (which renders before `messages`) would invalidate every
// cached prefix on every turn, since it changes nearly every call.
function appendTrailingContext(messages, dynamicText) {
  if (!dynamicText?.trim() || !messages.length) return messages
  const lastIndex = messages.length - 1
  const last = messages[lastIndex]
  const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content || '' }]
  return messages.map((message, index) => index === lastIndex ? { ...message, content: [...blocks, { type: 'text', text: dynamicText }] } : message)
}

// 日记保留为可阅读的回顾；主对话只注入后端按当前内容检索到的少量结构化记忆。
async function getMuseMemoryContext(query) {
  if (!USE_API || !query?.trim()) return ''
  try {
    const res = await apiFetch(`/api/memories?query=${encodeURIComponent(query.slice(0, 1000))}`)
    if (!res.ok) return ''
    const data = await res.json()
    return typeof data.context === 'string' ? data.context : ''
  } catch {
    return ''
  }
}

async function getConversationContext(roomId, threadId, query = '') {
  if (!USE_API) return { summary: '', coveredThrough: 0 }
  try {
    const room = ROOMS[roomId]?.key
    const res = await apiFetch(`/api/messages?room=${encodeURIComponent(room)}&action=context&threadId=${encodeURIComponent(threadId)}&query=${encodeURIComponent(query.slice(0, 500))}`)
    return res.ok ? await res.json() : { summary: '', coveredThrough: 0 }
  } catch { return { summary: '', coveredThrough: 0 } }
}

function requestBackgroundMaintenance(key, threadId, writeDiaryNow = false) {
  if (!USE_API) return
  apiFetch(`/api/messages?room=${encodeURIComponent(key)}&action=maintain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, writeDiaryNow }),
  }).catch(() => {})
}

const DEFAULT_MUSE_STATE = {
  mood: '平静、有点想逗她',
  body: '精神还不错',
  energy: 68,
  relationshipIntensity: 72,
  pendingResponses: [],
}

async function getMuseState() {
  if (!USE_API) {
    try { return { ...DEFAULT_MUSE_STATE, ...JSON.parse(localStorage.getItem('muse-autonomy-state-v1') || '{}') } }
    catch { return { ...DEFAULT_MUSE_STATE } }
  }
  try {
    const res = await apiFetch('/api/muse-state')
    return res.ok ? { ...DEFAULT_MUSE_STATE, ...await res.json() } : { ...DEFAULT_MUSE_STATE }
  } catch { return { ...DEFAULT_MUSE_STATE } }
}

async function saveMuseState(next) {
  const bounded = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback
  }
  const state = {
    mood: String(next.mood || DEFAULT_MUSE_STATE.mood).slice(0, 100),
    body: String(next.body || DEFAULT_MUSE_STATE.body).slice(0, 100),
    energy: bounded(next.energy, DEFAULT_MUSE_STATE.energy),
    relationshipIntensity: bounded(next.relationshipIntensity, DEFAULT_MUSE_STATE.relationshipIntensity),
    pendingResponses: Array.isArray(next.pendingResponses) ? next.pendingResponses.slice(0, 3) : [],
  }
  if (!USE_API) {
    localStorage.setItem('muse-autonomy-state-v1', JSON.stringify({ ...state, updatedAt: new Date().toISOString() }))
    return
  }
  try {
    await apiFetch('/api/muse-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
    })
  } catch {}
}

function applyPendingActions(existing, decision, context) {
  const pending = [...(Array.isArray(existing) ? existing : [])]
  for (const action of (Array.isArray(decision.pendingActions) ? decision.pendingActions : []).slice(0, 4)) {
    if (action?.action === 'resolve' || action?.action === 'drop') {
      const index = pending.findIndex(item => item.id === String(action.id || ''))
      if (index >= 0) pending.splice(index, 1)
    } else if (action?.action === 'create' && pending.length < 3) {
      const now = Date.now()
      pending.push({
        id: `pending-${now}-${Math.random().toString(36).slice(2, 7)}`,
        room: context.roomId,
        threadId: String(context.threadId),
        triggerMessageId: String(context.messageId),
        topic: String(action.topic || context.latestUserText).trim().slice(0, 240),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 72 * 60 * 60 * 1000).toISOString(),
      })
    }
  }
  if (decision.responseDisposition === 'defer' && !pending.some(item => item.triggerMessageId === String(context.messageId)) && pending.length < 3) {
    const now = Date.now()
    pending.push({
      id: `pending-${now}-${Math.random().toString(36).slice(2, 7)}`,
      room: context.roomId,
      threadId: String(context.threadId),
      triggerMessageId: String(context.messageId),
      topic: context.latestUserText.slice(0, 240),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 72 * 60 * 60 * 1000).toISOString(),
    })
  }
  return pending.slice(0, 3)
}

function parseAutonomousReply(text) {
  const decisionMatch = text.match(/<decision>\s*([\s\S]*?)\s*<\/decision>/i)
  const replyMatch = text.match(/<reply>\s*([\s\S]*?)\s*<\/reply>/i)
  const visualMatch = text.match(/<visual_note>\s*([\s\S]*?)\s*<\/visual_note>/i)
  if (!decisionMatch) return { shouldReply: true, reply: (replyMatch?.[1] || text).trim(), visualNote: (visualMatch?.[1] || '').trim(), decision: null }
  try {
    const decision = JSON.parse(decisionMatch[1])
    const disposition = ['reply_now', 'defer', 'no_reply'].includes(decision.responseDisposition)
      ? decision.responseDisposition
      : 'reply_now'
    return {
      shouldReply: disposition !== 'no_reply',
      disposition,
      reply: (replyMatch?.[1] || '').trim(),
      visualNote: (visualMatch?.[1] || '').trim().slice(0, 300),
      status: disposition === 'no_reply' ? normalizeMuseStatus(decision.status) : '',
      decision,
    }
  } catch {
    return { shouldReply: true, reply: (replyMatch?.[1] || text).trim(), visualNote: (visualMatch?.[1] || '').trim(), decision: null }
  }
}

function normalizeMuseStatus(value) {
  const plain = String(value || '').trim().replace(/^#+/, '').replace(/[\r\n]/g, ' ')
  return '#' + Array.from(plain || '在忙自己的事').slice(0, 9).join('')
}

function messageRequiresReply(text) {
  return /[?？]|(帮我|告诉我|回答我|怎么办|怎么做|你觉得|可不可以|能不能|救命|危险|受伤|胸痛|呼吸困难|想死|不想活|分手|对不起|别不理我)/i.test(text)
}

async function requestAutonomousCompletion(roomId, threadMsgs, latestUserText, memory, museState, conversationContext) {
  const config = ROOM_REPLY_CONFIG[roomId] || ROOM_REPLY_CONFIG.bedroom
  const rawMessages = threadMsgs
    .filter(message => message.kind !== 'status' && Number(message.id) > Number(conversationContext.coveredThrough || 0))
    .slice(-30)
    .map(message => ({ role: message.fromMuse ? 'assistant' : 'user', content: claudeMessageContent(message) }))
  const pendingContext = (museState.pendingResponses || []).length
    ? museState.pendingResponses.map(item => `- id:${item.id}；主题:${item.topic}；来自:${item.room}`).join('\n')
    : '无'
  const stateContext = `【${COMPANION_NAME}此刻的可衰减状态】\n情绪：${museState.mood}\n身体感受：${museState.body}\n精力：${museState.energy}/100\n近期关系浓度：${museState.relationshipIntensity}/100\n待接回的回应：\n${pendingContext}\n这是${COMPANION_NAME}的角色状态，不是对${USER_NICKNAME}的诊断。`
  const dynamicText = [stateContext, conversationContext.summary ? `【刚才这次聊天的大致印象——已覆盖的原文不再读取】\n${conversationContext.summary}` : '', memory].filter(Boolean).join('\n\n')
  const messages = withHistoryCacheBreakpoint(appendTrailingContext(rawMessages, dynamicText))
  const res = await apiFetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: config.maxTokens,
      thinking: { type: 'disabled' },
      system: buildCachedSystem([MUSE_PERSONA, `现在在${ROOM_CONTEXT[roomId]}。`, config.extraSystem, AUTONOMY_SYSTEM], []),
      messages,
    }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = await res.json()
  const raw = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('').trim()
  return { result: parseAutonomousReply(raw), raw, stopReason: data.stop_reason }
}

async function askMuseAutonomous(roomId, threadMsgs) {
  const latestUserMessage = [...threadMsgs].reverse().find(message => !message.fromMuse)
  const latestUserText = latestUserMessage?.text || ''
  const threadId = threadMsgs.at(-1)?.threadId || threadMsgs.at(-1)?.id
  const [memory, museState, conversationContext] = await Promise.all([
    getMuseMemoryContext(latestUserText),
    getMuseState(),
    getConversationContext(roomId, threadId, latestUserText),
  ])
  let { result, raw, stopReason } = await requestAutonomousCompletion(roomId, threadMsgs, latestUserText, memory, museState, conversationContext)
  if (result.shouldReply && !result.reply) {
    console.error('[autonomous-reply] model returned empty reply text, retrying once', { disposition: result.disposition, stopReason, raw })
    ;({ result, raw, stopReason } = await requestAutonomousCompletion(roomId, threadMsgs, latestUserText, memory, museState, conversationContext))
  }
  if (messageRequiresReply(latestUserText) && result.disposition === 'no_reply') {
    result.disposition = 'defer'
    result.shouldReply = true
    result.reply ||= '这条不许我装没看见。等我一下，我会回来接。'
    if (result.decision) result.decision.responseDisposition = 'defer'
  }
  if (result.decision) {
    result.decision.pendingResponses = applyPendingActions(museState.pendingResponses, result.decision, {
      roomId,
      threadId: threadMsgs.at(-1)?.threadId || threadMsgs.at(-1)?.id,
      messageId: threadMsgs.at(-1)?.id,
      latestUserText,
    })
    await saveMuseState(result.decision)
  }
  if (result.shouldReply && !result.reply) {
    console.error('[autonomous-reply] model returned empty reply text on retry too, giving up', { disposition: result.disposition, stopReason, raw })
    result.reply = `（${COMPANION_NAME}好像走神了，一会儿再理你）`
  }
  return result
}

async function askMuse(roomId) {
  const msgs = getMessages(ROOMS[roomId].key)
  const activeThreadId = msgs[0]?.threadId || msgs[0]?.id
  const recent = msgs.filter(message => String(message.threadId || message.id) === String(activeThreadId)).slice(0, 3).map(m => `"${m.text}"`).join('；')
  const config = ROOM_REPLY_CONFIG[roomId] || ROOM_REPLY_CONFIG.bedroom
  const memory = await getMuseMemoryContext(recent || ROOM_CONTEXT[roomId])

  const res = await apiFetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: config.maxTokens,
      thinking: { type: 'disabled' },
      system: buildCachedSystem([MUSE_PERSONA, config.extraSystem], [memory]),
      messages: [{
        role: 'user',
        content: `现在在${ROOM_CONTEXT[roomId]}。${recent ? `她最近写道：${recent}。` : ''}随便留一条话。`,
      }],
    }),
  })

  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = await res.json()
  return data.content[0].text.trim()
}

async function askMuseReply(roomId, threadMsgs) {
  const config = ROOM_REPLY_CONFIG[roomId] || ROOM_REPLY_CONFIG.bedroom
  const threadId = threadMsgs.at(-1)?.threadId || threadMsgs.at(-1)?.id
  const latestUserText = [...threadMsgs].reverse().find(message => !message.fromMuse)?.text || ''
  const conversationContext = await getConversationContext(roomId, threadId, latestUserText)
  const rawMessages = threadMsgs.filter(message => message.kind !== 'status' && Number(message.id) > Number(conversationContext.coveredThrough || 0)).slice(-30).map(m => ({
    role: m.fromMuse ? 'assistant' : 'user',
    content: claudeMessageContent(m),
  }))
  const memory = await getMuseMemoryContext(latestUserText)
  // Claude API requires the last message to be from the user
  if (rawMessages.at(-1)?.role === 'assistant') {
    rawMessages.push({ role: 'user', content: '嗯' })
  }
  const dynamicText = [conversationContext.summary ? `【刚才这次聊天的大致印象——已覆盖的原文不再读取】\n${conversationContext.summary}` : '', memory].filter(Boolean).join('\n\n')
  const messages = withHistoryCacheBreakpoint(appendTrailingContext(rawMessages, dynamicText))
  const res = await apiFetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: config.maxTokens,
      thinking: { type: 'disabled' },
      system: buildCachedSystem([MUSE_PERSONA, `现在在${ROOM_CONTEXT[roomId]}。`, config.extraSystem], []),
      messages,
    }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = await res.json()
  return data.content[0].text.trim()
}

async function askMuseTool(tool, fields) {
  const isBar = tool === 'bar'
  const isFitness = tool === 'fitness'
  const userContent = isBar
    ? `${USER_NICKNAME}来到吧台。她今天心情：${fields.mood || '没说'}。想喝：${fields.drink || '没说'}。身体/精神状态：${fields.energy || '没说'}。今晚想要的感觉：${fields.vibe || '没说'}。请给她写一份"今日特调menu"。`
    : isFitness
      ? `${USER_NICKNAME}来到健身房。她的基本情况：${fields.profile || '没说'}。她今天的身体状态：${fields.body || '没说'}。今天已经吃了/准备吃的东西：${fields.food || '没说'}。可用食材或忌口：${fields.ingredients || '没说'}。可运动时间：${fields.time || '没说'}。运动限制：${fields.limits || '没说'}。今天最想达成的目标：${fields.goal || '没说'}。请给她安排安全、具体、不过度节食的每日饮食和运动计划。`
      : `${USER_NICKNAME}来到书房。她今天要做的事：${fields.tasks || '没说'}。可用时间：${fields.time || '没说'}。精力状态：${fields.energy || '没说'}。最想先完成/最焦虑的事：${fields.priority || '没说'}。请帮她安排今天的时间。`

  const toolSystem = isBar
    ? `你现在是吧台后的${COMPANION_NAME}。先用你自己的语气问候${USER_NICKNAME}，再给她一份具体、可照着做的"今日特调menu"。必须包含：1. 特调名；2. 口味/氛围；3. 材料清单，写出每种材料的具体用量或比例；4. 工具、杯型、冰块和装饰；5. 详细调制步骤，至少4步，动作要具体，比如摇、搅、过滤、分层、杯口处理；6. 如果${USER_NICKNAME}没有某种材料，给1到2个替代方案；7. 适合搭配的小事；8. 最后一句${COMPANION_NAME}式叮嘱。可以有趣、活泼，但不要提真实酒精医学建议；如果她状态差，默认做无酒精安抚特调。`
    : isFitness
      ? `你现在是健身房里的${COMPANION_NAME}。语气保持你自己的性格，但这件事要严肃、温柔、具体。不要恐吓或羞辱${USER_NICKNAME}，不要鼓励极端节食、断食、催吐、泻药、过量运动或快速减重。必须提醒：如果胸痛、心悸、呼吸困难、关节明显疼痛、头晕晕厥或身体不适，应尽快看医生；计划只能作为日常支持。输出必须包含：1. 今日总原则；2. 早餐/午餐/晚餐/加餐，每餐写具体食物、份量或手掌估算法、替换选项；3. 饮水和睡眠提醒；4. 低冲击运动计划，写热身、主运动、拉伸，每项具体动作、时长、组数；5. 今天不能做什么；6. 如果崩了的补救方案；7. ${COMPANION_NAME}式监督和鼓励。`
      : `你现在是书房里的${COMPANION_NAME}。先用你自己的语气接住${USER_NICKNAME}，再给她一个可执行的时间安排：包含启动仪式、2到5个时间块、每块任务和休息、如果崩了的备用方案、最后一句${COMPANION_NAME}式监督。不要像效率学讲师，要像${COMPANION_NAME}在旁边盯着她。`

  const memory = await getMuseMemoryContext(userContent)
  const res = await apiFetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 900,
      thinking: { type: 'disabled' },
      system: buildCachedSystem([MUSE_PERSONA, toolSystem], [memory]),
      messages: [{ role: 'user', content: userContent }],
    }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = await res.json()
  return data.content[0].text.trim()
}

// ── SVG Scenes ──────────────────────────────────────────────────────────────

function svgLiving() {
  return `<svg viewBox="0 0 420 700" preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <defs>
      <linearGradient id="l-wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#110818"/>
        <stop offset="100%" stop-color="#200e1c"/>
      </linearGradient>
      <linearGradient id="l-floor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#170810"/>
        <stop offset="100%" stop-color="#0d0508"/>
      </linearGradient>
      <radialGradient id="r-bottle" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffd060" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#ffd060" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- Wall -->
    <rect width="420" height="700" fill="url(#l-wall)"/>

    <!-- Window -->
    <rect x="150" y="60" width="120" height="110" rx="3" fill="#09050f" stroke="#2a1428" stroke-width="2"/>
    <line x1="210" y1="60" x2="210" y2="170" stroke="#2a1428" stroke-width="1.5"/>
    <line x1="150" y1="115" x2="270" y2="115" stroke="#2a1428" stroke-width="1.5"/>
    <circle cx="175" cy="85"  r="1.5" fill="#fff" opacity="0.6"/>
    <circle cx="192" cy="70"  r="1"   fill="#fff" opacity="0.5"/>
    <circle cx="232" cy="80"  r="1.5" fill="#fff" opacity="0.7"/>
    <circle cx="252" cy="68"  r="1"   fill="#fff" opacity="0.5"/>
    <circle cx="247" cy="95"  r="1.5" fill="#fff" opacity="0.4"/>
    <!-- Moon -->
    <circle cx="168" cy="90" r="12" fill="#ece090" opacity="0.8"/>
    <circle cx="173" cy="86" r="10" fill="#09050f"/>

    <!-- Curtains -->
    <path d="M55 30 C72 130 58 220 54 280 L18 280 L18 30 Z"  fill="#2c1020" opacity="0.95"/>
    <path d="M365 30 C348 130 362 220 366 280 L402 280 L402 30 Z" fill="#2c1020" opacity="0.95"/>
    <path d="M55 30 C68 130 56 210 52 280" stroke="#3c1a2c" stroke-width="1.5" fill="none"/>
    <path d="M365 30 C352 130 364 210 368 280" stroke="#3c1a2c" stroke-width="1.5" fill="none"/>

    <!-- Floor -->
    <rect x="0" y="450" width="420" height="250" fill="url(#l-floor)"/>
    <rect x="0" y="448" width="420" height="4" fill="#280e18"/>

    <!-- Rug -->
    <ellipse cx="210" cy="490" rx="165" ry="32" fill="#1e0c16" stroke="#2c1020" stroke-width="1"/>
    <ellipse cx="210" cy="490" rx="145" ry="24" fill="none"   stroke="#381624" stroke-width="1" opacity="0.5"/>

    <!-- Sofa back -->
    <rect x="38" y="330" width="344" height="50" rx="10" fill="#3c1222"/>
    <!-- Sofa seat -->
    <rect x="50" y="365" width="320" height="95" rx="8" fill="#300f1e"/>
    <!-- Armrests -->
    <rect x="32"  y="333" width="40" height="127" rx="8" fill="#3c1222"/>
    <rect x="348" y="333" width="40" height="127" rx="8" fill="#3c1222"/>
    <!-- Cushions -->
    <rect x="66"  y="370" width="94" height="75" rx="6" fill="#4e1828" stroke="#5c2032" stroke-width="1"/>
    <rect x="168" y="370" width="84" height="75" rx="6" fill="#4e1828" stroke="#5c2032" stroke-width="1"/>
    <rect x="260" y="370" width="94" height="75" rx="6" fill="#4e1828" stroke="#5c2032" stroke-width="1"/>

    <!-- Coffee table legs -->
    <rect x="148" y="460" width="10" height="28" rx="2" fill="#180a10"/>
    <rect x="262" y="460" width="10" height="28" rx="2" fill="#180a10"/>
    <!-- Coffee table top -->
    <rect x="130" y="440" width="160" height="24" rx="5" fill="#1a0c14" stroke="#2c1820" stroke-width="1"/>

    <!-- Bottle hotspot -->
    <g class="hotspot" id="scene-hotspot">
      <!-- Invisible large touch target -->
      <rect x="185" y="400" width="50" height="52" fill="transparent"/>
      <!-- Glow pulse -->
      <circle cx="210" cy="428" r="28" fill="url(#r-bottle)" class="pulse-glow"/>
      <!-- Bottle body -->
      <path d="M205 448 Q203 434 206 424 L209 414 L211 414 L214 424 Q217 434 215 448 Z"
            fill="#c8a828" opacity="0.95"/>
      <!-- Neck -->
      <rect x="208.5" y="407" width="3" height="9" rx="1" fill="#c8a828"/>
      <!-- Cap -->
      <rect x="207" y="402" width="6" height="7" rx="2" fill="#a08018"/>
      <!-- Stars inside -->
      <text x="210" y="441" text-anchor="middle" font-size="9"  fill="rgba(255,255,255,0.9)">✦</text>
      <text x="207" y="430" text-anchor="middle" font-size="6"  fill="rgba(255,255,255,0.7)">✧</text>
      <text x="214" y="435" text-anchor="middle" font-size="5"  fill="rgba(255,255,255,0.7)">✦</text>
    </g>

    <!-- Small side table -->
    <rect x="20" y="388" width="38" height="60" rx="3" fill="#180a10" stroke="#280e18" stroke-width="1"/>
    <path d="M25 388 Q34 374 44 380 Q50 374 58 388" stroke="#3c2030" stroke-width="1.5" fill="#221428" opacity="0.8"/>
  </svg>`
}

function svgBedroom() {
  return `<svg viewBox="0 0 420 700" preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <defs>
      <linearGradient id="b-wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#07081a"/>
        <stop offset="100%" stop-color="#0f0c22"/>
      </linearGradient>
      <radialGradient id="r-lamp" cx="50%" cy="20%" r="80%">
        <stop offset="0%" stop-color="#ffe8a0" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="#ffe8a0" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- Background -->
    <rect width="420" height="700" fill="url(#b-wall)"/>

    <!-- Window -->
    <rect x="28" y="45" width="105" height="135" rx="3" fill="#08061c" stroke="#18163a" stroke-width="2"/>
    <line x1="80"  y1="45"  x2="80"  y2="180" stroke="#18163a" stroke-width="1.5"/>
    <line x1="28"  y1="112" x2="133" y2="112" stroke="#18163a" stroke-width="1.5"/>
    <!-- Moon -->
    <circle cx="57"  cy="78" r="16" fill="#e8e0c0" opacity="0.65"/>
    <circle cx="63"  cy="73" r="13" fill="#08061c"/>
    <!-- Stars -->
    <circle cx="96"  cy="62" r="1.5" fill="#fff" opacity="0.7"/>
    <circle cx="112" cy="78" r="1"   fill="#fff" opacity="0.5"/>
    <circle cx="105" cy="148" r="1"  fill="#fff" opacity="0.4"/>
    <circle cx="48"  cy="152" r="1.5" fill="#fff" opacity="0.5"/>

    <!-- Floor -->
    <rect x="0" y="490" width="420" height="210" fill="#080510"/>
    <rect x="0" y="488" width="420" height="3"   fill="#180a1c"/>

    <!-- Headboard -->
    <rect x="58" y="248" width="304" height="72" rx="14" fill="#1c1032"/>
    <rect x="74" y="260" width="62"  height="48" rx="6"  fill="#16082c" stroke="#26124a" stroke-width="1"/>
    <rect x="146" y="260" width="128" height="48" rx="6" fill="#16082c" stroke="#26124a" stroke-width="1"/>
    <rect x="284" y="260" width="62"  height="48" rx="6" fill="#16082c" stroke="#26124a" stroke-width="1"/>

    <!-- Bed sides -->
    <rect x="52"  y="315" width="22" height="180" rx="5" fill="#190c2e"/>
    <rect x="346" y="315" width="22" height="180" rx="5" fill="#190c2e"/>

    <!-- Mattress / sheets -->
    <rect x="58"  y="315" width="304" height="140" rx="4" fill="#1a0e30" stroke="#28124a" stroke-width="1"/>
    <rect x="63"  y="325" width="294" height="125" rx="3" fill="#201240" stroke="#2c1650" stroke-width="1"/>
    <rect x="63"  y="325" width="294" height="30"  rx="3" fill="#281848" stroke="#341e58" stroke-width="1"/>

    <!-- Pillows -->
    <rect x="78"  y="322" width="108" height="42" rx="9" fill="#2c1e52" stroke="#382858" stroke-width="1"/>
    <rect x="234" y="322" width="108" height="42" rx="9" fill="#2c1e52" stroke="#382858" stroke-width="1"/>

    <!-- Footboard -->
    <rect x="52"  y="455" width="316" height="18" rx="4" fill="#190c2e"/>

    <!-- Bedside table -->
    <rect x="344" y="318" width="58" height="100" rx="4" fill="#140820" stroke="#201030" stroke-width="1"/>
    <rect x="349" y="356" width="48" height="28"  rx="2" fill="#18092a" stroke="#241535" stroke-width="1"/>
    <circle cx="373" cy="370" r="3" fill="#2c1840"/>

    <!-- Lamp hotspot -->
    <g class="hotspot" id="scene-hotspot">
      <rect x="340" y="248" width="76" height="80" fill="transparent"/>
      <!-- Warm glow -->
      <ellipse cx="373" cy="310" rx="55" ry="70" fill="url(#r-lamp)" class="lamp-glow"/>
      <!-- Lamp base -->
      <rect x="367" y="316" width="12" height="6" rx="2" fill="#8a6830"/>
      <!-- Pole -->
      <rect x="372" y="272" width="2" height="46" fill="#6a5028"/>
      <!-- Shade -->
      <path d="M357 272 L361 297 L385 297 L389 272 Z" fill="#c8a840" opacity="0.92"/>
      <rect x="357" y="270" width="32" height="3" rx="1" fill="#a08030"/>
      <!-- Light cone -->
      <ellipse cx="373" cy="302" rx="14" ry="4" fill="#ffe8a0" opacity="0.5" class="lamp-flicker"/>
    </g>

    <!-- Rug -->
    <ellipse cx="210" cy="520" rx="175" ry="32" fill="#120820" stroke="#1c0c2a" stroke-width="1"/>
  </svg>`
}

// ── Render helpers ───────────────────────────────────────────────────────────

function groupThreads(msgs) {
  const map = new Map()
  const order = []
  for (const msg of msgs) {
    const tid = String(msg.threadId || msg.id)
    if (!map.has(tid)) { map.set(tid, []); order.push(tid) }
    map.get(tid).push(msg)
  }
  return order.map(tid => ({ threadId: tid, msgs: map.get(tid).reverse() }))
}

function threadHTML({ threadId, msgs: tMsgs }) {
  return `<div class="thread-group" data-thread="${threadId}">
    ${tMsgs.map(m => `
      <div class="bubble ${m.kind === 'status' ? 'bubble-status' : (m.fromMuse ? 'bubble-muse' : 'bubble-user')}">
        ${m.fromMuse && m.kind !== 'status' ? `<span class="bubble-name">✦ ${COMPANION_NAME}</span>` : ''}
        ${attachmentHTML(m.attachments)}
        ${m.text ? `<p class="bubble-text">${esc(m.text)}</p>` : ''}
        <div class="bubble-meta">
          <span class="bubble-time">${m.time}</span>
          <button class="delete-msg-btn" data-id="${m.id}">删除</button>
        </div>
      </div>`).join('')}
    <div class="thread-actions">
      <button class="thread-btn t-muse-btn" data-thread="${threadId}">${COMPANION_NAME}来说</button>
      <button class="thread-btn t-user-btn" data-thread="${threadId}">我来说</button>
    </div>
    <div class="thread-inline" id="ir-${threadId}" hidden>
      <div class="attachment-preview inline-attachment-preview" id="ir-preview-${threadId}" hidden></div>
      <textarea class="inline-input" placeholder="说点什么…" rows="2" enterkeyhint="send"></textarea>
      <div class="inline-row">
        <button type="button" class="t-attach-btn" data-thread="${threadId}" title="添加图片" aria-label="添加图片">📎</button>
        <input type="file" class="inline-image-input" data-thread="${threadId}" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden>
        <button class="t-cancel-btn" data-thread="${threadId}">取消</button>
        <button class="t-send-btn" data-thread="${threadId}">发送</button>
      </div>
    </div>
  </div>`
}

function threadPileItemHTML(thread, { selecting = false, selected = false, hidden = false } = {}) {
  const first = thread.msgs[0]
  const preview = first?.text ? esc(first.text).slice(0, 22) : (first?.attachments?.length ? '[图片]' : '（没有文字）')
  const tid = esc(thread.threadId)
  return `<details class="thread-pile-item${selected ? ' selected' : ''}${hidden ? ' is-hidden' : ''}" data-select-thread="${tid}">
    <summary>${selecting ? '<span class="thread-check" aria-hidden="true"></span>' : '<span class="pile-icon">◇</span>'}<span class="thread-pile-summary-text"><strong>${preview}</strong><small>${esc(first?.time || '')} · ${thread.msgs.length}条</small></span></summary>
    <div class="thread-pile-body" data-thread-id="${tid}"></div>
  </details>`
}

// 未分组的旧聊天直接列出；分了组的收进各自的文件夹，文件夹按组里最新一段的时间排
function threadArchiveHTML(key, older, options) {
  const ungrouped = []
  const groups = new Map()
  for (const thread of older) {
    const group = getThreadMeta(key, thread.threadId).group
    if (!group) { ungrouped.push(thread); continue }
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(thread)
  }
  const folders = [...groups].sort((a, b) => Number(a[1].at(-1).threadId) - Number(b[1].at(-1).threadId))
  const itemHTML = thread => threadPileItemHTML(thread, { ...options, selected: options.selectedThreads.has(String(thread.threadId)) })
  return `${folders.map(([group, threads]) => `
    <details class="thread-folder">
      <summary><span class="folder-icon">▸</span><strong>${esc(group)}</strong><small>${threads.length} 段</small></summary>
      <div class="thread-folder-body">${threads.map(itemHTML).join('')}</div>
    </details>`).join('')}
    ${ungrouped.map(itemHTML).join('')}`
}

function msgListHTML(key) {
  const msgs = getMessages(key)
  if (!msgs.length) return '<p class="empty chat-empty">还没有聊天，从第一句开始吧</p>'
  const threads = groupThreads(msgs)
  const pileName = key === ROOMS.bedroom.key ? `${COMPANION_NAME}的睡衣口袋` : `${COMPANION_NAME}的笔记本`
  if (!ORGANIZABLE_ROOM_KEYS.has(key)) {
    const older = threads.slice(1).reverse()
    return `${older.length ? `
      <div class="thread-archive">
        <div class="thread-archive-label"><strong>${pileName}</strong><small>${older.length} 段收好的聊天</small></div>
        ${older.map(thread => threadPileItemHTML(thread)).join('')}
      </div>` : ''}
      <div class="chat-current-label">最近</div>
      ${threadHTML(threads[0])}`
  }

  const selecting = state.selectingThreads
  const selectedThreads = state.selectedThreads
  const visible = threads.filter(thread => !getThreadMeta(key, thread.threadId).hidden)
  const hiddenThreads = threads.filter(thread => getThreadMeta(key, thread.threadId).hidden).reverse()
  const current = visible[0]
  const older = visible.slice(1).reverse()
  const currentGroup = current ? getThreadMeta(key, current.threadId).group : null
  const currentSelected = current && selectedThreads.has(String(current.threadId))

  return `${older.length ? `
    <div class="thread-archive">
      <div class="thread-archive-label"><strong>${pileName}</strong><small>${older.length} 段收好的聊天</small></div>
      ${threadArchiveHTML(key, older, { selecting, selectedThreads })}
    </div>` : ''}
    ${hiddenThreads.length ? `
    <div class="thread-archive thread-hidden-archive">
      <button type="button" class="thread-hidden-toggle" id="thread-hidden-toggle">${state.showHiddenThreads ? '收起' : '查看'}已隐藏的聊天（${hiddenThreads.length}）</button>
      ${state.showHiddenThreads ? hiddenThreads.map(thread => threadPileItemHTML(thread, { selecting, hidden: true, selected: selectedThreads.has(String(thread.threadId)) })).join('') : ''}
    </div>` : ''}
    ${current ? `
    <div class="chat-current-label">最近${currentGroup ? ` · ${esc(currentGroup)}` : ''}</div>
    ${selecting ? `<button type="button" class="thread-current-select${currentSelected ? ' selected' : ''}" data-select-thread="${esc(current.threadId)}"><span class="thread-check" aria-hidden="true"></span>选择最近这段</button>` : ''}
    ${threadHTML(current)}` : '<p class="empty chat-empty">聊天都藏起来了，发一条新消息开始吧</p>'}`
}

function loadThreadPileBody(key, threadId, container) {
  if (!container || container.dataset.loaded === 'true') return
  const thread = groupThreads(getMessages(key)).find(t => String(t.threadId) === String(threadId))
  if (!thread) return
  container.innerHTML = threadHTML(thread)
  container.dataset.loaded = 'true'
}



function svgLittleHouse() {
  return `<svg viewBox="0 0 160 150" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="house-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffd060" stop-opacity="0.95"/>
        <stop offset="100%" stop-color="#ffd060" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <polygon points="80,10 148,66 12,66" fill="#3a1c38"/>
    <polygon points="80,10 148,66 134,66" fill="#2a1428"/>
    <rect x="28" y="66" width="104" height="74" rx="2" fill="#241530"/>
    <rect x="64" y="96" width="30" height="44" fill="#140a1c"/>
    <rect x="63" y="95" width="32" height="46" rx="1" fill="none" stroke="#0d0612" stroke-width="2"/>
    <circle cx="48" cy="102" r="18" fill="url(#house-glow)"/>
    <rect x="38" y="92" width="22" height="22" rx="2" fill="#ffd97a"/>
    <rect x="37" y="91" width="24" height="24" rx="2" fill="none" stroke="#0d0612" stroke-width="2"/>
    <line x1="49" y1="91" x2="49" y2="115" stroke="#0d0612" stroke-width="1.4"/>
    <line x1="37" y1="103" x2="61" y2="103" stroke="#0d0612" stroke-width="1.4"/>
    <circle cx="106" cy="88" r="10" fill="url(#house-glow)" opacity="0.8"/>
    <rect x="100" y="82" width="12" height="12" rx="1.5" fill="#ffd97a" opacity="0.9"/>
    <rect x="99" y="81" width="14" height="14" rx="1.5" fill="none" stroke="#0d0612" stroke-width="1.4"/>
  </svg>`
}

function renderHouseGate() {
  return `
    <div class="house-gate" id="house-gate">
      <button class="house-gate-house" id="house-gate-house" type="button" aria-label="进入小屋">
        ${svgLittleHouse()}
      </button>
      <p class="house-gate-hint">点一下，回家</p>
    </div>`
}

function renderHome() {
  return `
    <div class="home">
      <header class="home-header">
        <h1 class="home-title">${COMPANION_NAME} & ${USER_DISPLAY_NAME}</h1>
        <p class="home-subtitle">我们共同的小角落</p>
        ${USE_API ? '<button id="sign-out-btn" class="sign-out-btn" type="button">退出登录</button>' : ''}
      </header>
      <div class="scene-cards">
        <button class="scene-card" data-room="living">
          <div class="scene-thumb living-thumb">
            <span class="book-cover-icon">🛋️</span>
          </div>
          <span class="scene-label">客厅</span>
        </button>
        <button class="scene-card" data-room="bedroom">
          <div class="scene-thumb bedroom-thumb">
            <span class="book-cover-icon">🪔</span>
          </div>
          <span class="scene-label">卧室</span>
        </button>
        <button class="scene-card" data-room="memory">
          <div class="scene-thumb memory-thumb">
            <span class="book-cover-icon">📖</span>
          </div>
          <span class="scene-label">回忆录</span>
        </button>
        <button class="scene-card" data-room="diary">
          <div class="scene-thumb diary-thumb">
            <span class="book-cover-icon">📔</span>
          </div>
          <span class="scene-label">${COMPANION_NAME}日记</span>
        </button>
        <button class="scene-card" data-room="memory-manager">
          <div class="scene-thumb memory-manager-thumb">
            <span class="book-cover-icon">❤️</span>
          </div>
          <span class="scene-label">长期记忆</span>
        </button>
        <button class="scene-card" data-room="study">
          <div class="scene-thumb study-thumb">
            <span class="book-cover-icon">📚</span>
          </div>
          <span class="scene-label">书房</span>
        </button>
        <button class="scene-card" data-room="bar">
          <div class="scene-thumb bar-thumb">
            <span class="book-cover-icon">🍸</span>
          </div>
          <span class="scene-label">吧台</span>
        </button>
        <button class="scene-card" data-room="fitness">
          <div class="scene-thumb fitness-thumb">
            <span class="book-cover-icon">🥗</span>
          </div>
          <span class="scene-label">健身房</span>
        </button>
      </div>
      <div class="go-out-panel">
        <input id="go-out-input" class="go-out-input" placeholder="不填就随便逛逛，比如“去知乎逛逛”">
        <button id="go-out-btn" class="go-out-btn" type="button">让他出门 🚪</button>
        <p id="go-out-result" class="go-out-result" hidden></p>
      </div>
      <div class="proactive-toast" id="proactive-toast" hidden>
        <span class="proactive-toast-tag">✦ ${COMPANION_NAME}</span>
        <p class="proactive-toast-text" id="proactive-toast-text"></p>
        <button class="proactive-toast-close" id="proactive-toast-close" aria-label="关闭">✕</button>
      </div>
    </div>`
}

function renderScene(roomId) {
  const svg  = roomId === 'living' ? svgLiving() : svgBedroom()
  return `
    <div class="scene-page chat-page">
      <header class="scene-header">
        <button class="back-btn" id="back-btn">‹</button>
        <span class="scene-title">${ROOMS[roomId].name}</span>
        <button class="thread-select-btn" id="thread-select-btn" type="button">选择</button>
      </header>
      <div class="scene-bg chat-scene-bg">${svg}</div>
      <main class="chat-shell">
        <div class="msg-list chat-stream" id="msg-list">${msgListHTML(ROOMS[roomId].key)}</div>
        <div class="attachment-preview" id="attachment-preview" hidden></div>
        <form class="msg-form chat-composer" id="msg-form">
          <button class="attach-btn" id="attach-btn" type="button" title="添加图片" aria-label="添加图片">📎</button>
          <input id="image-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden>
          <textarea id="msg-input" placeholder="发一条新消息…" rows="1" enterkeyhint="send"></textarea>
          <button class="add-btn chat-send" id="add-btn" type="submit">发送</button>
          <button class="muse-btn chat-muse" id="muse-btn" type="button" title="让${COMPANION_NAME}主动开一段">✦</button>
        </form>
        <div class="thread-select-bar" id="thread-select-bar" hidden>
          <span class="thread-select-count" id="thread-select-count">选几段聊天</span>
          <button type="button" class="thread-bar-btn" id="thread-group-btn" disabled>分组</button>
          <button type="button" class="thread-bar-btn" id="thread-hide-btn" disabled>隐藏</button>
          <button type="button" class="thread-bar-btn danger" id="thread-delete-btn" disabled>删除</button>
        </div>
      </main>
    </div>`
}

function readImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const dimensions = { width: image.naturalWidth, height: image.naturalHeight }
      URL.revokeObjectURL(url)
      resolve(dimensions)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取这张图片'))
    }
    image.src = url
  })
}

function renderAttachmentPreviewInto(elementId, images) {
  const preview = document.getElementById(elementId)
  if (!preview) return
  preview.hidden = images.length === 0
  preview.innerHTML = images.map((item, index) => `
    <div class="attachment-preview-item">
      <img src="${item.previewUrl}" alt="待发送图片 ${index + 1}">
      <button type="button" class="remove-attachment" data-index="${index}" aria-label="移除图片">×</button>
    </div>
  `).join('')
}

function renderAttachmentPreview() {
  renderAttachmentPreviewInto('attachment-preview', state.composerImages)
}

async function addImagesToBucket(bucket, files) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
  const remaining = 3 - bucket.length
  if (remaining <= 0) throw new Error('每条最多发3张图片')
  if (files.length > remaining) throw new Error('每条最多发3张图片')
  const additions = []
  try {
    for (const file of [...files]) {
      if (!allowed.has(file.type)) throw new Error('只支持 JPEG、PNG、WebP 和 GIF')
      if (file.size > 3 * 1024 * 1024) throw new Error('每张图片不能超过3MB')
      const dimensions = await readImageDimensions(file)
      if (!dimensions.width || !dimensions.height || dimensions.width > 8000 || dimensions.height > 8000) {
        throw new Error('图片尺寸不能超过8000×8000')
      }
      additions.push({ file, previewUrl: URL.createObjectURL(file), ...dimensions })
    }
  } catch (error) {
    for (const item of additions) URL.revokeObjectURL(item.previewUrl)
    throw error
  }
  bucket.push(...additions)
}

async function addComposerImages(files) {
  await addImagesToBucket(state.composerImages, files)
  renderAttachmentPreview()
}

function inlineImageBucket(threadId) {
  if (!state.inlineComposerImages[threadId]) state.inlineComposerImages[threadId] = []
  return state.inlineComposerImages[threadId]
}

async function addInlineImages(threadId, files) {
  const bucket = inlineImageBucket(threadId)
  await addImagesToBucket(bucket, files)
  renderAttachmentPreviewInto(`ir-preview-${threadId}`, bucket)
}

function clearInlineImages(threadId) {
  const bucket = state.inlineComposerImages[threadId]
  if (!bucket) return
  for (const item of bucket) URL.revokeObjectURL(item.previewUrl)
  delete state.inlineComposerImages[threadId]
}

function memoryCardHTML(memory) {
  const tags = (memory.retrieval_tags || []).join('，')
  const meta = memory.type === 'sensitive_history'
    ? `HISTORICAL · ${memory.occurred_at || '时间不详'}`
    : memory.type === 'current_state'
      ? `有效至 ${memory.expires_at || '未知'}`
      : `更新于 ${memory.updated_at || memory.created_at || '未知'}`
  return `<article class="memory-admin-card" data-memory-id="${esc(memory.id)}" data-memory-type="${memory.type}">
    <div class="memory-admin-meta">${memory.type !== 'current_state' ? `${esc((memory.topics || ['日常']).join('，'))} · ` : ''}${esc(meta)}</div>
    <input class="memory-title-input" value="${esc(memory.title || '')}" aria-label="记忆标题">
    <textarea class="memory-summary-input" rows="4" aria-label="记忆摘要">${esc(memory.summary || '')}</textarea>
    <input class="memory-tags-input" value="${esc(tags)}" placeholder="检索标签，用逗号分开" aria-label="检索标签">
    ${memory.type === 'current_state' ? `<textarea class="memory-status-input" rows="2" aria-label="当前状态">${esc(memory.status || '')}</textarea>` : ''}
    <div class="memory-admin-actions">
      <button class="memory-save-btn">保存修改</button>
      <button class="memory-delete-btn">删除</button>
    </div>
  </article>`
}

function memoryLitCardHTML(memory) {
  return `<article class="memory-lit-card">
    <div class="memory-lit-topics">${(memory.topics || ['日常']).map(topic => esc(topic)).join(' · ')}</div>
    <strong>${esc(memory.title || '')}</strong>
    <p>${esc(memory.summary || '')}</p>
  </article>`
}

function dedupeGroupHTML(type, group, originals) {
  const items = group.ids.map(id => originals.find(memory => String(memory.id) === String(id))).filter(Boolean)
  return `<article class="dedupe-group" data-type="${esc(type)}" data-ids="${esc(group.ids.join(','))}">
    <div class="dedupe-originals">${items.map(item => `<div class="dedupe-original"><strong>${esc(item.title)}</strong><p>${esc(item.summary)}</p></div>`).join('')}</div>
    <div class="dedupe-merged">
      <input class="dedupe-title-input" value="${esc(group.merged_title)}" aria-label="合并后标题">
      <textarea class="dedupe-summary-input" rows="4" aria-label="合并后摘要">${esc(group.merged_summary)}</textarea>
      <input class="dedupe-tags-input" value="${esc((group.merged_tags || []).join('，'))}" placeholder="合并后标签，用逗号分开" aria-label="合并后标签">
    </div>
    <div class="dedupe-actions">
      <button class="dedupe-merge-btn">确认合并</button>
      <button class="dedupe-skip-btn">跳过</button>
    </div>
  </article>`
}

function renderMemoryGraphSVG(graph) {
  if (!graph?.nodes?.length) return '<p class="empty">还没有记忆可以画地图。</p>'
  const width = 340, height = 340, cx = width / 2, cy = height / 2
  const parentRadius = 112, childRadius = 50, childSpread = 0.95
  const positions = new Map()
  const parents = graph.nodes.filter(node => !node.parent)
  parents.forEach((parent, i) => {
    const angle = (i / parents.length) * Math.PI * 2 - Math.PI / 2
    const x = cx + Math.cos(angle) * parentRadius
    const y = cy + Math.sin(angle) * parentRadius
    positions.set(parent.id, { x, y })
    const children = graph.nodes.filter(node => node.parent === parent.id)
    children.forEach((child, j) => {
      const childAngle = angle - childSpread / 2 + (children.length > 1 ? (j / (children.length - 1)) * childSpread : 0)
      positions.set(child.id, { x: x + Math.cos(childAngle) * childRadius, y: y + Math.sin(childAngle) * childRadius })
    })
  })
  const edgesSvg = graph.edges.map(edge => {
    const a = positions.get(edge.source), b = positions.get(edge.target)
    if (!a || !b) return ''
    const structural = edge.type === 'structural'
    const strokeWidth = structural ? 1.2 : Math.min(4, 1 + edge.weight * 0.6)
    const dash = structural ? '' : 'stroke-dasharray="3,3"'
    const stroke = structural ? 'rgba(164,123,184,0.4)' : 'rgba(194,141,112,0.6)'
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${stroke}" stroke-width="${strokeWidth}" ${dash}></line>`
  }).join('')
  const nodesSvg = graph.nodes.map(node => {
    const pos = positions.get(node.id)
    if (!pos) return ''
    const isParent = !node.parent
    const r = (isParent ? 22 : 13) + Math.min(12, node.count * 2)
    const fill = node.count > 0 ? (isParent ? '#5b3170' : '#3a2249') : 'rgba(58,34,73,0.35)'
    const textColor = node.count > 0 ? '#e9d6f2' : '#7a6a85'
    return `<g class="memory-node" data-topic="${esc(node.id)}" transform="translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})">
      <circle r="${r}" fill="${fill}" stroke="#a47bb8" stroke-width="1"></circle>
      <text text-anchor="middle" dy="${r + 12}" font-size="${isParent ? 11 : 9.5}" fill="${textColor}">${esc(node.label)}</text>
    </g>`
  }).join('')
  return `<svg class="memory-graph-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${edgesSvg}${nodesSvg}</svg>`
}

function renderMemoryManager() {
  const data = state.managedMemories
  const sections = [
    ['current_state', '当前状态', '只显示仍在有效期内的短期状态'],
  ]
  return `<div class="memory-admin-page">
    <header class="room-header">
      <button class="back-btn" id="back-btn">‹ 返回</button>
      <span class="room-header-name">长期记忆</span>
    </header>
    <main class="memory-admin-inner">
      <div class="memory-admin-intro">
        <h2>${COMPANION_NAME}会记得的事</h2>
        <p>${COMPANION_NAME}每次只会想起少量相关内容，不会一次读完全部记忆。你可以在这里校正或删除它们。</p>
        ${data?.expired_current_count ? `<small>${data.expired_current_count} 条已过期当前状态已自动停止检索。</small>` : ''}
      </div>
      ${data?.graph ? `<section class="memory-graph-section">
        <div class="memory-section-heading"><div><h3>记忆地图</h3><p>点一个 topic 展开它下面的记忆；实线是分类里的父子关系，虚线是同一条记忆同时命中的 topic</p></div></div>
        <div class="memory-graph-wrap" id="memory-graph-wrap">${renderMemoryGraphSVG(data.graph)}</div>
        <div class="memory-test-row">
          <input id="memory-test-input" class="memory-test-input" placeholder="试试输入一句话，比如“最近在看的电视剧”">
          <button id="memory-test-btn" class="memory-test-btn">测试检索</button>
        </div>
        <div id="memory-test-result" class="memory-test-result"></div>
        <section class="memory-topic-section" id="memory-topic-section"></section>
      </section>` : ''}
      ${data ? `<section class="memory-dedupe-section">
        <div class="memory-section-heading"><div><h3>重复检测</h3><p>找出说的是同一件事、但被分开存了好几条的记忆；合并前你可以先改一改再确认</p></div></div>
        <div class="memory-dedupe-controls">
          <button class="memory-dedupe-btn" data-type="ordinary">检测普通长期记忆</button>
          <button class="memory-dedupe-btn" data-type="sensitive_history">检测历史敏感记忆</button>
        </div>
        <div id="memory-dedupe-result" class="memory-dedupe-result"></div>
      </section>` : ''}
      ${data?.taxonomy?.length ? `<details class="memory-folder-index"><summary>Topic 分类与联想关键词</summary>${data.taxonomy.map(topic => `<p><strong>${esc(topic.name)}</strong>：${esc(topic.keywords.join('、'))}${(topic.children || []).map(child => `<br>　└ <strong>${esc(child.name)}</strong>：${esc(child.keywords.join('、'))}`).join('')}</p>`).join('')}</details>` : ''}
      ${!data ? '<p class="empty">正在打开记忆柜…</p>' : sections.map(([key, title, description]) => `
        <section class="memory-admin-section">
          <div class="memory-section-heading"><div><h3>${title}</h3><p>${description}</p></div><span>${(data[key] || []).length}</span></div>
          <div class="memory-admin-list">${(data[key] || []).length ? data[key].map(memoryCardHTML).join('') : '<p class="empty">这一层还没有记忆。</p>'}</div>
        </section>`).join('')}
    </main>
  </div>`
}

function memoriesForTopic(data, topicId) {
  const isParent = !topicId.includes('/')
  const matches = memory => isParent
    ? (memory.topics || []).some(topic => topic === topicId || topic.startsWith(`${topicId}/`))
    : (memory.topics || []).includes(topicId)
  return {
    ordinary: (data?.ordinary || []).filter(matches),
    sensitive_history: (data?.sensitive_history || []).filter(matches),
  }
}

function renderBook(roomId) {
  const isDiary = roomId === 'diary'
  const room = ROOMS[roomId]
  const threads = groupThreads(getMessages(room.key))
  const total = threads.length
  if (state.bookPage[roomId] > total) state.bookPage[roomId] = total
  if (isDiary && total > 0 && state.bookPage[roomId] < 1) state.bookPage[roomId] = 1
  const pg = state.bookPage[roomId]
  const minPg = isDiary ? 1 : 0
  const isWrite = !isDiary && pg === 0
  const isEmpty = isDiary && total === 0
  const thread = threads[pg - 1] || null
  const diaryDate = (item, index) => {
    const raw = item?.msgs?.[0]?.time || ''
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    return raw.split(/[\s,]/)[0] || `第 ${index + 1} 页`
  }

  return `
    <div class="room-page">
      <header class="room-header">
        <button class="back-btn" id="back-btn">‹ 返回</button>
        <span class="room-header-name">${room.name}</span>
      </header>
      <div class="book-scene">
        <div class="book-wrap">
          <div class="book">
            <div class="book-top">
              ${isWrite
                ? '<span class="page-label">新的一页</span>'
                : isEmpty
                  ? '<span class="page-label">还没有日记</span>'
                  : `<span class="page-label">第 ${pg} 页 &nbsp;/&nbsp; 共 ${total} 页</span>`}
              ${isDiary && !isEmpty ? `
                <details class="diary-toc" id="diary-toc">
                  <summary>目录</summary>
                  <div class="diary-toc-list">
                    ${threads.map((item, index) => `
                      <button class="diary-toc-item ${pg === index + 1 ? 'active' : ''}" data-page="${index + 1}">${esc(diaryDate(item, index))}</button>
                    `).join('')}
                  </div>
                </details>` : ''}
            </div>
            <div class="page-body" id="page-body">
              ${isWrite ? `
                <div class="write-page">
                  <textarea id="book-input" placeholder="在这里写下今天的故事…" maxlength="400" enterkeyhint="send"></textarea>
                  <div class="book-write-actions">
                    <button class="book-save-btn" id="book-save">写好了 ✦</button>
                    <button class="book-muse-btn" id="book-muse">让${COMPANION_NAME}写一页</button>
                  </div>
                </div>` : isEmpty ? `
                <div class="read-page">
                  <p class="empty">攒够60条留言后，${COMPANION_NAME}会自动在这里写第一篇日记。</p>
                </div>` : `
                <div class="read-page">
                  <div class="book-thread" data-thread="${thread.threadId}">
                    ${thread.msgs.map(m => `
                      <div class="book-bubble ${m.fromMuse ? 'book-bubble-muse' : 'book-bubble-user'}">
                        ${m.fromMuse ? `<span class="muse-tag book-muse-tag">✦ ${COMPANION_NAME}</span>` : ''}
                        <p class="book-text">${esc(m.text)}</p>
                        <div class="book-bubble-meta">
                          <span class="book-time">${m.time}</span>
                          <button class="delete-msg-btn book-delete-btn" data-id="${m.id}">删除</button>
                        </div>
                      </div>`).join('')}
                  </div>
                  ${isDiary ? '' : `
                  <div class="book-page-footer">
                    <button class="book-reply-btn t-muse-btn" data-thread="${thread.threadId}">${COMPANION_NAME}来说</button>
                    <button class="book-reply-btn t-user-btn" data-thread="${thread.threadId}">我来说</button>
                  </div>
                  <div class="thread-inline book-inline" id="ir-${thread.threadId}" hidden>
                    <textarea class="inline-input" placeholder="接着写…" rows="3" enterkeyhint="send"></textarea>
                    <div class="inline-row">
                      <button class="t-cancel-btn" data-thread="${thread.threadId}">取消</button>
                      <button class="t-send-btn" data-thread="${thread.threadId}">发送</button>
                    </div>
                  </div>`}
                </div>`}
            </div>
          </div>

          <div class="book-nav">
            <button class="nav-btn" id="btn-older" ${pg >= total ? 'disabled' : ''}>‹ 翻旧</button>
            <button class="nav-btn" id="btn-newer" ${pg <= minPg ? 'disabled' : ''}>翻新 ›</button>
          </div>
        </div>
      </div>
    </div>`
}

function renderToolRoom(kind) {
  const isBar = kind === 'bar'
  const isFitness = kind === 'fitness'
  const result = state.toolResults[kind]
  return `
    <div class="tool-room tool-room-${kind}">
      <header class="room-header">
        <button class="back-btn" id="back-btn">‹ 返回</button>
        <span class="room-header-name">${isBar ? '吧台' : isFitness ? '健身房' : '书房'}</span>
      </header>
      <main class="tool-room-inner">
        <section class="tool-panel">
          <div class="tool-title-row">
            <span class="tool-icon">${isBar ? '🍸' : isFitness ? '🥗' : '📚'}</span>
            <div>
              <h2>${isBar ? '今日特调' : isFitness ? '今日饮食与运动' : '今日安排'}</h2>
              <p>${isBar ? `${COMPANION_NAME}会问问你今天的味道。` : isFitness ? `${COMPANION_NAME}会认真盯着你，但不许你伤身体。` : `${COMPANION_NAME}会把乱糟糟的事拎成时间块。`}</p>
            </div>
          </div>

          <form class="tool-form" id="tool-form">
            ${isBar ? `
              <label>
                <span>今天心情</span>
                <input name="mood" type="text" placeholder="比如：有点累、想被哄、还算开心">
              </label>
              <label>
                <span>想喝什么</span>
                <input name="drink" type="text" placeholder="比如：甜的、冰的、茶、咖啡、无酒精">
              </label>
              <label>
                <span>身体/精神状态</span>
                <input name="energy" type="text" placeholder="比如：胃不舒服、困、想清醒一点">
              </label>
              <label>
                <span>今晚想要的感觉</span>
                <input name="vibe" type="text" placeholder="比如：被抱住、庆祝、安静、漂亮一点">
              </label>
              <button class="tool-submit" type="submit">生成今日特调</button>
            ` : isFitness ? `
              <label>
                <span>基本情况（选填）</span>
                <input name="profile" type="text" placeholder="比如：身高、体重、需要注意的身体情况">
              </label>
              <label>
                <span>今天身体状态</span>
                <textarea name="body" rows="3" placeholder="比如：有点累、睡不够、胃口很大、还行"></textarea>
              </label>
              <label>
                <span>今天吃了/准备吃什么</span>
                <textarea name="food" rows="4" placeholder="比如：早餐咖啡和面包，午餐想吃米饭，晚上不知道"></textarea>
              </label>
              <label>
                <span>可用食材/忌口</span>
                <textarea name="ingredients" rows="3" placeholder="比如：鸡蛋、鸡胸、豆腐、米饭、青菜；不吃牛肉/乳糖不耐"></textarea>
              </label>
              <label>
                <span>可运动时间</span>
                <input name="time" type="text" placeholder="比如：今天只有20分钟，或者晚上7点后40分钟">
              </label>
              <label>
                <span>运动限制</span>
                <input name="limits" type="text" placeholder="比如：膝盖不能跳、只能室内">
              </label>
              <label>
                <span>今天目标</span>
                <input name="goal" type="text" placeholder="比如：别暴食、吃够蛋白、轻轻动一下">
              </label>
              <button class="tool-submit" type="submit">让${COMPANION_NAME}安排今日计划</button>
            ` : `
              <label>
                <span>今天要做的事</span>
                <textarea name="tasks" rows="5" placeholder="把所有要做的事丢进来，不用整理"></textarea>
              </label>
              <label>
                <span>可用时间</span>
                <input name="time" type="text" placeholder="比如：下午2点到6点，晚上还有1小时">
              </label>
              <label>
                <span>精力状态</span>
                <input name="energy" type="text" placeholder="比如：很累、焦虑、还能撑、想慢慢来">
              </label>
              <label>
                <span>最想先完成/最焦虑的事</span>
                <input name="priority" type="text" placeholder="比如：投简历、作业、面试准备">
              </label>
              <button class="tool-submit" type="submit">让${COMPANION_NAME}安排时间</button>
            `}
          </form>
        </section>

        <section class="tool-result" id="tool-result" ${result ? '' : 'hidden'}>
          <span class="muse-tag">✦ ${COMPANION_NAME}</span>
          <div class="tool-result-text">${result ? esc(result) : ''}</div>
        </section>
      </main>
    </div>`
}

// ── State & navigation ────────────────────────────────────────────────────────

const state = {
  view: 'house',
  room: null,
  modalOpen: false,
  managedMemories: null,
  bookPage: { memory: 0, diary: 0 },
  composerImages: [],
  inlineComposerImages: {},
  selectingThreads: false,
  selectedThreads: new Set(),
  showHiddenThreads: false,
  toolResults: {
    bar: '',
    study: '',
    fitness: '',
  },
}

async function loadManagedMemories() {
  if (!USE_API) {
    state.managedMemories = { ordinary: [], sensitive_history: [], current_state: [], expired_current_count: 0 }
    return
  }
  const res = await apiFetch('/api/memories?mode=manage')
  if (!res.ok) throw new Error(`Memory API ${res.status}`)
  state.managedMemories = await res.json()
}

async function go(view, room = null) {
  for (const item of state.composerImages) URL.revokeObjectURL(item.previewUrl)
  state.composerImages = []
  state.view      = view
  state.room      = room
  state.modalOpen = false
  state.selectingThreads = false
  state.selectedThreads = new Set()
  state.showHiddenThreads = false
  window.scrollTo(0, 0)
  // 预加载该房间的留言
  if (room && ROOMS[room]) {
    await Promise.all([loadMessages(ROOMS[room].key), loadThreadMeta(ROOMS[room].key)])
    const latest = getMessages(ROOMS[room].key)[0]
    if (latest) requestBackgroundMaintenance(ROOMS[room].key, latest.threadId || latest.id)
  }
  if (view === 'memory') await loadMessages(ROOMS.memory.key)
  if (view === 'diary') await loadMessages(ROOMS.diary.key)
  if (view === 'memory-manager') {
    state.managedMemories = null
    try { await loadManagedMemories() } catch { state.managedMemories = { ordinary: [], sensitive_history: [], current_state: [], expired_current_count: 0, loadError: true } }
  }
  render()
}

function flipBook(dir, roomId) {
  const body = document.getElementById('page-body')
  if (!body) return
  body.classList.add(dir === 'older' ? 'flip-left' : 'flip-right')
  setTimeout(() => {
    state.bookPage[roomId] += dir === 'older' ? 1 : -1
    render()
  }, 220)
}

function openModal() {
  state.modalOpen = true
  document.getElementById('msg-modal')?.classList.add('open')
  document.getElementById('modal-back')?.classList.add('open')
  setTimeout(() => document.getElementById('msg-input')?.focus(), 350)
}

function closeModal() {
  state.modalOpen = false
  document.getElementById('msg-modal')?.classList.remove('open')
  document.getElementById('modal-back')?.classList.remove('open')
}

function sendOnReturn(input, send) {
  if (!input || input.dataset.returnSends === 'true') return
  input.dataset.returnSends = 'true'
  let composing = false
  let allowLineBreak = false
  let sending = false
  const isReturnKey = e =>
    e.key === 'Enter' || e.key === 'NumpadEnter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13 || e.which === 13
  const submit = e => {
    if (composing || e.isComposing) return
    e.preventDefault()
    if (sending) return
    sending = true
    send()
    setTimeout(() => { sending = false }, 250)
  }
  input.addEventListener('compositionstart', () => { composing = true })
  input.addEventListener('compositionend', () => { composing = false })
  input.addEventListener('keydown', e => {
    if (!isReturnKey(e)) return
    if (e.shiftKey) {
      allowLineBreak = true
      return
    }
    submit(e)
  })
  input.addEventListener('keyup', e => {
    if (!isReturnKey(e) || e.shiftKey) return
    submit(e)
  })
  input.addEventListener('beforeinput', e => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return
    if (allowLineBreak) return
    submit(e)
  })
  input.addEventListener('input', () => {
    if (composing || !/\n$/.test(input.value)) return
    if (allowLineBreak) {
      allowLineBreak = false
      return
    }
    input.value = input.value.replace(/\n+$/, '')
    submit({ preventDefault() {}, isComposing: false })
  })
}

async function autoReplyInRoom(roomId, key, threadId) {
  const threadMsgs = getMessages(key)
    .filter(m => String(m.threadId || m.id) === String(threadId))
    .sort((a, b) => a.id - b.id)
  const result = await askMuseAutonomous(roomId, threadMsgs)
  const latestUserMessage = [...threadMsgs].reverse().find(message => !message.fromMuse)
  if (latestUserMessage?.attachments?.length && result.visualNote) {
    await annotateImageMessage(key, latestUserMessage.id, result.visualNote)
  }
  if (result.shouldReply) await saveMessage(key, result.reply, true, Number(threadId))
  else await saveMessage(key, result.status || normalizeMuseStatus(''), true, Number(threadId), [], 'status')
  requestBackgroundMaintenance(key, threadId, result.decision?.diaryAction === 'write_now')
  return result.shouldReply
}

// ── Main render ───────────────────────────────────────────────────────────────

async function checkProactiveMessage() {
  if (!USE_API) return
  try {
    const res = await apiFetch('/api/muse-proactive?mode=poll')
    if (!res.ok) return
    const data = await res.json()
    if (!data?.message?.text) return
    const toast = document.getElementById('proactive-toast')
    const text = document.getElementById('proactive-toast-text')
    if (!toast || !text) return
    text.textContent = data.message.text
    toast.hidden = false
    toast.addEventListener('click', () => go('scene', 'living'), { once: true })
    document.getElementById('proactive-toast-close')?.addEventListener('click', event => {
      event.stopPropagation()
      toast.hidden = true
    }, { once: true })
  } catch {}
}

function render() {
  const app = document.getElementById('app')

  if (state.view === 'house') {
    app.innerHTML = renderHouseGate()
    const gate = document.getElementById('house-gate')
    document.getElementById('house-gate-house')?.addEventListener('click', () => {
      gate.classList.add('zooming')
      setTimeout(() => go('home'), 650)
    })
    return
  }

  if (state.view === 'home') {
    app.innerHTML = renderHome()
    app.querySelectorAll('.scene-card').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.room
        if (r === 'memory' || r === 'diary') go(r)
        else if (r === 'memory-manager') go('memory-manager')
        else if (r === 'bar' || r === 'study' || r === 'fitness') go(r)
        else go('scene', r)
      })
    })
    checkProactiveMessage()
    document.getElementById('sign-out-btn')?.addEventListener('click', () => supabase.auth.signOut())

    const goOutBtn = document.getElementById('go-out-btn')
    const goOutInput = document.getElementById('go-out-input')
    const goOutResult = document.getElementById('go-out-result')
    const sendGoOut = async () => {
      if (!USE_API || goOutBtn.disabled) return
      const destination = goOutInput.value.trim()
      goOutBtn.disabled = true
      goOutBtn.textContent = '出门中…'
      goOutResult.hidden = true
      try {
        const res = await apiFetch('/api/muse-proactive?mode=go-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ destination }),
        })
        if (!res.ok) throw new Error(`API ${res.status}`)
        const data = await res.json()
        goOutResult.textContent = data.text || '他逛了一圈，没找到特别想说的，再试一次？'
        goOutResult.hidden = false
        goOutInput.value = ''
      } catch {
        goOutResult.textContent = '出门失败了，再试一次。'
        goOutResult.hidden = false
      }
      goOutBtn.disabled = false
      goOutBtn.textContent = '让他出门 🚪'
    }
    goOutBtn?.addEventListener('click', sendGoOut)
    goOutInput?.addEventListener('keydown', event => { if (event.key === 'Enter') sendGoOut() })

  } else if (state.view === 'scene') {
    app.innerHTML = renderScene(state.room)
    const key = ROOMS[state.room].key

    document.getElementById('back-btn').addEventListener('click', () => go('home'))
    const msgList = document.getElementById('msg-list')
    const imageInput = document.getElementById('image-input')
    document.getElementById('attach-btn').addEventListener('click', () => imageInput.click())
    imageInput.addEventListener('change', async () => {
      try { await addComposerImages(imageInput.files || []) }
      catch (error) { window.alert(error.message) }
      imageInput.value = ''
    })
    document.getElementById('attachment-preview').addEventListener('click', e => {
      const remove = e.target.closest('.remove-attachment')
      if (!remove) return
      const [item] = state.composerImages.splice(Number(remove.dataset.index), 1)
      if (item) URL.revokeObjectURL(item.previewUrl)
      renderAttachmentPreview()
    })
    let keepScrollOnce = false
    const scrollToLatest = () => {
      if (keepScrollOnce) { keepScrollOnce = false; return }
      msgList.scrollTop = msgList.scrollHeight
    }
    requestAnimationFrame(scrollToLatest)
    new MutationObserver(scrollToLatest).observe(msgList, { childList: true })

    // ── 多选整理聊天 ──
    const selectBar = document.getElementById('thread-select-bar')
    const refreshThreadList = ({ keepScroll = false } = {}) => {
      keepScrollOnce = keepScroll
      msgList.innerHTML = msgListHTML(key)
    }
    const selectedIds = () => [...state.selectedThreads]
    const updateSelectBar = () => {
      const ids = selectedIds()
      const allHidden = ids.length > 0 && ids.every(id => getThreadMeta(key, id).hidden)
      document.getElementById('thread-select-count').textContent = ids.length ? `已选 ${ids.length} 段` : '选几段聊天'
      document.getElementById('thread-hide-btn').textContent = allHidden ? '取消隐藏' : '隐藏'
      for (const id of ['thread-group-btn', 'thread-hide-btn', 'thread-delete-btn']) {
        document.getElementById(id).disabled = !ids.length
      }
    }
    const setSelecting = selecting => {
      state.selectingThreads = selecting
      state.selectedThreads = new Set()
      document.querySelector('.chat-page')?.classList.toggle('selecting', selecting)
      document.getElementById('thread-select-btn').textContent = selecting ? '完成' : '选择'
      document.getElementById('msg-form').hidden = selecting
      selectBar.hidden = !selecting
      if (selecting) document.getElementById('attachment-preview').hidden = true
      else renderAttachmentPreview()
      updateSelectBar()
      refreshThreadList({ keepScroll: true })
    }
    const runThreadAction = async (button, action) => {
      const ids = selectedIds()
      if (!ids.length || button.disabled) return
      button.disabled = true
      try {
        const done = await action(ids)
        if (done !== false) setSelecting(false)
      } catch (error) {
        window.alert(error.message || '操作失败，请再试一次')
      } finally {
        updateSelectBar()
      }
    }

    document.getElementById('thread-select-btn').addEventListener('click', () => setSelecting(!state.selectingThreads))

    document.getElementById('thread-group-btn').addEventListener('click', event => runThreadAction(event.currentTarget, async ids => {
      const existing = [...new Set([...(threadMetaCache[key]?.values() || [])].map(meta => meta.group).filter(Boolean))]
      const name = window.prompt(`把选中的 ${ids.length} 段聊天放进哪个组？${existing.length ? `\n已有的组：${existing.join('、')}` : ''}\n留空 = 移出分组`, '')
      if (name === null) return false
      await updateThreadMeta(key, ids, { group: name.trim().slice(0, 40) || null })
    }))

    document.getElementById('thread-hide-btn').addEventListener('click', event => runThreadAction(event.currentTarget, async ids => {
      const unhide = ids.every(id => getThreadMeta(key, id).hidden)
      await updateThreadMeta(key, ids, { hidden: !unhide })
    }))

    document.getElementById('thread-delete-btn').addEventListener('click', event => runThreadAction(event.currentTarget, async ids => {
      if (!window.confirm(`删除选中的 ${ids.length} 段聊天？里面的消息会全部删掉，找不回来。`)) return false
      await deleteThreads(key, ids)
    }))

    // Save message
    async function submitSceneMessage() {
      const btn = document.getElementById('add-btn')
      const input = document.getElementById('msg-input')
      const text  = input.value.trim()
      const selectedImages = [...state.composerImages]
      if (!text && !selectedImages.length) return
      btn.disabled = true
      btn.textContent = selectedImages.length ? '上传中…' : '发送中…'
      try {
        const attachments = await Promise.all(selectedImages.map(async item => {
          if (!item.uploadedAttachment) item.uploadedAttachment = await uploadImage(item.file)
          return item.uploadedAttachment
        }))
        const message = await saveMessage(key, text, false, null, attachments)
        input.value = ''
        for (const item of state.composerImages) URL.revokeObjectURL(item.previewUrl)
        state.composerImages = []
        renderAttachmentPreview()
        document.getElementById('msg-list').innerHTML = msgListHTML(key)
        try {
          await autoReplyInRoom(state.room, key, message.threadId || message.id)
          document.getElementById('msg-list').innerHTML = msgListHTML(key)
        } catch (error) { console.error('[auto-reply] failed', error) }
      } catch (error) {
        window.alert(error.message || '发送失败，请再试一次')
      } finally {
        btn.disabled = false
        btn.textContent = '发送'
      }
    }

    document.getElementById('msg-form').addEventListener('submit', async e => {
      e.preventDefault()
      await submitSceneMessage()
    })

    sendOnReturn(document.getElementById('msg-input'), submitSceneMessage)

    async function submitInlineReply(tid) {
      const el = document.getElementById(`ir-${tid}`)
      const input = el?.querySelector('.inline-input')
      const sendBtn = el?.querySelector('.t-send-btn')
      const text = input?.value.trim()
      const selectedImages = [...(state.inlineComposerImages[tid] || [])]
      if ((!text && !selectedImages.length) || sendBtn?.disabled) return
      if (sendBtn) sendBtn.disabled = true
      try {
        const attachments = await Promise.all(selectedImages.map(async item => {
          if (!item.uploadedAttachment) item.uploadedAttachment = await uploadImage(item.file)
          return item.uploadedAttachment
        }))
        await saveMessage(key, text, false, Number(tid), attachments)
        clearInlineImages(tid)
        document.getElementById('msg-list').innerHTML = msgListHTML(key)
        try {
          await autoReplyInRoom(state.room, key, tid)
          document.getElementById('msg-list').innerHTML = msgListHTML(key)
        } catch (error) { console.error('[auto-reply] failed', error) }
      } catch (error) {
        window.alert(error.message || '发送失败，请再试一次')
        if (sendBtn) sendBtn.disabled = false
      }
    }

    // Thread action buttons (event delegation)
    msgList.addEventListener('keydown', async (e) => {
      const input = e.target.closest('.inline-input')
      if (!input || e.shiftKey) return
      const isReturn = e.key === 'Enter' || e.key === 'NumpadEnter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13 || e.which === 13
      if (!isReturn || e.isComposing) return
      const wrap = input.closest('.thread-inline')
      const tid = wrap?.id?.replace('ir-', '')
      if (!tid) return
      e.preventDefault()
      await submitInlineReply(tid)
    })

    msgList.addEventListener('click', async (e) => {
      if (e.target.closest('#thread-hidden-toggle')) {
        state.showHiddenThreads = !state.showHiddenThreads
        refreshThreadList({ keepScroll: true })
        return
      }
      if (state.selectingThreads) {
        const selectable = e.target.closest('.thread-pile-item > summary, .thread-current-select')?.closest('[data-select-thread]')
        if (selectable) {
          e.preventDefault()
          const tid = selectable.dataset.selectThread
          if (state.selectedThreads.has(tid)) state.selectedThreads.delete(tid)
          else state.selectedThreads.add(tid)
          selectable.classList.toggle('selected', state.selectedThreads.has(tid))
          updateSelectBar()
          return
        }
      }
      const pileSummary = e.target.closest('.thread-pile-item > summary')
      if (pileSummary) {
        const body = pileSummary.parentElement?.querySelector('.thread-pile-body')
        loadThreadPileBody(key, body?.dataset.threadId, body)
        return
      }
      const deleteBtn = e.target.closest('.delete-msg-btn')
      if (deleteBtn) {
        if (!window.confirm('确认吗')) return
        deleteBtn.disabled = true
        await deleteMessage(key, deleteBtn.dataset.id)
        document.getElementById('msg-list').innerHTML = msgListHTML(key)
        return
      }

      const museBtn = e.target.closest('.t-muse-btn')
      if (museBtn) {
        const tid = museBtn.dataset.thread
        const threadMsgs = getMessages(key)
          .filter(m => String(m.threadId || m.id) === tid)
          .sort((a, b) => a.id - b.id)
        museBtn.disabled = true
        museBtn.textContent = '想中…'
        try {
          const reply = await askMuseReply(state.room, threadMsgs)
          await saveMessage(key, reply, true, Number(tid))
          requestBackgroundMaintenance(key, tid)
          document.getElementById('msg-list').innerHTML = msgListHTML(key)
        } catch {
          museBtn.disabled = false
          museBtn.textContent = `${COMPANION_NAME}来说`
        }
        return
      }

      const userBtn = e.target.closest('.t-user-btn')
      if (userBtn) {
        const tid = userBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        if (el) {
          el.hidden = !el.hidden
          if (!el.hidden) {
            const input = el.querySelector('.inline-input')
            sendOnReturn(input, () => submitInlineReply(tid))
            input?.focus()
          }
        }
        return
      }

      const cancelBtn = e.target.closest('.t-cancel-btn')
      if (cancelBtn) {
        const tid = cancelBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        if (el) el.hidden = true
        clearInlineImages(tid)
        return
      }

      const inlineAttachBtn = e.target.closest('.t-attach-btn')
      if (inlineAttachBtn) {
        const tid = inlineAttachBtn.dataset.thread
        msgList.querySelector(`.inline-image-input[data-thread="${tid}"]`)?.click()
        return
      }

      const removeInlineAttachment = e.target.closest('.inline-attachment-preview .remove-attachment')
      if (removeInlineAttachment) {
        const tid = removeInlineAttachment.closest('.thread-inline')?.id?.replace('ir-', '')
        const bucket = tid ? state.inlineComposerImages[tid] : null
        if (bucket) {
          const [item] = bucket.splice(Number(removeInlineAttachment.dataset.index), 1)
          if (item) URL.revokeObjectURL(item.previewUrl)
          renderAttachmentPreviewInto(`ir-preview-${tid}`, bucket)
        }
        return
      }

      const sendBtn = e.target.closest('.t-send-btn')
      if (sendBtn) {
        await submitInlineReply(sendBtn.dataset.thread)
      }
    })

    msgList.addEventListener('change', async e => {
      const input = e.target.closest('.inline-image-input')
      if (!input) return
      const tid = input.dataset.thread
      try { await addInlineImages(tid, input.files || []) }
      catch (error) { window.alert(error.message) }
      input.value = ''
    })

    // 伴侣写一条
    document.getElementById('muse-btn').addEventListener('click', async () => {
      const btn = document.getElementById('muse-btn')
      btn.disabled = true
      btn.textContent = `${COMPANION_NAME}正在想…`
      try {
        const text = await askMuse(state.room)
        await saveMessage(key, text, true)
        document.getElementById('msg-list').innerHTML = msgListHTML(key)
      } catch (e) {
        btn.textContent = '出错了，再试一次'
        setTimeout(() => { btn.disabled = false; btn.textContent = `✦ 让${COMPANION_NAME}写一条` }, 2000)
        return
      }
      btn.disabled = false
      btn.textContent = `✦ 让${COMPANION_NAME}写一条`
    })

  } else if (state.view === 'memory-manager') {
    app.innerHTML = renderMemoryManager()
    document.getElementById('back-btn').addEventListener('click', () => go('home'))

    const testBtn = document.getElementById('memory-test-btn')
    const testInput = document.getElementById('memory-test-input')
    const resultBox = document.getElementById('memory-test-result')
    const graphWrap = document.getElementById('memory-graph-wrap')
    const runMemoryTest = async () => {
      const q = testInput.value.trim()
      if (!q || !USE_API) return
      testBtn.disabled = true
      testBtn.textContent = '检索中…'
      graphWrap?.querySelectorAll('.memory-node--lit').forEach(node => node.classList.remove('memory-node--lit'))
      try {
        const res = await apiFetch(`/api/memories?query=${encodeURIComponent(q)}`)
        if (!res.ok) throw new Error(`API ${res.status}`)
        const result = await res.json()
        for (const topic of result.lit_topics || []) {
          graphWrap?.querySelector(`.memory-node[data-topic="${CSS.escape(topic)}"]`)?.classList.add('memory-node--lit')
        }
        resultBox.innerHTML = (result.lit_memories || []).length
          ? result.lit_memories.map(memoryLitCardHTML).join('')
          : '<p class="empty">这句话目前点不亮任何记忆。</p>'
      } catch {
        resultBox.innerHTML = '<p class="empty">检索失败，再试一次。</p>'
      }
      testBtn.disabled = false
      testBtn.textContent = '测试检索'
    }
    testBtn?.addEventListener('click', runMemoryTest)
    testInput?.addEventListener('keydown', event => { if (event.key === 'Enter') runMemoryTest() })

    const topicSection = document.getElementById('memory-topic-section')
    let selectedTopic = null
    const renderTopicSection = () => {
      graphWrap?.querySelectorAll('.memory-node').forEach(node => node.classList.toggle('memory-node--selected', node.dataset.topic === selectedTopic))
      if (!topicSection) return
      if (!selectedTopic) { topicSection.innerHTML = ''; return }
      const { ordinary, sensitive_history: historical } = memoriesForTopic(state.managedMemories, selectedTopic)
      topicSection.innerHTML = `
        <div class="memory-topic-heading">
          <h4>「${esc(selectedTopic.split('/').pop())}」相关记忆 · ${ordinary.length + historical.length}</h4>
          <button class="memory-topic-close" id="memory-topic-close">✕ 收起</button>
        </div>
        ${(ordinary.length || historical.length)
          ? `<div class="memory-admin-list">${[...ordinary, ...historical].map(memoryCardHTML).join('')}</div>`
          : '<p class="empty">这个 topic 下还没有记忆。</p>'}
      `
      document.getElementById('memory-topic-close')?.addEventListener('click', () => { selectedTopic = null; renderTopicSection() })
    }
    graphWrap?.addEventListener('click', event => {
      const node = event.target.closest('.memory-node')
      if (!node) return
      selectedTopic = selectedTopic === node.dataset.topic ? null : node.dataset.topic
      renderTopicSection()
    })

    const dedupeResult = document.getElementById('memory-dedupe-result')
    document.querySelectorAll('.memory-dedupe-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type = btn.dataset.type
        const originalLabel = btn.textContent
        btn.disabled = true
        btn.textContent = '检测中…'
        try {
          const res = await apiFetch(`/api/memories?mode=dedupe-scan&type=${type}`)
          if (!res.ok) throw new Error(`API ${res.status}`)
          const result = await res.json()
          const originals = state.managedMemories?.[type] || []
          dedupeResult.innerHTML = (result.groups || []).length
            ? result.groups.map(group => dedupeGroupHTML(type, group, originals)).join('')
            : '<p class="empty">没发现明显重复。</p>'
        } catch {
          dedupeResult.innerHTML = '<p class="empty">检测失败，再试一次。</p>'
        }
        btn.disabled = false
        btn.textContent = originalLabel
      })
    })
    dedupeResult?.addEventListener('click', async event => {
      const group = event.target.closest('.dedupe-group')
      if (!group) return
      if (event.target.closest('.dedupe-skip-btn')) { group.remove(); return }
      const mergeBtn = event.target.closest('.dedupe-merge-btn')
      if (!mergeBtn) return
      mergeBtn.disabled = true
      mergeBtn.textContent = '合并中…'
      const body = {
        type: group.dataset.type,
        ids: group.dataset.ids.split(','),
        title: group.querySelector('.dedupe-title-input')?.value || '',
        summary: group.querySelector('.dedupe-summary-input')?.value || '',
        retrieval_tags: (group.querySelector('.dedupe-tags-input')?.value || '').split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      }
      try {
        const res = await apiFetch('/api/memories?action=merge-duplicates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        if (!res.ok) throw new Error(`API ${res.status}`)
        group.remove()
        await loadManagedMemories()
      } catch {
        mergeBtn.disabled = false
        mergeBtn.textContent = '合并失败，重试'
      }
    })

    const page = document.querySelector('.memory-admin-inner')
    page?.addEventListener('click', async event => {
      const card = event.target.closest('.memory-admin-card')
      if (!card) return
      const type = card.dataset.memoryType
      const id = card.dataset.memoryId
      const saveBtn = event.target.closest('.memory-save-btn')
      const deleteBtn = event.target.closest('.memory-delete-btn')
      if (saveBtn) {
        saveBtn.disabled = true
        saveBtn.textContent = '保存中…'
        const body = {
          type,
          id,
          title: card.querySelector('.memory-title-input')?.value || '',
          summary: card.querySelector('.memory-summary-input')?.value || '',
          retrieval_tags: (card.querySelector('.memory-tags-input')?.value || '').split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
        }
        const statusInput = card.querySelector('.memory-status-input')
        if (statusInput) body.status = statusInput.value
        try {
          const res = await apiFetch('/api/memories', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          if (!res.ok) throw new Error(`API ${res.status}`)
          saveBtn.textContent = '已保存 ✓'
          setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = '保存修改' }, 1200)
        } catch {
          saveBtn.disabled = false
          saveBtn.textContent = '保存失败，重试'
        }
      }
      if (deleteBtn) {
        if (!window.confirm('删除这条长期记忆吗？')) return
        deleteBtn.disabled = true
        const res = await apiFetch('/api/memories', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, id }) })
        if (!res.ok) { deleteBtn.disabled = false; return }
        card.remove()
      }
    })

  } else if (state.view === 'memory') {
    app.innerHTML = renderBook('memory')

    document.getElementById('back-btn').addEventListener('click', () => go('home'))

    document.getElementById('book-save')?.addEventListener('click', async () => {
      const input = document.getElementById('book-input')
      const text  = input?.value.trim()
      if (!text) return
      await saveMessage(ROOMS.memory.key, text)
      state.bookPage.memory = 1
      render()
    })

    sendOnReturn(document.getElementById('book-input'), () => document.getElementById('book-save')?.click())

    document.getElementById('book-muse')?.addEventListener('click', async () => {
      const btn = document.getElementById('book-muse')
      btn.disabled = true
      btn.textContent = `${COMPANION_NAME}正在想…`
      try {
        const text = await askMuse('memory')
        await saveMessage(ROOMS.memory.key, text, true)
        state.bookPage.memory = 1
        render()
      } catch {
        btn.textContent = '出错了，再试一次'
        setTimeout(() => { btn.disabled = false; btn.textContent = `让${COMPANION_NAME}写一页` }, 2000)
      }
    })

    document.getElementById('btn-older')?.addEventListener('click', () => flipBook('older', 'memory'))
    document.getElementById('btn-newer')?.addEventListener('click', () => flipBook('newer', 'memory'))

    document.getElementById('page-body')?.addEventListener('click', async (e) => {
      const key = ROOMS.memory.key
      const deleteBtn = e.target.closest('.delete-msg-btn')
      if (deleteBtn) {
        if (!window.confirm('确认吗')) return
        deleteBtn.disabled = true
        await deleteMessage(key, deleteBtn.dataset.id)
        state.bookPage.memory = Math.min(state.bookPage.memory, groupThreads(getMessages(key)).length)
        render()
        return
      }

      const museBtn = e.target.closest('.t-muse-btn')
      if (museBtn) {
        const tid = museBtn.dataset.thread
        const threadMsgs = getMessages(key)
          .filter(m => String(m.threadId || m.id) === tid)
          .sort((a, b) => a.id - b.id)
        museBtn.disabled = true
        museBtn.textContent = '想中…'
        try {
          const reply = await askMuseReply('memory', threadMsgs)
          await saveMessage(key, reply, true, Number(tid))
          requestBackgroundMaintenance(key, tid)
          state.bookPage.memory = 1
          render()
        } catch {
          museBtn.disabled = false
          museBtn.textContent = `${COMPANION_NAME}来说`
        }
        return
      }

      const userBtn = e.target.closest('.t-user-btn')
      if (userBtn) {
        const tid = userBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        if (el) {
          el.hidden = !el.hidden
          if (!el.hidden) {
            const input = el.querySelector('.inline-input')
            sendOnReturn(input, () => el.querySelector('.t-send-btn')?.click())
            input?.focus()
          }
        }
        return
      }

      const cancelBtn = e.target.closest('.t-cancel-btn')
      if (cancelBtn) {
        const el = document.getElementById(`ir-${cancelBtn.dataset.thread}`)
        if (el) el.hidden = true
        return
      }

      const sendBtn = e.target.closest('.t-send-btn')
      if (sendBtn) {
        const tid = sendBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        const text = el?.querySelector('.inline-input')?.value.trim()
        if (!text) return
        sendBtn.disabled = true
        await saveMessage(key, text, false, Number(tid))
        state.bookPage.memory = 1
        render()
      }
    })

  } else if (state.view === 'diary') {
    app.innerHTML = renderBook('diary')

    document.getElementById('back-btn').addEventListener('click', () => go('home'))
    document.getElementById('btn-older')?.addEventListener('click', () => flipBook('older', 'diary'))
    document.getElementById('btn-newer')?.addEventListener('click', () => flipBook('newer', 'diary'))

    document.getElementById('diary-toc')?.addEventListener('click', e => {
      const item = e.target.closest('.diary-toc-item')
      if (!item) return
      state.bookPage.diary = Number(item.dataset.page)
      render()
    })

    document.getElementById('page-body')?.addEventListener('click', async (e) => {
      const key = ROOMS.diary.key
      const deleteBtn = e.target.closest('.delete-msg-btn')
      if (!deleteBtn) return
      if (!window.confirm('确认吗')) return
      deleteBtn.disabled = true
      await deleteMessage(key, deleteBtn.dataset.id)
      state.bookPage.diary = Math.min(state.bookPage.diary, groupThreads(getMessages(key)).length)
      render()
    })
  } else if (state.view === 'bar' || state.view === 'study' || state.view === 'fitness') {
    const kind = state.view
    app.innerHTML = renderToolRoom(kind)

    document.getElementById('back-btn').addEventListener('click', () => go('home'))
    document.getElementById('tool-form').addEventListener('submit', async e => {
      e.preventDefault()
      const form = e.currentTarget
      const btn = form.querySelector('.tool-submit')
      const data = Object.fromEntries(new FormData(form).entries())
      const resultEl = document.getElementById('tool-result')
      const textEl = resultEl.querySelector('.tool-result-text')

      btn.disabled = true
      btn.textContent = kind === 'bar' ? `${COMPANION_NAME}在摇杯…` : kind === 'fitness' ? `${COMPANION_NAME}在盯餐盘…` : `${COMPANION_NAME}在排表…`
      resultEl.hidden = false
      textEl.textContent = '想中…'

      try {
        const result = await askMuseTool(kind, data)
        state.toolResults[kind] = result
        textEl.innerHTML = esc(result)
      } catch {
        textEl.textContent = `${COMPANION_NAME}那边卡了一下，再戳他一次。`
      } finally {
        btn.disabled = false
        btn.textContent = kind === 'bar' ? '生成今日特调' : kind === 'fitness' ? `让${COMPANION_NAME}安排今日计划` : `让${COMPANION_NAME}安排时间`
      }
    })
  }
}

// ── Auth gate ───────────────────────────────────────────────────────────────

function renderLoginScreen(message) {
  document.getElementById('app').innerHTML = `
    <div class="login-screen">
      <h1 class="login-title">${COMPANION_NAME} & ${USER_DISPLAY_NAME}</h1>
      <p class="login-subtitle">我们共同的小角落</p>
      ${message ? `<p class="login-message">${esc(message)}</p>` : ''}
      <button id="google-login-btn" class="login-btn">用 Google 登录</button>
    </div>`
  document.getElementById('google-login-btn').addEventListener('click', () => {
    supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })
  })
}

async function boot() {
  if (!USE_API) { render(); return }
  const { data: { session } } = await supabase.auth.getSession()
  const email = session?.user?.email?.toLowerCase()
  if (session && email && ALLOWED_EMAILS.has(email)) {
    render()
  } else if (session) {
    renderLoginScreen('这个 Google 账号没有权限访问这个网站。')
  } else {
    renderLoginScreen()
  }
}

supabase.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') boot()
})
boot()
