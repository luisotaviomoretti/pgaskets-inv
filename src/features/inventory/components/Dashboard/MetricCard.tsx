import React, { memo, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';

/**
 * MetricCard
 * Componente de card para exibir uma métrica com série histórica em barras (spark bars).
 * Mantém o mesmo visual/comportamento do wireframe original.
 */

/**
 * Props do MetricCard.
 *
 * title: Título exibido no topo do card.
 * primary: Valor principal (texto formatado) exibido em destaque.
 * secondary: Texto secundário opcional abaixo do valor principal.
 * unitPrimary: Unidade do valor principal (ex.: CAD, kg, un.).
 * unitSecondary: Unidade do valor secundário.
 * series: Série numérica usada para o gráfico de barras e cálculo do delta.
 * direction: Força a direção do delta ("up" | "down" | "flat"); se omitida, deriva da série.
 * valueFormatter: Função para formatar o valor ao passar o mouse nas barras.
 */
export interface MetricCardProps {
  title: string;
  primary: string;
  secondary?: string;
  unitPrimary?: string;
  unitSecondary?: string;
  series: number[];
  direction?: 'up' | 'down' | 'flat';
  valueFormatter?: (v: number) => string;
  /** Optional explanatory content shown in a small popover when clicking the info icon next to the title */
  infoContent?: React.ReactNode;
}

/**
 * Subcomponente interno: SparkBars
 * Barras verticais simples para visualizar séries curtas.
 */
function SparkBars({ data, height = 40, formatValue }: { data: number[]; height?: number; formatValue?: (v: number) => string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...data, 1);
  const BAR_W = 8, GAP = 4;
  return (
    <div className="relative flex items-end gap-1 h-full" style={{ minHeight: height }} onMouseLeave={() => setHovered(null)}>
      {data.map((v, i) => (
        <div
          key={i}
          className="w-2 rounded-sm bg-black/90 transition-opacity"
          style={{ height: `${Math.max(6, Math.round((v / max) * height))}px`, opacity: hovered === null || hovered === i ? 1 : 0.25 }}
          onMouseEnter={() => setHovered(i)}
          title={formatValue ? formatValue(v) : String(v)}
          aria-label={`bar-${i}`}
        />
      ))}
      {hovered !== null && (
        <div className="absolute -top-6 text-[10px] px-1.5 py-0.5 rounded bg-black text-white shadow pointer-events-none" style={{ left: hovered * (BAR_W + GAP) }}>
          {formatValue ? formatValue(data[hovered]) : data[hovered]}
        </div>
      )}
    </div>
  );
}

function MetricCardBase({ title, primary, secondary, unitPrimary, unitSecondary, series, direction, valueFormatter, infoContent }: MetricCardProps) {
  const delta = useMemo(() => {
    if (!series || series.length < 2) return 0;
    const first = series[0];
    const last = series[series.length - 1];
    if (first === 0) return 0;
    return ((last - first) / Math.abs(first)) * 100;
  }, [series]);

  const isUp = direction === 'up' || (direction === undefined && delta >= 0);
  const isFlat = direction === 'flat' || (direction === undefined && Math.abs(delta) < 0.1);
  const [open, setOpen] = useState(false);

  return (
    <Card className="rounded-2xl border-dashed">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs text-slate-500">{title}</div>
          {infoContent && (
            <div className="relative">
              <button
                type="button"
                aria-label="Info"
                className="h-5 w-5 leading-none rounded-full border text-[10px] flex items-center justify-center text-slate-600 hover:bg-slate-50"
                onClick={() => setOpen((v) => !v)}
              >
                i
              </button>
              {open && (
                <div
                  role="dialog"
                  aria-label={`${title} info`}
                  className="absolute right-0 z-10 mt-2 w-72 max-w-[80vw] rounded-md border bg-white p-3 text-xs text-slate-700 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="mb-2 font-medium text-slate-900">About: {title}</div>
                  <div className="space-y-1">{infoContent}</div>
                  <div className="mt-2 text-right">
                    <button
                      type="button"
                      className="text-xs text-slate-600 hover:text-slate-900"
                      onClick={() => setOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-semibold">{primary}</p>
            {unitPrimary && <span className="text-sm text-slate-500">{unitPrimary}</span>}
          </div>
          {secondary && (<p className="text-sm text-slate-500">{secondary} {unitSecondary ?? ''}</p>)}
          <div className={`mt-2 text-xs ${isFlat ? 'text-slate-500' : isUp ? 'text-emerald-600' : 'text-red-600'}`}>
            {isFlat ? '±0%' : `${isUp ? '+' : ''}${delta.toFixed(1)}%`}
          </div>
          <div className="mt-3 h-14">
            <SparkBars data={series} height={56} formatValue={valueFormatter} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Exporta o MetricCard memoizado para evitar renders desnecessários.
 */
export const MetricCard = memo(MetricCardBase);
export default MetricCard;

