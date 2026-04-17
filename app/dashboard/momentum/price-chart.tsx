'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { OhlcCandle } from '@/lib/momentum/analyze';

type Props = {
  candles: OhlcCandle[];
  label: string;
};

export function PriceChart({ candles, label }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const firstTimeRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a0a' },
        textColor: '#a3a3a3',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: '#1f1f1f' },
        horzLines: { color: '#1f1f1f' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: '#262626',
        scaleMargins: { top: 0.08, bottom: 0.25 },
      },
      timeScale: {
        borderColor: '#262626',
        timeVisible: true,
        secondsVisible: false,
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      priceLineVisible: false,
    });
    candleSeriesRef.current = candleSeries;

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: '#404040',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart || candles.length === 0) return;

    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const candleData = sorted.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const volumeData = sorted
      .filter((c) => typeof c.volume === 'number')
      .map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume!,
        color: c.close >= c.open ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)',
      }));

    const prevFirstTime = firstTimeRef.current;
    const prevLastTime = lastTimeRef.current;
    const newFirstTime = candleData[0].time as number;
    const newLastTime = candleData[candleData.length - 1].time as number;
    const isFreshDataset = prevFirstTime === null || newFirstTime !== prevFirstTime;

    if (isFreshDataset) {
      // New symbol/interval — reseed everything and fit the view.
      candleSeries.setData(candleData);
      volumeSeries.setData(volumeData);
      chart.timeScale().fitContent();
    } else if (newLastTime === prevLastTime) {
      // Same last bar — update it in place, preserving user pan/zoom.
      candleSeries.update(candleData[candleData.length - 1]);
      const lastVol = volumeData[volumeData.length - 1];
      if (lastVol && (lastVol.time as number) === newLastTime) {
        volumeSeries.update(lastVol);
      }
    } else {
      // One or more new bars — append everything after the previous last bar.
      const newCandles = candleData.filter((c) => (c.time as number) > (prevLastTime ?? -Infinity));
      const newVolumes = volumeData.filter((v) => (v.time as number) > (prevLastTime ?? -Infinity));
      newCandles.forEach((c) => candleSeries.update(c));
      newVolumes.forEach((v) => volumeSeries.update(v));
    }

    firstTimeRef.current = newFirstTime;
    lastTimeRef.current = newLastTime;
  }, [candles]);

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <h4 className="text-sm font-semibold text-neutral-200">{label}</h4>
        <span className="text-xs text-neutral-500">
          scroll to zoom · drag to pan · {candles.length} bars
        </span>
      </div>
      <div ref={containerRef} className="h-[460px] w-full" />
    </section>
  );
}
