// Geometry for the /market/[id] price chart. Pure (no React) so it is unit-tested.
// The bonding curve's price is a function of how far the curve has filled, so the chart plots
// price (y) against curve progress (x): the traded segment from the launch price to today's
// on-chain price (solid), and the rest of the curve up to the graduation price (dashed, projected).

export interface PriceChartInput {
  /** USDC base units per whole unit. */
  startPrice: bigint;
  currentPrice: bigint;
  graduationPrice: bigint;
  /** 0..10000 curve progress. */
  progressBps: number;
}

export interface PriceChartGeometry {
  width: number;
  height: number;
  /** SVG path for launch → now. */
  traded: string;
  /** SVG path for now → graduation (projected). */
  remaining: string;
  /** Filled area under the traded segment. */
  area: string;
  now: { x: number; y: number };
  /** Horizontal gridlines with their price (base units). */
  ticks: { y: number; price: bigint }[];
  changeBps: number;
}

const W = 600;
const H = 180;
const PAD_Y = 12;
const SAMPLES = 24;

const f = (n: number) => Math.round(n * 10) / 10;

export function priceChartGeometry(input: PriceChartInput): PriceChartGeometry {
  const start = Number(input.startPrice);
  const grad = Math.max(Number(input.graduationPrice), start + 1);
  const cur = Number(input.currentPrice);
  const p = Math.min(1, Math.max(0, input.progressBps / 10_000));

  const lo = Math.min(start, cur) * 0.9;
  const hi = Math.max(grad, cur) * 1.05;
  const x = (t: number) => t * W;
  const y = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD_Y);

  // Between known points the path is drawn geometrically (price grows multiplicatively along a
  // constant-product curve); the endpoints are exact: launch, on-chain now, graduation.
  const seg = (t0: number, v0: number, t1: number, v1: number) => {
    const pts: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const k = i / SAMPLES;
      const v = v0 > 0 && v1 > 0 ? v0 * Math.pow(v1 / v0, k) : v0 + (v1 - v0) * k;
      pts.push(`${i === 0 ? "M" : "L"}${f(x(t0 + (t1 - t0) * k))},${f(y(v))}`);
    }
    return pts.join(" ");
  };

  const traded = seg(0, start, p, cur);
  const remaining = seg(p, cur, 1, grad);
  const area = `${traded} L${f(x(p))},${H - PAD_Y} L0,${H - PAD_Y} Z`;
  const ticks = [start, (start + grad) / 2, grad].map((v) => ({ y: f(y(v)), price: BigInt(Math.round(v)) }));
  const changeBps = start > 0 ? Math.round(((cur - start) / start) * 10_000) : 0;

  return { width: W, height: H, traded, remaining, area, now: { x: f(x(p)), y: f(y(cur)) }, ticks, changeBps };
}
