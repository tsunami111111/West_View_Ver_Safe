import { supabase } from './_supabase.js'

// 允许使用后端接口的邮箱：在 Vercel 环境变量 ALLOWED_EMAILS 里填写，多个用英文逗号分隔
const ALLOWED_EMAILS = new Set(String(process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean))

export async function requireUser(req) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  const email = data?.user?.email?.toLowerCase()
  if (error || !email || !ALLOWED_EMAILS.has(email)) return null
  return data.user
}
