# Plano Faseado e Seguro — Manage Categories (CRUD) para SKUs

Este documento define um plano seguro, diligente e não-disruptivo para introduzir a funcionalidade “Manage Categories” (CRUD de categorias) integrada ao fluxo de SKUs. O objetivo é permitir que o usuário gerencie categorias sem quebrar a integridade atual e sem mudanças arquiteturais disruptivas, seguindo o pilar Supabase-first e o padrão de Service Adapter existente.


## Objetivos e princípios

- __Supabase-first__: persistência no banco (Supabase) com RLS e índices adequados.
- __Não-disruptivo__: manter `skus.product_category` (TEXT) funcionando em paralelo enquanto evoluímos para categorias gerenciadas. Evitar breaking changes no curto prazo.
- __Feature flag__: ativar/desativar a feature sem impactar o fluxo atual. Usar `getFeatureFlag()` já existente no projeto.
- __Cache consciente__: droplist de categorias com cache (memória/LocalStorage) e invalidação consistente após operações de CRUD.
- __Segurança e integridade__: validações de nomes, unicidade, bloqueios seguros para exclusão/renomeação.
- __UX consistente__: botão “Manage Categories” ao lado de “Add SKU” dentro do modal de SKUs.


## Pontos de integração no frontend (onde tocar)

- __Quick Menu → Open SKUs → SKUsModal header__: arquivo `src/features/inventory/pages/Wireframe.tsx`
  - Header do modal de SKUs entre as linhas ~211–219 (função `SKUsModal`):
    - Hoje: botões `Add SKU/Close form` e `Close`.
    - Proposto: adicionar botão `Manage Categories` ao lado do `Add SKU/Close form`.
- __Formulário de SKU (Category droplist)__: ainda em `Wireframe.tsx`, bloco do `SKUsManager` (linhas ~618–624) usa `CATEGORY_OPTIONS` (constante definida em ~246) para preencher a lista. Vamos substituir por lista dinâmica proveniente do backend, atrás de feature flag e com fallback para a constante atual.
- __Service Adapter__: `src/features/inventory/services/inventory.adapter.ts` — adicionar `categoryOperations` assim como já existem `skuOperations` e `vendorOperations`.


## Modelo de dados (não-disruptivo)

Fase 1 não altera a tabela `skus` (mantém `product_category` como TEXT). Introduzimos uma nova tabela `categories` e, em fases posteriores (opcional), adicionamos `skus.category_id` com gatilhos para manter compatibilidade com `product_category`.

- __Tabela `categories` (nova)__
  - Colunas sugeridas:
    - `id TEXT PRIMARY KEY` (consistente com `skus`/`vendors`; alternativa futura: `UUID`)
    - `name TEXT NOT NULL UNIQUE`
    - `slug TEXT UNIQUE` (opcional)
    - `description TEXT` (opcional)
    - `active BOOLEAN DEFAULT TRUE`
    - `sort_order INT` (opcional para ordenação de UI)
    - `created_at TIMESTAMPTZ DEFAULT NOW()`
    - `updated_at TIMESTAMPTZ DEFAULT NOW()`
    - `metadata JSONB DEFAULT '{}'::jsonb`
  - Índices:
    - `idx_categories_active (active)`
    - `idx_categories_name_trgm USING gin(name gin_trgm_ops)` (opcional para busca)
  - RLS: idêntico ao padrão de `001_initial_schema.sql`: “Enable all for authenticated users” (podemos refinar depois por papéis).
  - Seeds/Backfill inicial: inserir `DISTINCT skus.product_category` como registros ativos, gerando `id` (ex.: slug do nome) e `sort_order` incremental.

- __Opcional (Fase 2 avançada)__: `ALTER TABLE skus ADD COLUMN category_id TEXT REFERENCES categories(id)` mantendo `product_category` para compatibilidade. Criar trigger `BEFORE INSERT/UPDATE` que, se `category_id` estiver presente, atualiza `product_category` com `categories.name`. Essa fase só acontece após estabilização do CRUD e UI dinâmica.


## RPCs (opcionais, para operações seguras em massa)

- `rename_category_and_retag_skus(old_name TEXT, new_name TEXT)`
  - Atualiza nome da categoria e faz `UPDATE skus SET product_category = new_name WHERE product_category = old_name` dentro de uma transação.
  - Garante consistência em renomeações sem exigir `category_id` (útil enquanto estamos em modo compatibilidade TEXT).
- `get_categories(search_term TEXT, only_active BOOLEAN)`
  - Conveniência para paginação/filtragem se necessário.


## Service Layer e Adapter

- __Novo arquivo__: `src/features/inventory/services/supabase/category.service.ts`
  - Funções:
    - `getCategories({ active?, searchTerm? }): Promise<UICategory[]>`
    - `createCategory({ name, description?, sortOrder? }): Promise<UICategory>`
    - `updateCategory(id, { name?, description?, active?, sortOrder? }): Promise<UICategory>`
    - `deleteCategory(id): Promise<void>` (soft delete = `active = false`)
    - `renameCategory(oldName, newName): Promise<{ updatedSkus: number }>` (se optarmos por RPC)
  - Tipos UI: `UICategory = { id: string; name: string; active: boolean; description?: string; sortOrder?: number }`.

- __Adapter__: `src/features/inventory/services/inventory.adapter.ts`
  - `export const categoryOperations = { getAll, create, update, delete, rename }` espelhando o padrão de `vendorOperations`.


## UI/UX — Manage Categories Modal

- __Acesso__: botão “Manage Categories” ao lado de “Add SKU” no header de `SKUsModal` (em `Wireframe.tsx`).
- __Componente novo__: `CategoriesManager` (padrão semelhante a `VendorsManager`/`SKUsManager`)
  - Lista com tabela: colunas `Name`, `Active`, `Sort`, `Actions`.
  - Form simples para `Name` (obrigatório), `Description` (opcional), `Active` (toggle), `Sort order` (opcional).
  - __Validações__: nome obrigatório, único (feedback de unicidade), evitar leading/trailing whitespace.
  - __Delete__: soft delete (marca `active = false`). Se desejado, bloquear exclusão quando existirem SKUs vinculados por `product_category = name` (checagem feita na service antes de desativar) e sugerir renomear ou reclassificar SKUs.
  - __A11y__: roles/aria, foco no primeiro campo, `ESC` para fechar (consistente com modais existentes).
  - __Feedback__: `toast.success/error` alinhado ao restante da aplicação.


## Droplist dinâmica no Add/Edit SKU

- Substituir `CATEGORY_OPTIONS` (constante em `Wireframe.tsx`, linha ~246) por uma fonte dinâmica:
  - `categoryOperations.getAll({ active: true })` com cache de 5 min (memória) + backup em `localStorage`.
  - Invalidação de cache após `create/update/delete` no `CategoriesManager`.
  - __Feature flag__: 
    - `if (!getFeatureFlag('INVENTORY_CATEGORIES'))` → usar `CATEGORY_OPTIONS` atual (fallback).
    - `if (getFeatureFlag('INVENTORY_CATEGORIES'))` → usar lista do backend.
  - __Resiliência__: no caso de falha de rede/Supabase, fazer fallback temporário para `CATEGORY_OPTIONS` e exibir aviso não-intrusivo.


## Fases de implementação (sequência segura)

- __F0 — Planejamento e aceite__
  - Alinhar critérios de aceite e escopo.
  - Habilitar flag `INVENTORY_CATEGORIES` somente em DEV.

- __F1 — Banco (não-disruptivo)__
  - Criar migração `038_add_categories_table.sql` com tabela, índices e RLS.
  - Seed/backfill a partir de `DISTINCT skus.product_category`.
  - Sem alterações em `skus` nesta fase.

- __F2 — Service Layer + Adapter__
  - Implementar `category.service.ts` e `categoryOperations` no `inventory.adapter.ts`.
  - Adicionar tipagens `UICategory` e regenerar `types/supabase` caso necessário.

- __F3 — UI Modal “Manage Categories” atrás de feature flag__
  - Criar `CategoriesManager` (CRUD completo com validações e soft delete).
  - Integrar botão “Manage Categories” no header do `SKUsModal`.
  - Cache (memória/LS) para lista de categorias.

- __F4 — Integrar droplist de Category no formulário de SKU__
  - Trocar `CATEGORY_OPTIONS` por fonte dinâmica condicionada à flag.
  - Invalidação de cache quando CRUD de categorias ocorrer.
  - Fallback robusto para a constante atual em caso de erro.

- __F5 — Renomeação segura (opcional)__
  - Adicionar RPC `rename_category_and_retag_skus` para atualizar `skus.product_category` em massa dentro de transação.
  - UI: expor ação de renomear com confirmação clara e preview (quantos SKUs serão afetados).

- __F6 — Guard-rails e observabilidade__
  - Bloquear delete se houver SKUs ativos na categoria (opcional) ou exigir confirmação explícita que não atualizará SKUs automaticamente.
  - Logs de auditoria (mínimo: console + toasts; avançado: tabela de auditoria similar à já usada para movements — opcional futuro).

- __F7 — Testes__
  - Unit (service/adapter): CRUD, filtros, erros de unicidade.
  - Integração (UI): criar/editar/desativar, droplist reflete mudanças, cache invalida.
  - A11y: foco, labels, navegabilidade por teclado.

- __F8 — Rollout__
  - DEV: habilitar flag, testes end-to-end.
  - STG: habilitar flag para grupo restrito; monitorar erros/latência.
  - PROD: habilitar flag gradualmente. Plano de rollback: desabilitar flag → UI volta ao fallback sem impacto no fluxo de SKUs.

- __F9 — Evolução (P2, opcional)__
  - Adicionar `skus.category_id` (FK) e gatilho para manter `product_category` sincronizado com `categories.name` (compatibilidade).
  - Backfill de `category_id` a partir de match pelo nome.
  - Atualizar services para priorizar `category_id` quando disponível.
  - Após estabilização, avaliar deprecar `product_category` TEXT (somente se não houver mais consumidores antigos).


## Critérios de aceite

- __CA-01__: Botão “Manage Categories” visível no header do `SKUsModal` e abre modal de gerenciamento.
- __CA-02__: Usuário consegue criar, editar e desativar categorias com validações adequadas.
- __CA-03__: Droplist “Category” no Add/Edit SKU é dinâmica quando a flag `INVENTORY_CATEGORIES` está ativada e reflete o CRUD imediatamente.
- __CA-04__: Com a flag desativada ou em erro de rede, o sistema usa a lista estática atual sem quebrar o fluxo.
- __CA-05__: Banco com nova tabela `categories` e RLS, sem alterações em `skus` na fase inicial.


## Riscos e mitigação

- __Renomear categorias e SKUs ficarem com textos divergentes__
  - Mitigação: fase F5 com RPC de renomeação em massa; fase F9 com `category_id` + trigger de sincronização.

- __Exclusão de categoria em uso__
  - Mitigação: soft delete e/ou bloqueio com mensagem explicativa; opção de renomear em vez de excluir.

- __Sobrecarga de requisições para droplist__
  - Mitigação: cache em memória + `localStorage` com TTL; invalidação no CRUD.

- __Mudanças disruptivas involuntárias__
  - Mitigação: feature flag em todas as integrações de UI; fases F1–F4 não tocam `skus`.


## Rollback

- Desabilitar a flag `INVENTORY_CATEGORIES` reverte imediatamente a UI para o fallback estático.
- A tabela `categories` pode permanecer sem impacto no fluxo.
- Se a fase F5 (renomeação em massa) for aplicada, o rollback inclui script de restauração (backup/SQL reverso) — executar apenas após verificação.


## Apêndice A — Esboço de DDL (referência)

```sql
-- 038_add_categories_table.sql (esboço)
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT UNIQUE,
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  sort_order INT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_categories_active ON categories(active);
-- Opcional: para busca por nome
-- CREATE INDEX idx_categories_name_trgm ON categories USING gin(name gin_trgm_ops);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for authenticated users" ON categories
  FOR ALL USING (auth.role() = 'authenticated');

-- Seed inicial (backfill a partir de SKUs)
-- INSERT INTO categories (id, name)
-- SELECT LOWER(REPLACE(product_category, ' ', '-')) AS id, product_category AS name
-- FROM skus
-- WHERE product_category IS NOT NULL
-- GROUP BY product_category
-- ON CONFLICT (id) DO NOTHING;
```


## Apêndice B — Esboço de interface de serviço (TS)

```ts
// src/features/inventory/services/supabase/category.service.ts
export type UICategory = {
  id: string;
  name: string;
  active: boolean;
  description?: string;
  sortOrder?: number;
};

export async function getCategories(params?: { active?: boolean; searchTerm?: string }): Promise<UICategory[]> { /* ... */ }
export async function createCategory(input: { name: string; description?: string; sortOrder?: number }): Promise<UICategory> { /* ... */ }
export async function updateCategory(id: string, updates: Partial<UICategory>): Promise<UICategory> { /* ... */ }
export async function deleteCategory(id: string): Promise<void> { /* ... */ }
export async function renameCategory(oldName: string, newName: string): Promise<{ updatedSkus: number }> { /* ... */ }
```


## Próximos passos

1) Aprovar este plano.
2) Executar F1 em DEV (migração + seed/backfill) e regenerar tipos do Supabase.
3) Implementar F2–F4 atrás da feature flag e validar em DEV.
4) Testar e rolar para STG/PROD com rollback pronto.
