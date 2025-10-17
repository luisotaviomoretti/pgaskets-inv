# Plano Faseado: Incluir Vendor no Receiving (pgasketsinv-final)

Este documento descreve um plano detalhado, em fases, para garantir que a informação de `Vendor` seja persistida quando um Receiving é finalizado, mantendo a arquitetura atual (Supabase-first), sem mudanças disruptivas e preservando a integridade e a funcionalidade do sistema. O Receiving pode conter múltiplos SKUs, e esse cenário é explicitamente coberto.


## Objetivo
- Persistir o `vendor_id` no registro de `movements` para movimentos do tipo `RECEIVE`, além de continuar persistindo em `fifo_layers`.
- Garantir que a UI e os serviços existentes passem a exibir o `vendor_name` de forma consistente no histórico de movimentos e em relatórios, sem quebrar fluxos atuais.


## Estado atual (resumo)
- Tabelas:
  - `fifo_layers` já possui `vendor_id` (FK para `vendors`).
  - `movements` (schema inicial em `supabase/migrations/001_initial_schema.sql`) não possui `vendor_id`.
- RPCs/Functions:
  - `create_receiving_transaction` aceita `p_vendor_id` e grava em `fifo_layers.vendor_id`, mas não preenche `movements.vendor_id` (vide `009`/`010`).
  - `get_movements_filtered` (ver `022_update_procedures_for_soft_delete.sql`) já faz `LEFT JOIN vendors v ON m.vendor_id = v.id` para expor `vendor_name`, assumindo a existência de `movements.vendor_id`.
- Frontend/Services:
  - `movement.service.ts` já:
    - Converte `vendorName` em `vendorId` via `createOrGetVendorByName()`.
    - Chama a RPC `create_receiving_transaction` passando `p_vendor_id`.
    - Consome `get_movements_filtered` e mapeia `vendor_name` para o UI (`vendor`).
  - `Receiving.tsx` processa Receiving multi-SKU chamando `processReceiving()` por linha com `sharedFields.vendor` (um único Vendor por batch).

Conclusão: precisamos apenas consolidar no banco a coluna `movements.vendor_id` e ajustar a RPC para preenchê-la. UI/serviços já estão praticamente prontos para exibir Vendor.


## Princípios de implementação
- Sem rupturas: nenhuma mudança de contrato no frontend.
- Backwards-compatible: colunas novas como `NULL` por padrão; backfill seguro e idempotente.
- Transacional e íntegro: updates em RPCs feitos com cuidado; validações preservadas.
- Observabilidade: queries de verificação e checklist de rollout.


## Fases (F0 → F8)

### F0 — Alinhamento e verificação (não disruptivo)
- Revisar em Supabase (DEV) se a coluna `movements.vendor_id` já existe. Caso positivo, pular a F1 e ajustar plano para apenas F2+.
- Confirmar que `get_movements_filtered` está publicado e acessível.
- Confirmar que `fifo_layers.created_by_movement_id` existe para suportar backfill (migr. 014/015).

Artefatos de verificação sugeridos (consultas apenas):
- Verificar coluna:
  ```sql
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'movements' AND column_name = 'vendor_id';
  ```
- Verificar link das camadas:
  ```sql
  SELECT COUNT(*) FROM fifo_layers WHERE created_by_movement_id IS NOT NULL;
  ```


### F1 — Migração de schema: adicionar movements.vendor_id (FK) + índice
- Adicionar coluna `vendor_id TEXT REFERENCES vendors(id)` em `movements` com `DEFAULT NULL`.
- Criar índice para consulta por vendor: `CREATE INDEX idx_movements_vendor ON movements(vendor_id);`
- Observações:
  - Usar `IF NOT EXISTS` quando aplicável para idempotência.
  - Não marcar como `NOT NULL` (há histórico sem vendor em movimentos).

Riscos mitigados:
- Como a coluna é opcional, não quebra inserts existentes para tipos de movimento que não têm vendor (ISSUE, WASTE, PRODUCE, ADJUSTMENT).


### F2 — Atualizar RPC `create_receiving_transaction` para preencher movements.vendor_id
- No `INSERT INTO public.movements (...)` da RPC, incluir a coluna `vendor_id` com o valor `p_vendor_id` (pode ser `NULL`).
- Manter toda a lógica atual (cálculo de `v_total_value`, criação da camada FIFO, sync de `on_hand` via função/trigger).
- Garantir que a assinatura da função permaneça igual (mesmos parâmetros), preservando o contrato do frontend.

Notas:
- Em `010_fifo_layer_based_validation.sql`, a função foi reescrita removendo update manual de `on_hand` e passando a sincronizar via layers; seguir a versão mais recente e apenas incluir `vendor_id` no `INSERT` de `movements`.


### F3 — Backfill seguro de movements.vendor_id (histórico)
- Objetivo: preencher `movements.vendor_id` para movimentos `RECEIVE` existentes.
- Estratégia
  1) Preferencial: usar `fifo_layers.created_by_movement_id`:
     ```sql
     UPDATE movements m
     SET vendor_id = fl.vendor_id
     FROM fifo_layers fl
     WHERE fl.created_by_movement_id = m.id
       AND m.type = 'RECEIVE'
       AND m.vendor_id IS NULL
       AND fl.vendor_id IS NOT NULL;
     ```
  2) Heurística (apenas quando 1) não encontrar correspondência):
     - Match por `(sku_id, quantity, unit_cost)` e janela de tempo próxima de `m.created_at`/`m.datetime` (±1 minuto), replicando a mesma heurística já usada em `reverse_movement`.
     - Em caso de múltiplas correspondências, não preencher automaticamente; registrar em relatório para decisão manual.

- Relatório de backfill (sugestão):
  - Criar uma consulta que liste movimentos `RECEIVE` ainda sem `vendor_id` após o passo preferencial, indicando possíveis camadas candidatas e score de heurística.

- Idempotência: rodar o backfill sem efeitos colaterais caso seja reexecutado.


### F4 — Views/RPCs de consulta
- `get_movements_filtered` (022) já realiza join por `m.vendor_id`. Após a F1+F3, passará a retornar `vendor_name` também para históricos, na medida do backfill.
- `movement_history` (views) pode, opcionalmente, incluir `vendor_name` se necessário em listas simples futuras. Não é obrigatório para este escopo, pois os serviços já usam a RPC de listagem.


### F5 — Frontend/Services (nenhuma mudança disruptiva)
- `src/features/inventory/services/supabase/movement.service.ts`
  - `createReceiveMovement`: já cria/obtém Vendor e envia `p_vendor_id` para a RPC.
  - `getMovements`: consome `get_movements_filtered` e mapeia `vendor_name` para UI.
  - `mapMovementRowToUI`: já suporta `vendors (name)` quando o select é feito direto na tabela (FK).
- `Receiving.tsx`:
  - Fluxo multi-SKU com `sharedFields.vendor` (um Vendor por batch): permanece inalterado. Para cada linha com `receiveQty > 0`, chama `processReceiving()` usando o mesmo vendor.
  - Movimentos de `DAMAGE`: não exigem `vendor_id`; continuam independentes (sem ruptura).

Nenhuma alteração de contrato no frontend é necessária para este escopo.


### F6 — Testes (DEV)
- Casos de teste principais:
  - Receiving de 1 SKU com Vendor novo (criado via `createOrGetVendorByName`):
    - Verificar `movements.vendor_id` preenchido.
    - Verificar `fifo_layers.vendor_id` preenchido.
    - `get_movements_filtered` retorna `vendor_name`.
  - Receiving multi-SKU (2+ linhas) com o mesmo Vendor:
    - Para cada linha com `receiveQty > 0`, verificar `movements.vendor_id`.
    - Verificar camadas FIFO e `on_hand` sincronizados.
  - Receiving com dano parcial (linha com `receiveQty > 0` e `damageQty > 0`):
    - `RECEIVE`: com `vendor_id`.
    - `DAMAGE`: sem `vendor_id` (esperado), checar notas.
  - Histórico existente (pré-migração):
    - Após backfill, verificar amostras de `RECEIVE` com `vendor_id` preenchido e `vendor_name` retornando.
    - Registros ambíguos devem constar no relatório.
  - Reversão/Exclusão:
    - `reverse_movement` e `delete_movement` não devem falhar por causa de `vendor_id` (agora presente no tipo record de `movements`).

- Consultas de verificação:
  ```sql
  -- % de RECEIVES com vendor_id preenchido
  SELECT COUNT(*) FILTER (WHERE type = 'RECEIVE') as total_receives,
         COUNT(*) FILTER (WHERE type = 'RECEIVE' AND vendor_id IS NOT NULL) as receives_with_vendor
  FROM movements;

  -- Amostra de movimentos com vendor_name via RPC
  SELECT * FROM get_movements_filtered(NULL, NULL, NULL, NULL, FALSE, 20, 0);
  ```


### F7 — Rollout (STG → PROD)
- Checklist:
  - Executar F1 (migração) e F2 (atualização da RPC) em janela segura.
  - Executar F3 (backfill) e revisar relatório de ambiguidade.
  - Sanidade: executar consultas de verificação.
  - Validar UI de Movements (vendor exibido).
- Rollback:
  - A coluna a mais (`vendor_id`) é inócua; rollback preferencial é reverter a versão da função `create_receiving_transaction` temporariamente (sem gravar `vendor_id`) se necessário, mantendo integridade.
  - Caso haja problema crítico, reverter a migração (down) somente em janelas controladas, pois há dependências (RPCs de leitura podem referenciar a coluna).


### F8 — Documentação e handoff
- Atualizar README interno de Inventário com:
  - Campos adicionados a `movements`.
  - Nota sobre backfill e como rerodar (idempotente).
  - Observações sobre consultas e joins com vendors.


## Riscos conhecidos e mitigação
- Funções antigas inconsistentes (ex.: `create_movement` em `003_transaction_functions.sql` que usa `movement_date`/`reference_doc`/`vendor_id`):
  - Não são usadas pelo fluxo atual de Receiving (usamos `create_receiving_transaction`).
  - Mitigação: manter como legado por ora; avaliar deprecação/ajuste em sprint específica futura.
- Ambiguidade no backfill para históricos muito antigos sem `created_by_movement_id`:
  - Mitigação: heurística conservadora + relatório para decisão manual.
- Soft delete e auditoria:
  - Já compatíveis: funções de deleção/reversão consideram record `movements` e não devem quebrar com nova coluna.


## Critérios de aceite
- Criar Receiving (1 SKU) com Vendor:
  - `movements.vendor_id` preenchido; `get_movements_filtered` retorna `vendor_name`.
- Criar Receiving multi-SKU com Vendor único:
  - Todas as linhas `RECEIVE` persistem `vendor_id` corretamente.
- Histórico pré-migração:
  - Backfill preenche `vendor_id` na maior parte dos casos; itens remanescentes listados em relatório.
- Nenhuma quebra nos fluxos de ISSUE/WASTE/PRODUCE/ADJUSTMENT, reversão e soft delete.


## Escopo futuro (não incluído neste plano)
- RPC de Receiving em batch (multi-SKU atômico) para garantir atomicidade entre linhas do mesmo recebimento.
- Expor `vendor_name` também em `movement_history` (quando for conveniente) para dashboards simples.
- Deprecar/ajustar `create_movement` (003) para alinhar nomenclaturas com `movements` atuais.


## Resumo
Este plano adiciona `vendor_id` diretamente em `movements` e faz o ajuste mínimo necessário na RPC de Receiving, mantendo todos os fluxos atuais intactos. O backfill seguro e idempotente garante histórico consistente, e a UI passa a exibir `vendor_name` sem qualquer mudança de contrato no frontend. O rollout segue DEV → STG → PROD com checklist e verificação de sanidade, obedecendo o princípio de não causar mudanças disruptivas na arquitetura existente.
