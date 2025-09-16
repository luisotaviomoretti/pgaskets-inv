# Test Setup Guide

## Configuração de Credenciais para Testes

### 1. Criar Usuário de Teste no Supabase

Para que os testes funcionem corretamente, você precisa criar um usuário de teste no Supabase:

1. **Acesse o Dashboard do Supabase:**
   - Vá para [https://app.supabase.com](https://app.supabase.com)
   - Navegue para seu projeto: `errkjwfxrbkfajngshkn`

2. **Configurar Autenticação:**
   - Vá para `Authentication` → `Settings`
   - **Desabilite confirmação por email** (para simplificar testes):
     - Em "Email Templates" → "Confirm signup" → desmarque "Enable email confirmations"
   - **Configure URLs de redirect:**
     - Adicione: `http://localhost:5173/**`

3. **Criar Usuário de Teste:**
   - Vá para `Authentication` → `Users`
   - Clique em "Add user"
   - **Email:** `admin@pgaskets.com`
   - **Password:** `pgaskets123`
   - **Auto Confirm User:** ✅ Marque esta opção
   - Clique em "Create user"

### 2. Configuração de Variáveis de Ambiente

O arquivo `.env.test` já foi criado com as configurações necessárias:

```env
# Test Environment Variables
TEST_EMAIL=admin@pgaskets.com
TEST_PASSWORD=pgaskets123

# Supabase configuration
VITE_SUPABASE_URL=https://errkjwfxrbkfajngshkn.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3. Executar os Testes

Após criar o usuário no Supabase:

```bash
# Rodar todos os testes
npm run test:playwright

# Rodar apenas testes de autenticação
npm run test:playwright -- --grep="Authentication"

# Rodar com interface visual
npm run test:playwright:ui
```

### 4. Helpers de Teste Disponíveis

O arquivo `tests/test-utils.ts` fornece funções utilitárias:

```typescript
// Login automático
await login(page);

// Logout automático  
await logout(page);

// Aguardar carregamento completo
await waitForLoadingToComplete(page);

// Verificar se está autenticado
const isLoggedIn = await isAuthenticated(page);
```

### 5. Troubleshooting

**Se os testes ainda falharem:**

1. **Verifique se o usuário existe no Supabase:**
   - Dashboard → Authentication → Users
   - Procure por `admin@pgaskets.com`

2. **Verifique as configurações de Auth:**
   - Email confirmations devem estar desabilitadas
   - URLs de redirect devem incluir `localhost:5173`

3. **Teste login manual:**
   - Inicie o servidor: `npm run dev`
   - Acesse: `http://localhost:5173/login`
   - Tente fazer login com as credenciais

4. **Verifique logs do Supabase:**
   - Dashboard → Logs
   - Procure por erros de autenticação

### 6. Estrutura dos Testes

```
tests/
├── test-utils.ts           # Funções auxiliares
├── auth.spec.ts           # Testes de autenticação
├── navigation.spec.ts     # Testes de navegação
├── performance.spec.ts    # Testes de performance
└── inventory-*.spec.ts    # Testes de inventário
```

### 7. Credenciais Alternativas

Se precisar usar credenciais diferentes, edite o arquivo `.env.test`:

```env
TEST_EMAIL=seu-email@exemplo.com
TEST_PASSWORD=sua-senha
```

**Importante:** O usuário deve existir no Supabase e estar confirmado.