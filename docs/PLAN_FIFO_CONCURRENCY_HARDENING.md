# Plano de Endurecimento Contra Corridas (FIFO) — Seguro, Diligente e Não‑Disruptivo

Este documento define um plano faseado, seguro e não disruptivo para endurecer o consumo FIFO contra condições de corrida em `pgasketsinv-final`, mantendo a arquitetura atual (Supabase‑first) e a integridade funcional do sistema.


## Princípios

- **Segurança e não-disrupção**: alterações mínimas, reversíveis e compatíveis com o fluxo atual.
- **Sequência lógica e auditável**: cada fase tem pré‑condições, checklists, critérios de aceite e rollback.
- **Integridade acima de tudo**: preservar invariantes FIFO e constraints (`positive_stock`, limites de camadas) em todas as etapas.
- **Transparência**: instrumentar e observar antes de endurecer; aplicar bloqueios de forma consciente; preparar retry/idempotência.


## Contexto atual (recapitulação com referências)

- Tabelas e constraints:
  - `public.skus.on_hand` com `CHECK (on_hand >= 0)` — definido em `supabase/migrations/001_initial_schema.sql`.
- Triggers/funcões relevantes:
  - `public.update_sku_on_hand()` — redefinido em `supabase/migrations/020_fix_on_hand_trigger.sql` para sincronizar `on_hand` a partir de camadas, ignorando `WASTE/PRODUCE`.
- RPCs e funções FIFO:
  - `public.create_work_order_transaction(...)` — ver `supabase/migrations/013_waste_excluded_from_on_hand.sql` (WASTE não consome camadas; pré-validação de estoque por SKU).
  - `public.execute_fifo_consumption_validated(p_sku_id, p_quantity_needed, p_movement_id)` — ver `supabase/migrations/009_fifo_consistency_enforcement.sql` e `010_fifo_layer_based_validation.sql`.
  - `public.update_layer_quantity(p_layer_id, p_quantity_change)` — ver `supabase/migrations/006_update_layer_quantity.sql`.
  - `public.get_available_from_layers(sku_id)` e `public.sync_sku_on_hand_from_layers(...)` — ver `supabase/migrations/010_fifo_layer_based_validation.sql`.
- Consistência e auditoria:
  - `public.validate_fifo_consistency()` — ver `supabase/migrations/013_waste_excluded_from_on_hand.sql`.
  - Auditoria de deleção de movimentos — ver memória do projeto (funções `reverse_movement`, `delete_movement`, etc.).

Observação: as versões atuais de `execute_fifo_consumption_validated` não usam `SELECT ... FOR UPDATE` nas camadas FIFO.


## Riscos que queremos mitigar

- Conflitos entre **pré‑validação** e **consumo** (janela de corrida), gerando inconsistência ou violações de constraint.
- **Atualizações concorrentes** no mesmo conjunto de camadas (`fifo_layers`) para um mesmo SKU.
- **Erros intermitentes** (e.g. `positive_stock`, `serialization_failure`, `deadlock`) em horários de pico.


## Fase 0 — Baseline & Auditoria (produção)

Pré‑condições:
- Acesso ao Supabase SQL Editor do ambiente alvo.

Checklist:
- Verificar se as migrações essenciais estão aplicadas:
  - `013_waste_excluded_from_on_hand.sql`
  - `020_fix_on_hand_trigger.sql`
- Conferir definições atuais (produzir dump para anexar a este plano):

```sql
-- Ver definições instaladas
SELECT pg_get_functiondef('public.update_sku_on_hand()'::regprocedure);
SELECT pg_get_functiondef('public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb)'::regprocedure);
SELECT pg_get_functiondef('public.execute_fifo_consumption_validated(text, numeric, integer)'::regprocedure);
SELECT pg_get_functiondef('public.update_layer_quantity(text, numeric)'::regprocedure);
```

- Auditorias rápidas:
```sql
-- 1) WASTE não deve ter layer_consumptions
SELECT COUNT(*) AS waste_consumptions
FROM layer_consumptions lc
JOIN movements m ON m.id = lc.movement_id
WHERE m.type = 'WASTE';

-- 2) SKUs com on_hand negativo (deveria ser 0)
SELECT id, on_hand FROM skus WHERE on_hand < 0;

-- 3) Validação de consistência
SELECT * FROM public.validate_fifo_consistency() WHERE status <> 'CONSISTENT';
```

Critérios de aceite para avançar:
- 013 e 020 confirmados.
- Sem WASTE consumindo camadas.
- Sem `on_hand < 0` (se houver, registrar e tratar na Fase 5).
- Relatório de consistência compreendido (pode haver casos legados; não bloqueia avanço, mas será acompanhado).

Rollback:
- Nenhum — fase apenas de leitura/diagnóstico.


## Fase 1 — Observabilidade mínima (sem alterações de código)

Objetivo:
- Medir incidência de problemas antes de aplicar bloqueios.

Checklist:
- Mapear e acompanhar erros SQL por código:
  - `23514` (check constraint)
  - `40001` (serialization_failure)
  - `40P01` (deadlock_detected)
  - `55P03` (lock_not_available)
- Monitorar diariamente (em janelas de pico) os relatórios:
```sql
SELECT * FROM public.validate_fifo_consistency() WHERE status <> 'CONSISTENT';
SELECT id, on_hand FROM skus WHERE on_hand < 0;
```

Critérios de aceite:
- Base de incidência registrada para comparação pós‑mudança.

Rollback:
- Não aplicável.


## Fase 2 — Projeto de Locking (POC em staging)

Objetivo:
- Introduzir **bloqueio de linhas** das camadas FIFO durante o consumo para eliminar corridas, preservando FIFO estrito.

Alternativas avaliadas:
- `FOR UPDATE SKIP LOCKED`: evita espera, mas pode violar FIFO estrito (pula camadas mais antigas). Não recomendado.
- `FOR UPDATE`: mantém a ordem FIFO, permitindo espera pelo lock. Recomendado.
- `FOR UPDATE NOWAIT` + retry: falha rápida e permite retry controlado. Bom para evitar deadlocks e manter responsividade.

Proposta:
- Ajustar o cursor/loop de `execute_fifo_consumption_validated` para:
  - Selecionar camadas com `FOR UPDATE` (ou `FOR UPDATE NOWAIT` caso adotemos retry).
  - Ex.:

```sql
FOR v_layer IN
  SELECT id, remaining_quantity, unit_cost
  FROM public.fifo_layers
  WHERE sku_id = p_sku_id
    AND status = 'ACTIVE'
    AND remaining_quantity > 0
  ORDER BY receiving_date, created_at
  FOR UPDATE  -- ou FOR UPDATE NOWAIT
LOOP
  -- consumo
END LOOP;
```

- Reforçar a atualização da camada com verificação otimista:

```sql
-- garantir que não consumimos além do restante sob concorrência
UPDATE public.fifo_layers
SET remaining_quantity = remaining_quantity - v_consume_qty,
    last_movement_at = NOW()
WHERE id = v_layer.id
  AND remaining_quantity >= v_consume_qty;

IF NOT FOUND THEN
  RAISE EXCEPTION 'Concurrent consumption exceeded remaining for layer %', v_layer.id
    USING ERRCODE = '40001'; -- ou 23514, a definir
END IF;
```

- Manter inserção em `layer_consumptions` + trigger `validate_layer_consumption` como linha adicional de defesa.

Checklists (staging):
- Testar concorrência com 10–50 processos em paralelo consumindo o mesmo SKU.
- Medir tempo médio, erros `40001/55P03/40P01` e garantir ausência de violações FIFO.

Critérios de aceite:
- Nenhum `positive_stock` e nenhuma violação de invariantes.
- Erros de concorrência reduzidos a 0–aceitável com retry (próx. fase).

Rollback:
- Reverter função `execute_fifo_consumption_validated` para definição anterior (DDL versionada).


## Fase 3 — Estratégia de Retry & Idempotência (staging → produção)

Retry (não disruptivo):
- Cliente (`src/features/inventory/services/supabase/workorder.service.ts`): capturar erros `40001`, `55P03`, `40P01` e **tentar novamente** a RPC `create_work_order_transaction` com backoff exponencial (p.ex., 100ms, 200ms, 400ms; máx 3 tentativas). Transparente ao front.
- Alternativa: retry dentro do RPC (PL/pgSQL) com bloco `BEGIN ... EXCEPTION WHEN lock_not_available/serialization_failure THEN PERFORM pg_sleep(...); RETRY;` — somente se necessário.

Idempotência:
- O front já usa referência estável `woRef` (Work Order code). Recomenda‑se:
  - Chave única em `work_orders.id` (já é PK) e, opcionalmente, em `movements.reference` para o mesmo `work_order_id`.
  - Em caso de retry após falha, se `work_order` já existir, retornar dados existentes em vez de recriar.

Critérios de aceite:
- Em cenários forçados de concorrência, a experiência do usuário permanece estável; operação conclui após 0–2 retries.

Rollback:
- Desativar retry no cliente (flag/commit reversível). Nenhuma mudança de contrato.


## Fase 4 — Pré‑validação com travamento antecipado (opcional, avançado)

Objetivo:
- Reduzir a janela entre pré‑validação e consumo.

Estratégia:
- No RPC `create_work_order_transaction`, antes de processar materiais, efetuar uma *passagem de pré‑lock* nas camadas necessárias (consulta consolidada por SKU com `FOR UPDATE`), garantindo que a pré‑validação e o consumo aconteçam sob o mesmo conjunto de locks.
- Aplicar com cuidado (pode aumentar tempo de retenção de locks). Priorizar Fase 2 + 3; usar Fase 4 apenas se métricas apontarem necessidade.


## Fase 5 — Reparos e saneamento de dados (one‑off)

Quando necessário (legado):

```sql
-- Sincronizar on_hand a partir das camadas
SELECT public.sync_all_skus_on_hand();

-- Conferir novamente consistência
SELECT * FROM public.validate_fifo_consistency() WHERE status <> 'CONSISTENT';
```

- Se houver SKUs críticos, executar correções pontuais (recebimentos de ajuste, revisões manuais de camadas) conforme processo já praticado.


## Fase 6 — Rollout controlado

- Dev: aplicar e validar local.
- Staging: carga concorrente sintética (matriz de testes abaixo).
- Produção: janela de baixo tráfego, canário (ex.: 1–2 WO/min), observando métricas.
- Feature Flags/Flags operacionais: se for preciso adotar `FOR UPDATE NOWAIT`, manter um flag de retry habilitado no cliente enquanto medimos.

Critérios de aceite para concluir rollout:
- 0 violações de constraint (`positive_stock`).
- `validate_fifo_consistency()` consistente após operações concorrentes reais.
- Erros `40001/55P03/40P01` em níveis esporádicos e tratados por retry.

Rollback geral:
- Substituir `execute_fifo_consumption_validated` pela versão anterior (DDL armazenada).
- Desativar retry no cliente.


## Fase 7 — Matriz de Testes de Concorrência

Cenários (staging):
- __ISSUE x ISSUE (mesmo SKU)__: 10–50 requisições simultâneas contra o mesmo SKU.
- __ISSUE x WASTE (mesmo SKU)__: WASTE não deve consumir camadas nem travar; medir impacto.
- **Múltiplos WOs com SKUs distintos**: garantir ausência de contenção indevida.
- **Múltiplos WOs com muitos SKUs**: medir latência e observar locks.

Verificações pós‑execução:
- `validate_fifo_consistency()` sem divergências.
- Nenhum `on_hand < 0`.
- Logs de erro/feedback do cliente (retries) dentro do limite (<= 2 por operação, em média).


## KPIs & Observabilidade

- __Integridade__: 0 violações `positive_stock`; `validate_fifo_consistency()` consistente.
- __Conflitos__: contagem de `40001/55P03/40P01` por dia (deve cair x% após rollout).
- __Latência__: P50/P95 de `create_work_order_transaction` sob carga concorrente (aceitável dentro do SLA atual).
- __Retry__: média de tentativas por WO (objetivo <= 1.2).


## Apêndice — Códigos de erro úteis

- `23514` — Check constraint violation (ex.: `positive_stock`).
- `40001` — Serialization failure (retry recomendado).
- `40P01` — Deadlock detected (retry recomendado com backoff).
- `55P03` — Lock not available (usar NOWAIT + retry ou aguardar lock com timeout adequado).


## Notas finais

- Este plano mantém a arquitetura atual e é **transparente para o front** (alterações no banco via migração, com opção de retry no cliente para robustez adicional).
- Recomenda‑se versionar os DDLs e manter as versões anteriores das funções para rollback imediato.
