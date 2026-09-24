// Lightweight SVG price chart for /market/[id] (no chart library). Server component.
import { priceChartGeometry, type PriceChartInput } from "@/lib/view/price-chart";
import { usd } from "@/components/format";

export function PriceChart(props: PriceChartInput & { symbol: string; isMigrated: boolean }) {
  const g = priceChartGeometry(props);
  const up = g.changeBps >= 0;
  const change = `${up ? "+" : "−"}${(Math.abs(g.changeBps) / 100).toFixed(2)}%`;
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">Price</h2>
          <p className="text-xs text-muted-foreground">
            {props.symbol} per unit along the bonding curve · launch {usd(props.startPrice)} → graduation {usd(props.graduationPrice)}
          </p>
        </div>
        <p className="num text-sm">
          <span className="font-semibold text-strong">{usd(props.currentPrice)}</span>{" "}
          <span className={up ? "text-positive" : "text-destructive"}>{change}</span>{" "}
          <span className="text-muted-foreground">since launch</span>
        </p>
      </div>
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        preserveAspectRatio="none"
        className="h-44 w-full overflow-visible"
        role="img"
        aria-label={`Price ${usd(props.currentPrice)}, ${change} since launch`}
      >
        {g.ticks.map((t) => (
          <line key={t.y} x1={0} x2={g.width} y1={t.y} y2={t.y} className="stroke-border" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={g.area} className="fill-brand/10" />
        <path d={g.remaining} fill="none" className="stroke-muted-foreground/50" strokeWidth={1.5} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={g.traded} fill="none" className="stroke-brand" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <line x1={g.now.x} x2={g.now.x} y1={0} y2={g.height} className="stroke-brand/40" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
        <span>Launch</span>
        <span>Now</span>
        <span>{props.isMigrated ? "Graduated" : "Graduation"}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Launch and current prices come from the pool; the dashed segment is the rest of the curve, not a forecast.
      </p>
    </section>
  );
}
