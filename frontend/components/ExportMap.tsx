import Reveal from "./Reveal";
import SectionHead from "./SectionHead";
import map from "@/lib/worldDots.json";
import { exportLanes } from "@/lib/content";

type P = [number, number];
const ports = map.ports as unknown as Record<string, P>;
const routes = ["jebelAli", "dammam", "rotterdam", "felixstowe", "hamburg", "newYork", "houston", "toronto", "mombasa", "durban", "colombo", "portKlang", "sydney"];

function arc([x1, y1]: P, [x2, y2]: P) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  return `M${x1},${y1} Q${(x1 + x2) / 2},${(y1 + y2) / 2 - d * 0.3} ${x2},${y2}`;
}

export default function ExportMap() {
  const k = ports.karachi, l = ports.lahore;
  const pct = ([x, y]: P) => ({ left: `${(x / map.w) * 100}%`, top: `${(y / map.h) * 100}%` });
  return (
    <section id="export" className="bg-ink py-24 text-bone lg:py-32">
      <div className="wrap">
        <SectionHead n="06" label={exportLanes.eyebrow} title={exportLanes.title} body={exportLanes.body} dark />
        <Reveal delay={0.1}>
          <div className="relative mt-14">
            <svg viewBox={`0 0 ${map.w} ${map.h}`} className="h-auto w-full" role="img" aria-label="Shipping routes from Karachi to the Gulf, Europe, North America, Africa and Asia Pacific. Head office in Lahore.">
              {(map.dots as number[][]).map(([x, y, pk], i) => (
                <circle key={i} cx={x} cy={y} r={1.35} fill={pk ? "#F2EFE9" : "rgba(242,239,233,.16)"} />
              ))}
              <g fill="none" stroke="#E35B2C" strokeWidth="1" strokeLinecap="round" opacity=".9">
                {routes.map((r) => <path key={r} d={arc(k, ports[r])} className="route" />)}
              </g>
              {routes.map((r) => <circle key={r} cx={ports[r][0]} cy={ports[r][1]} r="2.2" fill="#F2EFE9" />)}
              <path d={`M${l[0]},${l[1]} L${k[0]},${k[1]}`} stroke="#F2EFE9" strokeWidth="1" strokeDasharray="2 3" />
              <circle cx={k[0]} cy={k[1]} r="3.4" fill="#E35B2C" />
              <rect x={l[0] - 3.6} y={l[1] - 3.6} width="7.2" height="7.2" fill="#E35B2C" stroke="#0E1013" strokeWidth="1.5" />
            </svg>
            <span className="label-mono absolute hidden -translate-y-[170%] translate-x-3 whitespace-nowrap text-bone sm:block" style={pct(l)}>Lahore · HQ</span>
            <span className="label-mono absolute hidden translate-x-3 translate-y-1 whitespace-nowrap text-fog sm:block" style={pct(k)}>Karachi · Port</span>
          </div>
        </Reveal>
        <ul className="mt-12 grid border-t border-white/12 sm:grid-cols-2 lg:grid-cols-5">
          {exportLanes.regions.map((r) => (
            <li key={r.name} className="border-b border-white/12 py-5 pr-6 lg:border-b-0">
              <p className="text-bone">{r.name}</p>
              <p className="label-mono mt-1.5 normal-case tracking-normal text-fog">{r.ports}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
