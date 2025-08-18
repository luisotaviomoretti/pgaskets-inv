import { createClient } from '@supabase/supabase-js'

export default {
  async fetch(request, env, ctx) {
    // Inicializa o cliente usando secrets do Wrangler
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
    const url = new URL(request.url)

    // rota de teste: https://<seu-worker>.workers.dev/test
    if (url.pathname === '/test') {
      const { data, error } = await supabase
        .from('profiles') // troque pelo nome da sua tabela
        .select('*')
        .limit(5)

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          headers: { 'Content-Type': 'application/json' },
          status: 500,
        })
      }

      return new Response(JSON.stringify(data, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // fallback padrão
    return new Response(
      JSON.stringify({ message: 'Worker rodando! Use /test para consultar Supabase.' }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  },
}