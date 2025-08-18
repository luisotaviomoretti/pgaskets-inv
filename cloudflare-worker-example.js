import { createClient } from '@supabase/supabase-js'

export default {
  async fetch(request, env) {
    try {
      // Cria o cliente Supabase com as variáveis do Secrets Store
      const supabase = createClient(
        env.SUPABASE_URL,
        env.SUPABASE_ANON_KEY // Use ANON_KEY para operações de cliente
      )

      // Adiciona CORS headers para permitir requests do frontend
      const corsHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }

      // Handle preflight requests
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: corsHeaders
        })
      }

      // Parse URL to get route
      const url = new URL(request.url)
      const path = url.pathname

      // Exemplo de roteamento simples
      if (path === '/api/skus') {
        const { data, error } = await supabase
          .from('skus')
          .select('*')
          .eq('active', true)

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: corsHeaders
          })
        }

        return new Response(JSON.stringify(data), {
          headers: corsHeaders
        })
      }

      if (path === '/api/vendors') {
        const { data, error } = await supabase
          .from('vendors')
          .select('*')
          .eq('active', true)

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: corsHeaders
          })
        }

        return new Response(JSON.stringify(data), {
          headers: corsHeaders
        })
      }

      // Rota não encontrada
      return new Response(JSON.stringify({ error: 'Route not found' }), {
        status: 404,
        headers: corsHeaders
      })

    } catch (error) {
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      })
    }
  }
}