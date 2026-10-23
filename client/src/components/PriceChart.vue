<script setup lang="ts">
import { computed } from 'vue';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type ScriptableContext,
} from 'chart.js';
import { Line } from 'vue-chartjs';
import { useTheme } from '@/composables/useTheme';
import type { PricePoint } from '@/lib/types';
import {
  formatCompactPrice,
  formatPrice,
  formatTimestamp,
} from '@/lib/format';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
);

interface PriceChartProps {
  history: PricePoint[];
  currency: string;
  dropPercent: number;
}

const props = defineProps<PriceChartProps>();
const { isDark } = useTheme();

const reducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const points = computed(() =>
  props.history.filter(
    (point) => Number.isFinite(point.price) && point.recordedAt,
  ),
);

const trend = computed(() => {
  if (props.dropPercent > 0) return 'down';
  if (props.dropPercent < 0) return 'up';
  return 'flat';
});

const palette = computed(() => {
  const dark = isDark.value;
  const pointRing = dark ? '#14194f' : '#ffffff';

  if (trend.value === 'down') {
    return dark
      ? {
          line: '#ff5ca8',
          fillTop: 'rgba(245, 0, 136, 0.28)',
          fillBottom: 'rgba(245, 0, 136, 0.01)',
          pointRing,
        }
      : {
          line: '#f50088',
          fillTop: 'rgba(245, 0, 136, 0.22)',
          fillBottom: 'rgba(245, 0, 136, 0.008)',
          pointRing,
        };
  }
  if (trend.value === 'up') {
    return dark
      ? {
          line: '#ff646a',
          fillTop: 'rgba(255, 100, 106, 0.18)',
          fillBottom: 'rgba(255, 100, 106, 0.008)',
          pointRing,
        }
      : {
          line: '#c8060c',
          fillTop: 'rgba(200, 6, 12, 0.17)',
          fillBottom: 'rgba(200, 6, 12, 0.008)',
          pointRing,
        };
  }
  return dark
    ? {
        line: '#9aa0ff',
        fillTop: 'rgba(154, 160, 255, 0.15)',
        fillBottom: 'rgba(154, 160, 255, 0.008)',
        pointRing,
      }
    : {
        line: '#0f146d',
        fillTop: 'rgba(15, 20, 109, 0.14)',
        fillBottom: 'rgba(15, 20, 109, 0.008)',
        pointRing,
      };
});

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const dateYearFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
});

function formatAxisDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  const first = points.value[0];
  const last = points.value[points.value.length - 1];
  const span =
    first && last
      ? new Date(last.recordedAt).getTime() -
        new Date(first.recordedAt).getTime()
      : 0;

  if (span <= 36 * 60 * 60 * 1000) return timeFormatter.format(date);
  if (span <= 365 * 24 * 60 * 60 * 1000) return dateFormatter.format(date);
  return dateYearFormatter.format(date);
}

function areaGradient(context: ScriptableContext<'line'>) {
  const { chart } = context;
  const { ctx, chartArea } = chart;
  if (!chartArea) return 'rgba(0, 0, 0, 0)';

  const gradient = ctx.createLinearGradient(
    0,
    chartArea.top,
    0,
    chartArea.bottom,
  );
  gradient.addColorStop(0, palette.value.fillTop);
  gradient.addColorStop(1, palette.value.fillBottom);
  return gradient;
}

const chartData = computed<ChartData<'line'>>(() => ({
  labels: points.value.map((point) => point.recordedAt),
  datasets: [
    {
      data: points.value.map((point) => point.price),
      borderColor: palette.value.line,
      backgroundColor: areaGradient,
      fill: true,
      tension: 0.36,
      cubicInterpolationMode: 'monotone',
      borderWidth: 2,
      spanGaps: true,
      pointRadius:
        points.value.length === 1
          ? 3
          : points.value.length <= 20
            ? 2
            : 0,
      pointHoverRadius: 4,
      pointBackgroundColor: palette.value.line,
      pointBorderColor: palette.value.pointRing,
      pointBorderWidth: 1.5,
      pointHitRadius: 16,
    },
  ],
}));

const chartOptions = computed<ChartOptions<'line'>>(() => {
  const dark = isDark.value;
  const axisColor = dark
    ? 'rgba(213, 214, 255, 0.68)'
    : 'rgba(15, 20, 109, 0.55)';
  const gridColor = dark
    ? 'rgba(226, 228, 255, 0.09)'
    : 'rgba(15, 20, 109, 0.08)';

  return {
    responsive: true,
    maintainAspectRatio: false,
    normalized: true,
    animation: reducedMotion ? false : { duration: 360 },
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: { top: 8, right: 4, bottom: 0, left: 0 },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: dark ? '#f8f3fa' : '#0f146d',
        titleColor: dark ? '#b00062' : '#ffd6ea',
        bodyColor: dark ? '#171226' : '#ffffff',
        borderColor: dark
          ? 'rgba(245, 0, 136, 0.18)'
          : 'rgba(245, 0, 136, 0.32)',
        borderWidth: 1,
        padding: 10,
        cornerRadius: 9,
        displayColors: false,
        titleFont: { family: 'Inter Variable', size: 11, weight: 500 },
        bodyFont: { family: 'Inter Variable', size: 13, weight: 600 },
        callbacks: {
          title: (items) => {
            const item = items[0];
            const point = item ? points.value[item.dataIndex] : undefined;
            return point ? formatTimestamp(point.recordedAt) : '';
          },
          label: (item) =>
            formatPrice(Number(item.parsed.y), props.currency),
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: axisColor,
          font: { family: 'Inter Variable', size: 10.5 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 4,
          padding: 6,
          callback: (value) => {
            const point = points.value[Number(value)];
            return point ? formatAxisDate(point.recordedAt) : '';
          },
        },
      },
      y: {
        beginAtZero: false,
        grace: '10%',
        grid: {
          color: gridColor,
          drawTicks: false,
        },
        border: { display: false },
        ticks: {
          color: axisColor,
          font: { family: 'Inter Variable', size: 10.5 },
          maxTicksLimit: 5,
          padding: 8,
          callback: (value) =>
            formatCompactPrice(Number(value), props.currency),
        },
      },
    },
  };
});

const accessibilityLabel = computed(() => {
  if (!points.value.length) {
    return 'No recorded price history yet';
  }

  const latest = points.value[points.value.length - 1];
  const oldest = points.value[0];
  if (!latest || !oldest) return 'Price history chart';

  return `Price history chart with ${points.value.length} recorded prices, from ${formatPrice(
    oldest.price,
    props.currency,
  )} to ${formatPrice(latest.price, props.currency)}`;
});
</script>

<template>
  <div class="chart-frame" role="img" :aria-label="accessibilityLabel">
    <div
      v-if="!points.length"
      class="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 bg-card/45 text-center"
    >
      <span class="text-[13px] font-medium text-muted-foreground">
        No price history yet
      </span>
      <span class="max-w-[240px] text-[11.5px] leading-4 text-muted-foreground/75">
        The first recorded price will appear here after the next successful check.
      </span>
    </div>

    <Line
      v-else
      :data="chartData"
      :options="chartOptions"
      aria-hidden="true"
    />
  </div>
</template>
