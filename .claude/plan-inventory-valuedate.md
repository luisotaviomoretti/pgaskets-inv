# Plano de Implementação — Correção de "Data de Valor" no Inventory Query

## Contexto e diagnóstico (confirmado em código + dados de produção)

A reclamação do cliente é **legítima**. O Inventory Query reconstrói o estoque pela **data de lançamento** (quando o registro foi digitado), não pela **data de valor/competência** (a data que o estoque representa). A investigação revelou **duas causas-raiz distintas**:

| # | Origem | Camadas | Sintoma | Data correta existe? |
|---|--------|---------|---------|----------------------|
| 1 | RECEIVE (recebimentos) | 60 | `movements.datetime = NOW()` em vez de `receiving_date` | ✅ Sim, em `fifo_layers.receiving_date` |
| 2 | Saldo inicial (INIT-*) | 120 (72% do estoque) | `receiving_date = 2026-03-12` (data do load) em vez de `2026-02-28` | ❌ Não — só no e-mail do cliente |

**Fatos-chave verificados:**
- Os 5 RPCs de consulta (049/050, 051, 052/053, 054, 055) posicionam cada camada no tempo por `COALESCE(m_create.datetime, l.created_at)` — **nunca** consultam `receiving_date`.
- Work Orders **já fazem certo**: gravam `movements.datetime` = data escolhida pelo usuário (`work_order_date` às 12:00). Confirmado em 044 e nos dados (100% das WO seguem a data do usuário). **Não serão tocadas.**
- O frontend de Receiving **já captura** a data do usuário e a envia como `p_receiving_date`. **Não precisa mudar.**
- Triggers em `movements` e `fifo_layers` são **seguros** para nossas operações: só reagem a mudanças de `deleted_at`/quantidade, não de data. Um UPDATE de `receiving_date` apenas re-sincroniza `on_hand` (que permanece idêntico, pois quantidades não mudam).
- A camada de serviço TS (`inventoryQuery.service.ts`) é um wrapper fino — repassa parâmetros, sem lógica de data. **Não precisa mudar.**

## Decisões do usuário (registradas)

1. **Abordagem:** correção **na leitura** (alterar os RPCs), por ser a de menor risco — não reescreve nenhum dado histórico de recebimentos.
2. **Saldo inicial:** corrigir os dados das 120 camadas INIT-* para **`2026-02-28`** (data de valor confirmada).
3. **Validação:** **paridade do on-hand atual** (deve permanecer idêntico ao `skus.on_hand` de hoje) + snapshot dos casos do cliente.

## Princípio unificador da solução

Trocar a âncora temporal dos RPCs de consulta de **data de lançamento** para **data de valor**, definida como:

```
data_de_valor(camada) = fifo_layers.receiving_date    -- vale para RECEIVE *e* INIT
data_de_valor(consumo) = movements.datetime            -- já é a data de valor (WO usa data do usuário)
```

Para `receiving_date`, isso resolve **ambas** as causas pela mesma via:
- Os 60 RECEIVE passam a aparecer na data que o usuário digitou.
- As 120 INIT, após a correção de dados (Fase 4), passam a aparecer em 28/02.

> **Por que a data de valor da camada é `receiving_date` e o consumo continua `datetime`:** consumos (ISSUE/WASTE/PRODUCE) vêm de Work Orders, que já gravam `datetime` na data escolhida pelo usuário. Logo `datetime` **já é** a data de valor do consumo. Não há assimetria real — apenas usamos, para cada lado, a coluna que carrega a data de valor.

## Tratamento de hora-do-dia e ordenação FIFO (sutileza crítica)

Hoje o gate é `origin_ts < ts_end_of_day` (timestamp completo). Ao migrar para `receiving_date` (um `date`), precisamos comparar **data com data**:

```
-- ANTES:  COALESCE(m_create.datetime, l.created_at) < end_of_day(D)
-- DEPOIS: l.receiving_date <= D            (D = p_target_date no fuso)
```

Para preservar a **ordem FIFO determinística** dentro do mesmo dia (quando várias camadas têm a mesma `receiving_date`), o desempate continua por `COALESCE(m_create.datetime, l.created_at)` e depois `l.id`. Isso mantém a ordem de consumo idêntica à atual.

Para **consumos**, o gate permanece `mc.datetime < end_of_day(D)` — inalterado, pois já é data de valor.

## Estratégia de segurança (transversal a todas as fases)

- **Migrations idempotentes** (`CREATE OR REPLACE`), uma por arquivo numerado (056+), espelhando o padrão existente. Cada uma preserva assinatura, tipo de retorno, atributos `STABLE`/`SECURITY DEFINER` e grants.
- **Reversibilidade:** qualquer RPC reverte com um novo `CREATE OR REPLACE` restaurando a versão anterior. A correção de dados (Fase 4) terá **backup explícito** das 120 linhas + script de rollback.
- **Validação antes/depois em cada fase** que altera comportamento: capturar baseline → aplicar → comparar.
- **Invariante de ouro:** o `on_hand` de **hoje** (`get_inventory_snapshot_as_of(CURRENT_DATE)`) deve permanecer **bit-a-bit idêntico** ao atual após todas as fases. Mudamos só *onde no tempo* o estoque aparece, nunca *quanto* existe agora.
- **Aplicação via Supabase MCP** no projeto `errkjwfxrbkfajngshkn` (PGasketsINV), com `apply_migration` para DDL e verificação por `execute_sql`.
- Branch de trabalho git; commits atômicos por fase.

---

## FASE 0 — Baseline e rede de segurança (sem alterações funcionais)

**Objetivo:** congelar o estado atual como referência verificável e garantir rollback.

1. Criar branch git `fix/inventory-value-date`.
2. Capturar **baseline de paridade** (salvar como evidência):
   - `get_inventory_snapshot_as_of(CURRENT_DATE)` agregado: soma de on_hand e total_value, e por-SKU (hash/contagem).
   - Comparação `snapshot(hoje).on_hand` vs `skus.on_hand` por SKU (deve já bater hoje, salvo divergências de ADJUSTMENT já conhecidas).
   - Snapshot dos **casos do cliente**: `as of 2026-02-28` e `as of 2026-04-01` para o SKU exemplo `R35 2LB S82N G59-CH 1 X 54`, e o total de inventário `as of 2026-02-28` (hoje retorna ~0 para INIT; vai mudar na Fase 4).
3. **Backup** da coluna a ser alterada na Fase 4:
   - `CREATE TABLE _backup_init_receiving_date_20260605 AS SELECT id, sku_id, receiving_date FROM fifo_layers WHERE created_by_movement_id IS NULL;`
   - Confirmar 120 linhas.
4. Registrar contagens-âncora: 61 camadas linked, 120 orphan; 60 RECEIVE com lag de data.

**Critério de saída:** baseline salvo, backup criado e contado, branch pronta. Nenhuma função alterada.

---

## FASE 1 — RPC de snapshot por data de valor (migration 056)

**Objetivo:** `get_inventory_snapshot_as_of` posiciona camadas por `receiving_date`. É o coração do recurso.

1. Migration `056_inventory_query_snapshot_value_date.sql`:
   - No CTE `active_layers`: trocar o gate de origem para `l.receiving_date <= p_target_date` (comparação de data no fuso), mantendo as exclusões de movimento vivo (`deleted_at`/`reversed_at`) para camadas linked e a inclusão incondicional de orphans.
   - **Consumos inalterados** (`mc.datetime < end_of_day`).
   - Preservar assinatura, retorno, `STABLE`/`SECURITY DEFINER`, grants e o whitelist de `sort`.
   - Atualizar o `COMMENT` explicando a semântica de data de valor.
2. Aplicar via `apply_migration`.

**Verificação (antes de prosseguir):**
- **Paridade de hoje:** `snapshot(CURRENT_DATE)` agregado e por-SKU **idêntico** ao baseline da Fase 0. (Hoje, `receiving_date <= hoje` para todas as camadas vivas → mesmo conjunto.)
- **Caso do cliente (RECEIVE):** `as of 2026-04-01` para o SKU exemplo agora reflete a camada cujo `receiving_date = 2026-03-24` (deve subir vs. o baseline, que a omitia).
- Nenhum erro de permissão; função executável por `authenticated`.

**Rollback:** re-aplicar a definição da 050.

---

## FASE 2 — RPC de detalhe (drill-down) por data de valor (migration 057)

**Objetivo:** `get_sku_detail_as_of` consistente com o snapshot. Camadas e totais por `receiving_date`.

1. Migration `057_inventory_query_detail_value_date.sql`:
   - No CTE `active_layers`: mesmo gate `l.receiving_date <= p_target_date`.
   - O `ORDER BY` de exibição (`receiving_date, layer_origin_ts`) já está correto — manter.
   - `day_movements` (movimentos do dia do SKU): ver Fase 5 para a decisão de bucketing; nesta fase, manter por `datetime` e ajustar na Fase 5 junto com 055, **ou** alinhar já. **Decisão:** alinhar o bucketing de RECEIVE por `receiving_date` já aqui, para o drill-down do SKU bater com o snapshot. (Detalhe técnico na Fase 5.)
   - Preservar assinatura/grants/atributos. Atualizar COMMENT.
2. Aplicar.

**Verificação:**
- Paridade: `detail(SKU, CURRENT_DATE).totals.on_hand` == `snapshot(hoje)` para uma amostra de SKUs.
- Caso do cliente: `detail(R35..., 2026-04-01)` mostra a camada de 24/03 como ativa.

**Rollback:** re-aplicar 051.

---

## FASE 3 — RPCs de timeline por data de valor (migrations 058, 059)

**Objetivo:** alinhar as três funções de timeline ao novo princípio. São as que alimentam "Daily Inventory Timeline" (agregado) e o "Daily Timeline" por SKU.

1. Migration `058_inventory_query_sku_timeline_value_date.sql` — `get_sku_daily_timeline_as_of` (versão vigente = 053):
   - **`fifo_state`/`fifo_alive`** (closing_value/avg_cost): gate de camada por `l.receiving_date <= biz_date`.
   - **`closing_qty`** e os buckets de atividade do dia (`sku_movements`, `by_type`, `day_totals`): hoje por `m.datetime`. Para coerência, o **RECEIVE** deve ser bucketizado por `receiving_date`; demais tipos por `datetime` (já é data de valor). Implementar via `biz_date` derivado:
     `CASE WHEN m.type='RECEIVE' THEN layer.receiving_date ELSE (m.datetime AT TIME ZONE tz)::date END`
     (join à `fifo_layers` por `created_by_movement_id` para obter a `receiving_date` do RECEIVE).
   - Preservar assinatura/retorno/grants. COMMENT atualizado.
2. Migration `059_inventory_query_aggregate_timeline_value_date.sql` — `get_inventory_timeline_as_of` (054): mesma lógica (gate de camada por `receiving_date`; bucket de RECEIVE por `receiving_date`).
3. Aplicar ambas.

**Verificação:**
- Paridade: para um dia recente sem recebimentos retroativos, os valores de fechamento permanecem iguais ao baseline.
- O dia **2026-02-28** passa a exibir o saldo inicial (após Fase 4) — anotar para validar conjuntamente na Fase 4.
- Soma de `closing_value` do dia mais recente == `snapshot(hoje).total_value`.

**Rollback:** re-aplicar 053 e 054.

---

## FASE 4 — Correção de dados do saldo inicial (migration 060) ⚠️ FASE SENSÍVEL

**Objetivo:** corrigir `receiving_date` das 120 camadas INIT-* de `2026-03-12` → `2026-02-28`.

> Esta é a única fase que altera dados. É segura (triggers não reagem a mudança de data; on_hand recalculado é idêntico), mas tratada com rigor máximo.

1. **Pré-condições** (abortam se falharem):
   - Confirmar que `_backup_init_receiving_date_20260605` existe e tem 120 linhas.
   - Confirmar que **todas** as 120 INIT têm hoje `receiving_date = '2026-03-12'` (nenhuma exceção inesperada).
2. Migration `060_fix_init_layers_value_date.sql`:
   - `UPDATE fifo_layers SET receiving_date = '2026-02-28' WHERE created_by_movement_id IS NULL AND receiving_date = '2026-03-12';`
   - Envolver em `BEGIN/COMMIT` com verificação de contagem: a migration deve afetar **exatamente 120** linhas; caso contrário, `RAISE EXCEPTION` (rollback automático).
   - **Não** tocar `created_at`, quantidades, status ou qualquer outra coluna.
3. Aplicar.

**Verificação (crítica):**
- **Invariante de ouro:** `snapshot(CURRENT_DATE).on_hand` por SKU **idêntico** ao baseline da Fase 0 (a data mudou, mas o on-hand de hoje não — `28/02 <= hoje` e `12/03 <= hoje` ambos verdadeiros).
- **Caso do cliente:** `snapshot('2026-02-28')` agora **inclui** o saldo inicial (antes ~0). O total deve corresponder ao saldo físico carregado.
- `snapshot('2026-02-27')` deve mostrar o saldo inicial como **ausente** (valor anterior à data de competência) — fronteira correta.
- Contagem pós-UPDATE: 120 linhas com `receiving_date='2026-02-28'`, 0 remanescentes em `'2026-03-12'` entre orphans.

**Rollback (testado mentalmente, pronto para uso):**
`UPDATE fifo_layers f SET receiving_date = b.receiving_date FROM _backup_init_receiving_date_20260605 b WHERE f.id = b.id;`

---

## FASE 5 — Drill-down de movimentos do dia por data de valor (migration 061)

**Objetivo:** `get_movements_on_date` (055) — usado ao clicar num dia da timeline e nos exports Excel — deve listar o RECEIVE no seu **dia de valor**, coerente com o snapshot/timeline.

1. Migration `061_inventory_query_movements_on_date_value_date.sql`:
   - Derivar `biz_date` por movimento:
     `CASE WHEN m.type='RECEIVE' THEN l.receiving_date ELSE (m.datetime AT TIME ZONE tz)::date END`
     usando o join já existente a `fifo_layers` (linha 82 do 055).
   - Filtrar `WHERE biz_date = p_target_date` (em vez do range por `datetime`).
   - Manter ordenação interna e o resto da estrutura/grants. COMMENT atualizado.
2. Aplicar.

**Verificação:**
- Clicar (simular) no dia **2026-03-24**: o RECEIVE do SKU exemplo aparece nesse dia.
- O dia **da digitação** (ex.: 14/05) **não** lista mais aquele RECEIVE como movimento daquele dia.
- Export do dia: contagens batem com o que a timeline agregada informa para o mesmo dia.
- Soma cruzada: para um dia qualquer, `movements_on_date` é consistente com `aggregate_timeline` (mesmo `movement_count` por tipo).

**Rollback:** re-aplicar 055.

---

## FASE 6 — Validação integrada e regressão final

**Objetivo:** provar, de ponta a ponta, que (a) nada regrediu e (b) a reclamação foi sanada.

1. **Paridade global de hoje (invariante de ouro):** recomputar `snapshot(CURRENT_DATE)` agregado e por-SKU; comparar com baseline da Fase 0 → **diferença zero** (exceto o que mudou intencionalmente, que para *hoje* é nada).
2. **Reprodução dos casos do cliente:**
   - `as of 2026-02-28`: inventário inicial visível (corrige a queixa do saldo inicial).
   - SKU exemplo `as of 2026-04-01`: inclui a camada de 24/03 (corrige a queixa do recebimento).
   - Tabela antes/depois para o e-mail de resposta ao cliente.
3. **Consistência interna entre RPCs** (mesma data, mesmos números):
   - `snapshot` vs soma de `detail` por SKU.
   - `aggregate_timeline.closing_value(dia recente)` vs `snapshot(dia recente).total_value`.
4. **Coerência FIFO:** confirmar que a ordem de consumo e os custos médios de hoje não mudaram (amostra de SKUs com múltiplas camadas).
5. **Verificação de build do frontend:** `npm run build` (TypeScript) — garantir que nenhuma tipagem quebrou (esperado: zero mudanças no front, build limpo).
6. **Smoke test de permissões:** cada RPC executável por `authenticated`, revogado de `anon`.

**Critério de saída:** invariante de ouro mantido; casos do cliente corrigidos; RPCs mutuamente consistentes; build limpo.

---

## FASE 7 — Higiene e entrega

1. Commits atômicos por fase já realizados; mensagem final descreve a correção (causa, abordagem, validação).
2. **Limpeza opcional** (a confirmar com o usuário): manter `_backup_init_receiving_date_20260605` por um período de segurança; remover só após sign-off.
3. Resumo executivo para responder ao cliente (Henrique), com a tabela antes/depois.
4. **Não** fazer deploy/push automático — aguardar autorização explícita do usuário.

---

## Resumo dos artefatos a criar

| Migration | Função / Ação | Tipo | Reversão |
|-----------|---------------|------|----------|
| (Fase 0) | Backup + baseline | dados (tabela temp) | drop table |
| 056 | `get_inventory_snapshot_as_of` → receiving_date | DDL idempotente | re-aplica 050 |
| 057 | `get_sku_detail_as_of` → receiving_date | DDL idempotente | re-aplica 051 |
| 058 | `get_sku_daily_timeline_as_of` → receiving_date | DDL idempotente | re-aplica 053 |
| 059 | `get_inventory_timeline_as_of` → receiving_date | DDL idempotente | re-aplica 054 |
| 060 | UPDATE 120 INIT → 2026-02-28 | **dados** | backup → restore |
| 061 | `get_movements_on_date` → receiving_date | DDL idempotente | re-aplica 055 |

## O que NÃO será alterado (escopo protegido)
- Work Orders (RPC 044) — já gravam data de valor corretamente.
- RPC de recebimento (045) — abordagem "na leitura"; recebimentos futuros já têm `receiving_date` correto e os RPCs passam a usá-lo.
- Frontend (`InventoryQuery.tsx`, `inventoryQuery.service.ts`) — sem mudança funcional; só build de verificação.
- Quantidades, custos, `created_at`, status de camadas, e o `on_hand` atual.

## Riscos residuais e mitigação
- **Risco:** alguma consulta fora do Inventory Query depender do comportamento antigo. **Mitigação:** as 6 funções alteradas são exclusivas do Inventory Query (verificado por uso); WO/Receiving/Movements usam caminhos próprios.
- **Risco:** divergência de fronteira de fuso em `receiving_date` (date puro vs. timestamp). **Mitigação:** comparação date-a-date com `p_target_date` no fuso, testada nas fronteiras 27/28 fev.
- **Risco:** camadas INIT com `receiving_date` inesperado. **Mitigação:** Fase 4 aborta se a contagem ≠ 120.
