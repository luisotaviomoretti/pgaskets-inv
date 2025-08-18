import { createClient } from '@supabase/supabase-js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // rota de teste
    if (url.pathname === "/api/produtos") {
      const supabase = createClient(
        await env.SUPABASE_URL.get(),
        await env.SUPABASE_KEY.get()
      )

      const { data, error } = await supabase.from("produtos").select("*")

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 })
      }

      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
      })
    }

    // fallback
    return new Response("Worker rodando! Use /api/produtos", { status: 200 })
  }
}