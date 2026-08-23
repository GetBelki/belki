import { ExternalLink } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import {
  percentageChartScale,
  rankChartScale,
  shortChartDate,
  type TrendDatum,
} from "../lib/trend-chart";
import { cn, percent } from "../lib/utils";

export interface TrendSeriesDefinition {
  key: string;
  label: string;
  color: string;
  primary?: boolean;
  badge?: string;
  detailHref?: string;
  connectNulls?: boolean;
}

export type TrendMetric = "percentage" | "rank";

function trendValue(value: number, metric: TrendMetric): string {
  return metric === "rank" ? `#${value.toFixed(value % 1 === 0 ? 0 : 1)}` : percent(value);
}

export function TrendChartInsight({
  label,
  value,
  change,
  detail,
  metric = "percentage",
}: {
  label: string;
  value: number | null | undefined;
  change: number | null | undefined;
  detail?: string;
  metric?: TrendMetric;
}) {
  const changeLabel = change === null || change === undefined
    ? null
    : `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change).toFixed(1)}${metric === "rank" ? " positions" : " pp"}`;
  const changeDirection = metric === "rank" ? -(change ?? 0) : change ?? 0;
  return (
    <div className="trend-chart-insight">
      <span>{label}</span>
      <div>
        <strong>{value === null || value === undefined ? "—" : trendValue(value, metric)}</strong>
        {changeLabel ? (
          <small className={cn(changeDirection > 0 && "is-positive", changeDirection < 0 && "is-negative")}>
            {changeLabel} <span>vs previous 7 days</span>
          </small>
        ) : null}
      </div>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}

export function TrendChartLegend({
  items,
  hiddenKeys,
  highlightedKey,
  onHighlightedKeyChange,
  onToggle,
}: {
  items: readonly TrendSeriesDefinition[];
  hiddenKeys: ReadonlySet<string>;
  highlightedKey: string | null;
  onHighlightedKeyChange: (key: string | null) => void;
  onToggle: (key: string) => void;
}) {
  return (
    <div aria-label="Chart series" className="trend-chart-legend" role="group">
      {items.map((item) => {
        const hidden = hiddenKeys.has(item.key);
        const highlighted = highlightedKey === item.key;
        const style = { "--trend-color": item.color } as CSSProperties;
        return (
          <div
            className={cn(
              "trend-chart-legend-item",
              hidden && "is-hidden",
              highlighted && "is-highlighted",
            )}
            key={item.key}
            style={style}
          >
            <button
              aria-label={`${hidden ? "Show" : "Hide"} ${item.label}`}
              aria-pressed={!hidden}
              onBlur={() => onHighlightedKeyChange(null)}
              onClick={() => onToggle(item.key)}
              onFocus={() => onHighlightedKeyChange(item.key)}
              onPointerEnter={() => onHighlightedKeyChange(item.key)}
              onPointerLeave={() => onHighlightedKeyChange(null)}
              type="button"
            >
              <i />
              <span>{item.label}</span>
              {item.badge ? <small>{item.badge}</small> : null}
            </button>
            {item.detailHref ? (
              <Link aria-label={`Open ${item.label} details`} to={item.detailHref}>
                <ExternalLink size={11} />
              </Link>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function BelkiTrendChart({
  ariaLabel,
  data,
  series,
  highlightedKey,
  tooltipContent,
  annotations,
  metric = "percentage",
}: {
  ariaLabel: string;
  data: readonly TrendDatum[];
  series: readonly TrendSeriesDefinition[];
  highlightedKey: string | null;
  tooltipContent: (props: TooltipContentProps) => ReactNode;
  annotations?: ReactNode;
  metric?: TrendMetric;
}) {
  const scale = metric === "rank"
    ? rankChartScale(data, series.map(({ key }) => key))
    : percentageChartScale(data, series.map(({ key }) => key));
  const latest = data.at(-1);
  return (
    <div aria-label={ariaLabel} className="trend-chart-plot" role="group">
      <p className="sr-only">
        Latest recorded values: {series.map((item) => {
          const value = latest?.[item.key];
          return `${item.label} ${
            typeof value === "number" && Number.isFinite(value)
              ? trendValue(value, metric)
              : "—"
          }`;
        }).join(", ")}.
      </p>
      <ResponsiveContainer height="100%" minWidth={0} width="100%">
        <LineChart
          accessibilityLayer
          data={[...data]}
          margin={{ top: 12, right: 10, bottom: 2, left: 0 }}
        >
          <CartesianGrid stroke="#ececf0" vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="metric_date"
            interval="preserveStartEnd"
            minTickGap={38}
            tick={{ fill: "#71717a", fontSize: 10 }}
            tickFormatter={shortChartDate}
            tickLine={false}
          />
          <YAxis
            axisLine={false}
            domain={scale.domain}
            reversed={metric === "rank"}
            tick={{ fill: "#71717a", fontSize: 10 }}
            tickFormatter={(value) => metric === "rank" ? `#${value}` : `${value}%`}
            tickLine={false}
            ticks={scale.ticks}
            width={40}
          />
          <Tooltip
            content={tooltipContent}
            cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }}
            isAnimationActive={false}
          />
          {series.map((item) => {
            const subdued = highlightedKey !== null && highlightedKey !== item.key;
            return (
              <Line
                activeDot={{ fill: "#fff", r: item.primary ? 4.5 : 3.5, strokeWidth: 2 }}
                connectNulls={item.connectNulls}
                dataKey={item.key}
                dot={false}
                isAnimationActive={false}
                key={item.key}
                name={item.label}
                opacity={subdued ? 0.16 : 1}
                stroke={item.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={item.primary ? 3 : 1.75}
                type="linear"
              />
            );
          })}
          {annotations}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
