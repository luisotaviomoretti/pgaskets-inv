# Plano — UX de validação no Multi-SKU Receiving

> **Objetivo:** transformar o feedback de validação do formulário Multi-SKU Receiving em um sistema claro, acionável e à prova de ambiguidade, eliminando a classe de bug em que o usuário vê “Please fix validation errors before processing” sem entender o motivo.
>
> **Princípio de execução:** mudanças incrementais, aditivas e reversíveis. Cada fase entrega valor isolado, é mergeável independentemente, mantém o comportamento legado intocado e fica atrás de uma feature flag durante o ramp-up.

---

## 0. Contexto e diagnóstico de origem

### 0.1 Sintoma reportado
Usuário (Danny) clica **Process 8 Items** e recebe o toast vermelho “Please fix validation errors before processing”. Tenta novamente, mesmo resultado. O bill seguinte passa sem alterações no fluxo.

### 0.2 Causa raiz mapeada (em `src/features/inventory/pages/Receiving.tsx`)

| # | Defeito | Linhas | Impacto |
|---|---------|-------|---------|
| 1 | Erro `line-<id>-duplicate` é registrado em `validateAllLines` mas **nunca renderizado** em JSX. | 883‑899 (escrita) / sem leitura | Usuário vê só fundo rosa e toast genérico, sem pista do motivo. |
| 2 | Botão exibe `Process N Items` filtrando por `l.skuId && l.qty > 0`; `validateAllLines` percorre **todas** as linhas. | 2009 vs 855‑902 | Linhas “rascunho” bloqueiam o submit sem aparecer no contador. |
| 3 | Toast “Please fix validation errors…” é genérico — não cita qual linha, qual SKU, qual campo. | 918 | Diagnóstico depende de inspecionar a planilha visualmente. |
| 4 | Botão `Process` continua habilitado mesmo com `errors` populado; só bloqueia ao clicar. | 2002‑2010 | Atrito desnecessário; convida o usuário a tentar/erro. |
| 5 | `MultiSKUSelect` (com `usedSkus` para desabilitar duplicados no dropdown) existe em código (613‑656) mas não está sendo usado — o componente ativo é `SKUSelect`. | 1812 | Prevenção primária de duplicata foi escrita e nunca conectada. |

### 0.3 Restrições da arquitetura atual

- Componente `Receiving.tsx` carrega **dois fluxos coexistindo**: legacy single-SKU (testado em `receiving.submit.success.test.tsx`) e o atual Multi-SKU (sem testes integrados). **Não tocar no fluxo single** durante este plano.
- `validateAllLines` é `useCallback` com deps `[receivingLines, sharedFields]`; é chamado em `useEffect` de tempo real e dentro de `processAllReceivings`. Refatorar a função afeta ambos.
- Existe infraestrutura de feature flags em `src/lib/featureFlags.ts` — usaremos para rollout.
- Telemetria existente (`telemetry.event`) só cobre o fluxo single. Adicionar eventos novos para o batch é seguro.
- `ErrorMessage` (`Receiving.tsx:493‑499`) já é um helper estável — reutilizar.

### 0.4 Critérios de sucesso (verificáveis)

1. Em um batch com SKU duplicado, o usuário vê uma mensagem inline embaixo da segunda linha duplicada apontando explicitamente o número da linha em conflito.
2. Em um batch com linha em branco, o usuário vê inline qual campo falta (SKU/qty/cost) e tem opção visível de remover essa linha.
3. O botão `Process N Items` permanece desabilitado enquanto `errors` é não-vazio, e expõe o motivo via `title` / `aria-describedby`.
4. Quando o usuário clica num toast/banner de erro, o foco vai automaticamente para o primeiro campo problemático (com scroll-into-view).
5. Nenhuma regressão em `receiving.submit.success.test.tsx`, `receiving.submit.error.test.tsx`, `combobox-modal.test.tsx`.
6. O fluxo legacy single-SKU continua intocado.

---

## 1. Estratégia geral — fases ordenadas por risco

```
Fase 1 ── Telemetria de validação            (zero risco; só observa)
Fase 2 ── Erro de duplicata visível           (puramente aditivo)
Fase 3 ── Banner de resumo + scroll-to-error  (puramente aditivo)
Fase 4 ── Bloqueio inteligente do botão       (aditivo c/ flag)
Fase 5 ── Higiene de linhas rascunho          (aditivo c/ flag)
Fase 6 ── Prevenção primária via dropdown     (substituição leve c/ flag)
Fase 7 ── Refator do estado de erros          (refator estrutural — opcional)
Fase 8 ── Limpeza, ativação e rollout final   (consolidação)
```

Cada fase tem: **escopo**, **arquivos afetados**, **mudança comportamental**, **riscos**, **mitigação**, **plano de teste**, **plano de rollback**, **flag**, **critério de aceite**.

---

## 2. Fase 1 — Telemetria de validação (observabilidade primeiro)

### 2.1 Por que essa fase é a primeira
Antes de mudar UX, queremos métricas para validar a hipótese e medir o impacto. Sem telemetria, não saberemos se as mudanças realmente reduziram a frequência de bloqueios mistério.

### 2.2 Escopo
- Emitir `telemetry.event('receiving_batch_validation_blocked', { reasonCounts, lineCount })` toda vez que `processAllReceivings` aborta por erros.
  - `reasonCounts`: `{ missingSku, missingQty, missingCost, duplicateSku, damageQty, damageNotes, missingVendor, missingDate }` — contadores agregados, sem PII.
  - `lineCount`: `receivingLines.length`.
- Emitir `telemetry.event('receiving_batch_submit_attempt', { lineCount, validLineCount })` no início de `processAllReceivings`.
- Emitir `telemetry.event('receiving_batch_submit_success', { count })` ao final do happy path.

### 2.3 Arquivos
- `src/features/inventory/pages/Receiving.tsx` (apenas inserções dentro de `processAllReceivings`).

### 2.4 Riscos e mitigação
- **Risco:** sink de console gera ruído em produção. **Mitigação:** o sink atual já é `console.info`; sem mudança de severidade, sem PII (apenas counts).
- **Risco:** quebrar testes que checam ausência de console. **Mitigação:** rodar `npm test` antes do commit.

### 2.5 Plano de teste
- Rodar suíte existente: `npm test`.
- Manual: subir o app local, criar batch com 1 SKU duplicado e 1 linha vazia, conferir no console o evento com counters corretos.

### 2.6 Rollback
- `git revert` da fase. Sem efeito em estado/banco.

### 2.7 Critério de aceite
- Eventos disparam no console com payload sanitizado.
- Nenhum teste vermelho.

---

## 3. Fase 2 — Mensagem inline para SKU duplicado

### 3.1 Escopo (mínimo viável; o que mais paga em UX)
- Criar `lineDuplicateInfo` derivado em `validateAllLines`:
  - Hoje, todas as linhas duplicadas recebem a mesma mensagem genérica.
  - Mudança: armazenar **número da primeira linha** que tem o mesmo SKU.
  - Ex.: linhas 3 e 7 com mesmo SKU → linha 7 recebe `Same SKU already in line 3 — please consolidate or remove`.
- Renderizar abaixo da coluna SKU usando o helper já existente `ErrorMessage` ou estilo idêntico ao bloco `errors[\`line-${line.id}-sku\`]` (linhas 1821‑1826 são o gabarito).
- Tornar o texto acionável: pequeno botão `Remove this line` ao lado da mensagem (chama `removeReceivingLine(line.id)`).

### 3.2 Arquivos
- `src/features/inventory/pages/Receiving.tsx`.

### 3.3 Implementação detalhada
1. Em `validateAllLines`, ao detectar duplicata, **armazenar o índice da primeira ocorrência** do SKU (não todas). Mensagem: `Same SKU already in line ${firstIndex + 1} — please consolidate or remove`.
2. Renderizar bloco condicional abaixo do SKU (após o bloco existente de `line-<id>-sku`):
   ```tsx
   {errors[`line-${line.id}-duplicate`] && (
     <div className="text-xs text-red-600 flex items-start gap-1 leading-tight">
       <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
       <span className="break-words">{errors[`line-${line.id}-duplicate`]}</span>
       <button
         type="button"
         onClick={() => removeReceivingLine(line.id)}
         className="ml-1 underline hover:text-red-800"
         disabled={receivingLines.length <= 1}
       >
         Remove
       </button>
     </div>
   )}
   ```
3. **Apenas a linha “com índice maior”** mostra a mensagem (a primeira ocorrência do SKU não é “culpada”, apenas o repetidor). Reduz ruído visual.

### 3.4 Riscos e mitigação
- **Risco:** renderização duplicada do mesmo erro em múltiplas linhas confunde mais do que esclarece. **Mitigação:** mensagem só na linha repetida (índice mais alto).
- **Risco:** `removeReceivingLine` desabilita quando `length <= 1` — está OK no batch atual.
- **Risco:** quebra layout se a célula SKU já tem `space-y-1`. **Mitigação:** o estilo proposto reutiliza o mesmo padrão de `errors[\`line-${line.id}-sku\`]`, então preserva o grid.

### 3.5 Plano de teste
- Manual: abrir formulário, adicionar 2 linhas com SKUs diferentes, depois mudar a 2ª para o SKU da 1ª. Esperar mensagem `Same SKU already in line 1` na 2ª linha.
- Manual: clicar `Remove` na 2ª linha; ela some, mensagem desaparece, botão `Process N Items` deve atualizar contador.
- Snapshot/integration test novo (opcional nesta fase, obrigatório na Fase 8).

### 3.6 Rollback
- Revert da fase. Erro volta a ser silencioso, mas sem regressão funcional.

### 3.7 Flag
- Não estritamente necessária (mudança puramente aditiva e visível). Se quiser cinto+suspensório: `RECEIVING_DUPLICATE_INLINE_HINT` default `true`.

### 3.8 Critério de aceite
- Em batch com duplicata, mensagem é renderizada visivelmente.
- Botão `Remove` na mensagem funciona.
- Nenhuma alteração em comportamento de submit (ainda travado pelo erro).

---

## 4. Fase 3 — Banner de resumo + scroll-to-error

### 4.1 Escopo
- Substituir o toast genérico por um **banner permanente** acima do botão de Process, populado quando `errors` não está vazio.
- Banner lista as classes de erro detectadas com contagem e link para foco:
  - `2 lines have a duplicate SKU` → onClick: scroll para a primeira linha duplicada e foca o select de SKU.
  - `1 line is missing a quantity` → onClick: idem.
  - `Vendor is required` → onClick: scroll para o campo de vendor.
- Toast vermelho “Please fix validation errors before processing” permanece como fallback efêmero, mas o banner é a fonte primária.

### 4.2 Arquivos
- `src/features/inventory/pages/Receiving.tsx` (novo componente local `ValidationSummaryBanner`).

### 4.3 Implementação detalhada
1. Criar memo `validationSummary` que classifica `errors` em buckets:
   ```ts
   const validationSummary = useMemo(() => {
     const buckets = { missingSku: [], missingQty: [], missingCost: [], duplicate: [], damage: [], shared: [] };
     for (const [key, msg] of Object.entries(errors)) {
       const m = key.match(/^line-(.+?)-(sku|qty|cost|duplicate|damage-qty|damage-notes)$/);
       if (m) { /* push lineId em bucket apropriado */ }
       else if (key === 'vendor' || key === 'date') buckets.shared.push(key);
     }
     return buckets;
   }, [errors]);
   ```
2. Renderizar banner condicional logo antes da seção `Action Buttons` (perto da linha 1996):
   - Lista de bullets clicáveis.
   - Botão `Focus first error` que dispara `focusFirstError` adaptado para o batch (ver 4.4).
3. Implementar `focusFirstBatchError(lineId, field)`:
   - Resolve o `id` do input (`sku-${lineId}`, `qty-${lineId}`, `cost-${lineId}`).
   - `document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })` + `.focus()`.

### 4.4 Riscos e mitigação
- **Risco:** banner duplica info do toast e gera ruído. **Mitigação:** quando banner aparece, suprimir o toast genérico de `processAllReceivings` (manter apenas em casos onde o usuário clica e a validação passa em tempo-real, mas algo mudou entre clique e processamento — defesa em profundidade).
- **Risco:** scroll/focus brusco quebra fluxo. **Mitigação:** `behavior: 'smooth'`, `block: 'center'`.
- **Risco:** acessibilidade — leitores de tela. **Mitigação:** `role="alert"` no banner, `aria-live="polite"`.

### 4.5 Flag
- `RECEIVING_VALIDATION_SUMMARY_BANNER` (default `true` em dev, `false` em prod inicialmente).
- Quando `false`, código cai no comportamento atual (toast genérico).

### 4.6 Plano de teste
- Manual: criar erro de cada classe, conferir bullet correto, clicar e validar foco/scroll.
- Acessibilidade: tab order preservado; `aria-live` anuncia mudança.
- Snapshot test do banner (vitest + RTL).

### 4.7 Rollback
- Setar a flag para `false`. Sem necessidade de revert.

### 4.8 Critério de aceite
- Banner aparece com classificação correta dos erros.
- Cada bullet leva ao campo/linha correta com foco visível.
- Toast genérico não aparece quando o banner está ativo.

---

## 5. Fase 4 — Bloqueio inteligente do botão Process

### 5.1 Escopo
- Botão `Process N Items` fica **desabilitado** quando `Object.keys(errors).length > 0`.
- `title` e `aria-describedby` apontam para o banner ou para a primeira mensagem de erro.
- Cor do botão muda para `outline` quando bloqueado, evitando que o usuário “tente clicar” pensando que vai funcionar.

### 5.2 Arquivos
- `src/features/inventory/pages/Receiving.tsx` (linha 2002‑2010).

### 5.3 Implementação detalhada
```tsx
const hasBlockingErrors = Object.keys(errors).length > 0;
const processableLines = receivingLines.filter(l => l.skuId && l.qty > 0).length;

<Button
  type="button"
  variant={hasBlockingErrors ? 'outline' : 'default'}
  onClick={() => setConfirmOpen(true)}
  disabled={batchProcessing || processableLines === 0 || hasBlockingErrors}
  title={hasBlockingErrors ? 'Resolve validation errors above to enable processing' : undefined}
  aria-describedby={hasBlockingErrors ? 'validation-summary-banner' : undefined}
  className={hasBlockingErrors ? '' : 'bg-blue-600 text-white hover:bg-blue-700'}
>
  {batchProcessing ? 'Processing...' : `Process ${processableLines} Items`}
</Button>
```

### 5.4 Riscos e mitigação
- **Risco principal:** alguém legitimamente quer “tentar mesmo assim” para forçar erro. **Mitigação:** desabilitar é decisão deliberada de UX e está alinhada à mensagem do plano. O banner já dá a saída.
- **Risco:** flicker de habilitação durante digitação rápida. **Mitigação:** `errors` é derivado de `validateAllLines` em `useEffect` — comportamento já é estável.
- **Risco:** test de submit existente assume botão sempre habilitado. **Mitigação:** o teste relevante (`receiving.submit.success.test.tsx`) usa o fluxo single-SKU, não o batch — não impactado. Confirmar com `npm test`.

### 5.5 Flag
- `RECEIVING_PROCESS_BUTTON_GATING` default `true`.

### 5.6 Plano de teste
- Manual: linha vazia → botão disabled, tooltip aparece.
- Manual: corrigir linha → botão habilita imediatamente.
- Manual: 0 linhas válidas → botão disabled (comportamento atual mantido).
- `npm test`: nenhuma regressão.

### 5.7 Rollback
- Setar flag para `false`.

### 5.8 Critério de aceite
- Botão reage em tempo real ao estado de `errors`.
- Tooltip e aria funcionam.

---

## 6. Fase 5 — Higiene de linhas rascunho

### 6.1 Problema endereçado
Linha em branco ao final do batch (clique acidental em **+ Add Item**) faz o submit falhar sem o usuário perceber.

### 6.2 Escopo
Duas micro-melhorias complementares:

**A. Filtragem opt-in na validação:** linhas “completamente vazias” (sem `skuId`, `qty=0`, `unitCost=0`, `isDamaged=false`) **são ignoradas** por `validateAllLines` se houver pelo menos uma linha válida no batch. Linhas parcialmente preenchidas continuam sendo validadas (são erros legítimos de input incompleto).

```ts
const isCompletelyEmpty = (line) =>
  !line.skuId && line.qty === 0 && line.unitCost === 0 && !line.isDamaged && !line.damageNotes;

const linesToValidate = receivingLines.some(l => l.skuId)
  ? receivingLines.filter(l => !isCompletelyEmpty(l))
  : receivingLines; // se nenhuma linha tem skuId, valida todas (estado inicial vazio)
```

**B. UX preventiva:** botão `Add Item` desabilitado se a última linha estiver completamente vazia. Tooltip: `Fill the current line before adding another`.

### 6.3 Arquivos
- `src/features/inventory/pages/Receiving.tsx` (validação + linha 1764).

### 6.4 Riscos e mitigação
- **Risco principal:** usuário clica `+` antes de selecionar SKU para “preparar” linha. **Mitigação:** comportamento atual permite múltiplas linhas vazias, então essa regra é mais frouxa que o esperado — mantemos a primeira linha sempre preenchível, só bloqueamos quando a *última* está vazia E há mais de uma linha total.
- **Risco:** alterar `validateAllLines` afeta o `useEffect` de tempo real. **Mitigação:** a função continua determinística sobre o mesmo input; testar reactividade manualmente.
- **Risco:** linha em branco após processamento parcial (alguns sucessos, alguns falhos). **Mitigação:** o reset do estado já trata isso (linha 1009‑1018); fase não muda esse caminho.

### 6.5 Flag
- `RECEIVING_DRAFT_LINE_HYGIENE` default `true`.

### 6.6 Plano de teste
- Manual: clicar `+ Add Item` 3x sem preencher → 2º e 3º cliques bloqueados.
- Manual: preencher linha 1, clicar `+`, deixar linha 2 vazia, processar → linha 2 ignorada, linha 1 processa.
- Manual: 2 linhas, ambas parcialmente preenchidas → validação reclama das duas (não ignora).
- Edge: começar com 1 linha vazia, clicar Process → continua bloqueando (estado inicial preserva validação).

### 6.7 Rollback
- Flag para `false`.

### 6.8 Critério de aceite
- Linha completamente vazia ao final não bloqueia mais o submit.
- Linha parcial continua bloqueando (segurança).
- Botão `Add Item` desabilita corretamente.

---

## 7. Fase 6 — Prevenção primária via dropdown

### 7.1 Escopo
- Substituir `SKUSelect` por `MultiSKUSelect` (já existe, mas não está conectado).
- Passar `usedSkus={receivingLines.filter(l => l.id !== line.id).map(l => l.skuId).filter(Boolean)}` para cada linha.
- Resultado: SKUs já em uso aparecem **desabilitados** e marcados como `(Already used)` no dropdown — usuário não consegue mais criar duplicata acidentalmente.

### 7.2 Arquivos
- `src/features/inventory/pages/Receiving.tsx` (linha 1812 — trocar `SKUSelect` por `MultiSKUSelect` quando flag ativa).

### 7.3 Cuidados especiais
- **Coexistência com `skuPickerEnabled` (`RECEIVING_SKU_PICKER_MODAL`)**: hoje o componente já bifurca entre picker modal e select dropdown. O `MultiSKUSelect` substitui apenas a parte do dropdown. O picker modal precisa de tratamento separado (Fase 6.b se for necessário; provavelmente fora de escopo).
- **Mudança no SKU de uma linha existente para um SKU já em uso em outra linha:** o dropdown vai impedir, mas se vier de outro caminho (cole, autopreenchimento), a Fase 2 e Fase 3 continuam como rede de segurança.
- **Mudança em `skus` prop após uso:** se um SKU é deletado do master enquanto está em uma linha, o dropdown precisa lidar — `MultiSKUSelect` já tolera (renderiza só o que está em `skus`).

### 7.4 Flag
- `RECEIVING_DUPLICATE_PREVENTION_DROPDOWN` default `true`.

### 7.5 Riscos e mitigação
- **Risco:** picker modal (`skuPickerEnabled = true` em produção) ignora essa fase, então em produção real essa fase tem efeito limitado. **Mitigação:** estender o picker modal para receber `usedSkus` em uma fase 6.b, com mesma lógica.
- **Risco:** semântica de “usado” difere entre dropdown desabilitado e o erro de duplicata. **Mitigação:** mensagem do dropdown alinhada (`Already in line N`).

### 7.6 Plano de teste
- Manual: 2 linhas, SKU A na linha 1, abrir dropdown da linha 2 → SKU A aparece desabilitado.
- Manual: tentar mesmo assim por outro caminho (ex.: digitar) → fallback de Fase 2 cobre.

### 7.7 Rollback
- Flag para `false` → volta para `SKUSelect`.

### 7.8 Critério de aceite
- Dropdown previne duplicatas.
- Estado de “SKU usado” reage em tempo real conforme outras linhas mudam.

---

## 8. Fase 7 — Refator do estado de erros (opcional, só após Fases 2‑6 estabilizarem)

### 8.1 Por que opcional
As Fases 2‑6 resolvem o problema do usuário sem refatoração estrutural. Esta fase é dívida técnica acumulada em `Receiving.tsx` (2200+ linhas). Vale a pena somente se houver intenção de evoluir o componente para outras features.

### 8.2 Escopo proposto (não implementar agora; só decidir após uso real)
- Extrair `validateAllLines` + tipos de erro para `src/features/inventory/utils/receiving.validation.ts`.
- Trocar `errors: Record<string, string>` por estrutura tipada:
  ```ts
  type LineErrors = { sku?: string; qty?: string; cost?: string; duplicate?: { firstIndex: number }; damage?: { qty?: string; notes?: string } };
  type ReceivingErrors = { shared: { vendor?: string; date?: string }; lines: Map<string, LineErrors> };
  ```
- Adapta render para essa estrutura (linhas 1791‑1948).

### 8.3 Riscos
- Refator grande, alto risco de regressão.
- Só executar com cobertura de testes integrada decente (Fase 8 entrega isso).

---

## 9. Fase 8 — Testes integrados, ativação total, limpeza

### 9.1 Escopo
1. **Testes integrados novos** em `src/__tests__/integration/`:
   - `receiving.batch.duplicate.test.tsx`: garante mensagem inline aparece e botão fica desabilitado.
   - `receiving.batch.empty-line.test.tsx`: linha rascunho ignorada quando há outras válidas.
   - `receiving.batch.banner.test.tsx`: banner renderiza com bullets corretos.
2. **Ativação das flags** em produção (após uma semana de telemetria positiva da Fase 1):
   - `RECEIVING_VALIDATION_SUMMARY_BANNER: true`
   - `RECEIVING_PROCESS_BUTTON_GATING: true`
   - `RECEIVING_DRAFT_LINE_HYGIENE: true`
   - `RECEIVING_DUPLICATE_PREVENTION_DROPDOWN: true`
3. **Limpeza:** remover branches de fallback após 2 semanas em produção sem rollback. Manter as flags por mais um ciclo, só removê-las quando confirmado que ninguém está mais voltando ao comportamento antigo.
4. **Atualização de documentação:** `CLAUDE.md` ganha seção “Receiving validation UX”.

### 9.2 Critério de aceite
- Suíte de testes verde com novos cenários cobertos.
- Flags ativas em prod por 1 semana sem reclamação.
- Métrica `receiving_batch_validation_blocked` cai >70% em volume.

---

## 10. Sequência recomendada de commits / PRs

| Ordem | PR | Conteúdo | Tamanho |
|------|----|---------|--------|
| 1 | `feat(receiving): batch validation telemetry` | Fase 1 | ~30 LOC |
| 2 | `feat(receiving): inline duplicate-SKU hint with remove action` | Fase 2 | ~50 LOC |
| 3 | `feat(receiving): validation summary banner with focus jumps` | Fase 3 | ~150 LOC |
| 4 | `feat(receiving): gate process button on validation state` | Fase 4 | ~20 LOC |
| 5 | `feat(receiving): ignore fully-empty draft lines on submit` | Fase 5 | ~40 LOC |
| 6 | `feat(receiving): disable already-used SKUs in dropdown` | Fase 6 | ~30 LOC |
| 7 | `test(receiving): batch validation integration tests` | Fase 8 (parte) | ~200 LOC |
| 8 | `chore(featureflags): activate receiving validation UX flags` | Fase 8 (ativação) | ~10 LOC |

Cada PR é mergeável independentemente. PRs 2‑6 podem ser revertidos individualmente sem quebrar o sistema.

---

## 11. Quando parar / quando recuar

### 11.1 Sinais de recuo (rollback de fase específica)
- Telemetria mostra que `processable lines === 0` em >5% dos batches após Fase 4 (botão sempre desabilitado).
- Suporte recebe relato de SKU sumindo do dropdown indevidamente após Fase 6.
- Banner não rola para o campo correto em algum browser específico.

### 11.2 Sinais de “bom o suficiente”
- `receiving_batch_validation_blocked` cai abaixo de 1 evento/semana.
- Nenhum suporte sobre “mensagem genérica de validação” por 2 semanas.
- Não vale gastar a Fase 7 (refator) sem nova feature pedindo.

---

## 12. Resumo executivo (1 parágrafo)

> Vamos consertar o feedback de validação do Multi-SKU Receiving em 8 fases incrementais e independentes, todas atrás de feature flags. Começamos com telemetria (Fase 1) para medir o impacto. Em seguida, três camadas de remediação aditivas: mensagem inline para SKU duplicado (Fase 2), banner de resumo com scroll-to-error (Fase 3), bloqueio inteligente do botão Process (Fase 4). Depois, dois preventivos: ignorar linhas rascunho vazias (Fase 5) e desabilitar SKUs já usados no dropdown (Fase 6). Refator estrutural (Fase 7) fica opcional para depois. Fase 8 fecha com testes integrados e ativação das flags em produção. Cada fase é mergeável isoladamente, reversível por flag, e não toca no fluxo legacy single-SKU já testado.
