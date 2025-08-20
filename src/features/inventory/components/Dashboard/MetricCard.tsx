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
  /** Optional labels for the X-axis of the chart */
  labels?: string[];
  /** Chart type: 'bars' for bar chart, 'line' for line chart */
  chartType?: 'bars' | 'line';
}

/**
 * Subcomponente interno: SparkLine
 * Gráfico de linha simples para visualizar séries de tendência.
 */
function SparkLine({ data, height = 40, formatValue, labels }: { data: number[]; height?: number; formatValue?: (v: number) => string; labels?: string[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const POINT_SIZE = 3, GAP = 12;
  
  // Criar pontos da linha
  const points = data.map((v, i) => {
    const x = i * (16 + GAP) + 8; // centralizado no "slot" da barra
    const y = height - ((v - min) / range) * height;
    return { x, y, value: v };
  });
  
  // Criar path SVG da linha
  const pathData = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  
  return (
    <div className="relative h-full" style={{ minHeight: height + (labels ? 16 : 0) }}>
      {/* Linha SVG */}
      <div className="relative" style={{ height: height }} onMouseLeave={() => setHovered(null)}>
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${(data.length - 1) * (16 + GAP) + 16} ${height}`}>
          <path 
            d={pathData} 
            stroke="black" 
            strokeWidth="2" 
            fill="none"
            opacity={0.9}
          />
          {/* Pontos interativos */}
          {points.map((point, i) => (
            <circle
              key={i}
              cx={point.x}
              cy={point.y}
              r={POINT_SIZE}
              fill="black"
              opacity={hovered === null || hovered === i ? 1 : 0.3}
              className="cursor-pointer transition-opacity"
              onMouseEnter={() => setHovered(i)}
              title={formatValue ? formatValue(point.value) : String(point.value)}
            />
          ))}
        </svg>
        
        {/* Tooltip */}
        {hovered !== null && (
          <div className="absolute -top-6 text-[10px] px-1.5 py-0.5 rounded bg-black text-white shadow pointer-events-none" style={{ left: points[hovered].x - 15 }}>
            <div>{formatValue ? formatValue(data[hovered]) : data[hovered]}</div>
            {hovered > 0 && (
              <div className="text-[9px] opacity-80">
                {(() => {
                  const current = data[hovered];
                  const previous = data[hovered - 1];
                  if (previous === 0) return '—';
                  const change = ((current - previous) / Math.abs(previous)) * 100;
                  const sign = change >= 0 ? '+' : '';
                  return `${sign}${change.toFixed(1)}%`;
                })()}
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Labels abaixo dos pontos */}
      {labels && (
        <div className="flex gap-3 mt-1">
          {labels.map((label, i) => (
            <div
              key={i}
              className="w-4 text-[8px] text-slate-400 text-center"
              style={{ fontSize: '7px', lineHeight: '10px' }}
            >
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Subcomponente interno: SparkBars
 * Barras verticais simples para visualizar séries curtas.
 */
function SparkBars({ data, height = 40, formatValue, labels }: { data: number[]; height?: number; formatValue?: (v: number) => string; labels?: string[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...data, 1);
  const BAR_W = 16, GAP = 12;
  return (
    <div className="relative h-full" style={{ minHeight: height + (labels ? 16 : 0) }}>
      {/* Barras */}
      <div className="relative flex items-end gap-3" style={{ height: height }} onMouseLeave={() => setHovered(null)}>
        {data.map((v, i) => (
          <div
            key={i}
            className="w-4 rounded-sm bg-black/90 transition-opacity"
            style={{ height: `${Math.max(8, Math.round((v / max) * height))}px`, opacity: hovered === null || hovered === i ? 1 : 0.25 }}
            onMouseEnter={() => setHovered(i)}
            title={formatValue ? formatValue(v) : String(v)}
            aria-label={`bar-${i}`}
          />
        ))}
        {hovered !== null && (
          <div className="absolute -top-6 text-[10px] px-1.5 py-0.5 rounded bg-black text-white shadow pointer-events-none" style={{ left: hovered * (BAR_W + GAP) }}>
            <div>{formatValue ? formatValue(data[hovered]) : data[hovered]}</div>
            {hovered > 0 && (
              <div className="text-[9px] opacity-80">
                {(() => {
                  const current = data[hovered];
                  const previous = data[hovered - 1];
                  if (previous === 0) return '—';
                  const change = ((current - previous) / Math.abs(previous)) * 100;
                  const sign = change >= 0 ? '+' : '';
                  return `${sign}${change.toFixed(1)}%`;
                })()}
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Labels abaixo das barras */}
      {labels && (
        <div className="flex gap-3 mt-1">
          {labels.map((label, i) => (
            <div
              key={i}
              className="w-4 text-[8px] text-slate-400 text-center"
              style={{ fontSize: '7px', lineHeight: '10px' }}
            >
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCardBase({ title, primary, secondary, unitPrimary, unitSecondary, series, direction, valueFormatter, infoContent, labels, chartType = 'bars' }: MetricCardProps) {
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
          <div className="mt-3 h-24">
            {chartType === 'line' ? (
              <SparkLine data={series} height={80} formatValue={valueFormatter} labels={labels} />
            ) : (
              <SparkBars data={series} height={80} formatValue={valueFormatter} labels={labels} />
            )}
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

