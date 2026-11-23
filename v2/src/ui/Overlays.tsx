import { Fragment, useMemo, type ReactNode } from "react";
import { bearing, distance } from "@/lib/geo";
import { liveTips } from "../coach/analyze";
import { learnedFactor } from "../coach/learn";
import { boatModel } from "../engine/boats";
import {
  distToLine,
  lineBias,
  nearestOnLine,
  toLayline,
} from "../engine/course";
import { WIND_STOPS, windCss, windWords } from "../engine/windColor";
import { actions, useUi, world, type FieldId } from "../state";
import { clock, deg, kn, mmss, nm, sdeg } from "./format";

// ------------------------------------------------------------ instruments

interface TileProps {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  pgn?: string;
  help: string;
  tone?: "port" | "stbd" | "good" | "warn" | "bad";
  big?: boolean;
}

function Tile({ label, value, unit, sub, pgn, help, tone, big }: TileProps) {
  return (
    <div className={`tile ${tone ?? ""} ${big ? "big" : ""}`} title={help}>
      <div className="tile-head">
        <span>{label}</span>
        {pgn ? <span className="pgn">{pgn}</span> : null}
      </div>
      <div className="tile-val">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {sub ? <div className="tile-sub">{sub}</div> : null}
    </div>
  );
}

export function Instruments() {
  useUi((s) => s.version);
  const source = useUi((s) => s.source);
  const profile = useUi((s) => s.profile);
  const raceView = useUi((s) => s.raceView);
  const fields = useUi((s) => s.fields[raceView ? "race" : "setup"]);
  const b = world.own;
  const upwind = Math.abs(b.twa) < 90;
  const factor = learnedFactor(profile, b.tws, upwind);
  const target = b.targetBsp * (factor ?? 1);
  const polarPct = b.polarBsp > 0.3 ? (b.bsp / b.polarBsp) * 100 : null;
  const vmg = b.bsp * Math.cos((b.twa * Math.PI) / 180);
  const tackTone = b.twa >= 0 ? "stbd" : "port";
  const twaErr = Math.abs(b.twa) - b.targetTwa;
  const tiles: Record<Exclude<FieldId, "intent" | "tips">, () => ReactNode> = {
    bsp: () => (
      <Tile
        big
        label="Boat speed"
        value={kn(b.bsp)}
        unit="kn"
        sub={`target ${kn(target)}${factor ? " (learned)" : ""}`}
        pgn="128259"
        help="BSP: speed through the water. Target is the best speed for this wind and angle."
        tone={
          b.bsp >= target * 0.97
            ? "good"
            : b.bsp < target * 0.85
              ? "warn"
              : undefined
        }
      />
    ),
    twa: () => (
      <Tile
        big
        label="True wind angle"
        value={sdeg(b.twa)}
        sub={`${b.twa >= 0 ? "Starboard" : "Port"} · target ${Math.round(b.targetTwa)}°`}
        pgn="130306"
        help="TWA: angle between your bow and where the wind comes from. Green = starboard tack, red = port."
        tone={tackTone}
      />
    ),
    tws: () => (
      <Tile
        label="Wind speed"
        value={kn(b.tws)}
        unit="kn"
        sub={windWords(b.tws)}
        pgn="130306"
        help="TWS: true wind speed, the wind as if you were standing still."
      />
    ),
    twd: () => (
      <Tile
        label="Wind from"
        value={deg(b.twd)}
        sub="TWD"
        pgn="130306"
        help="TWD: compass direction the wind blows from. Watch it for shifts."
      />
    ),
    hdg: () => (
      <Tile
        label="Heading"
        value={deg(b.hdg)}
        sub="true"
        pgn="127250"
        help="HDG: the direction the bow points."
      />
    ),
    vmg: () => (
      <Tile
        label="VMG"
        value={kn(Math.abs(vmg))}
        unit="kn"
        sub={upwind ? "upwind" : "downwind"}
        help="VMG: how fast you are getting upwind (or downwind). This is what wins beats."
      />
    ),
    awa: () => (
      <Tile
        label="Apparent"
        value={sdeg(b.awa)}
        sub={`${kn(b.aws)} kn`}
        pgn="130306"
        help="AWA / AWS: the wind you feel on the boat, what the telltales show."
      />
    ),
    polar: () => (
      <Tile
        label="Polar"
        value={polarPct === null ? "–" : `${Math.round(polarPct)}`}
        unit="%"
        sub={
          Math.abs(twaErr) > 3 && upwind
            ? `${twaErr > 0 ? "low" : "high"} by ${Math.abs(twaErr).toFixed(0)}°`
            : "of the book speed"
        }
        help="How fast you are going compared with what the boat can do at this exact wind and angle."
        tone={
          polarPct === null
            ? undefined
            : polarPct >= 97
              ? "good"
              : polarPct < 88
                ? "bad"
                : "warn"
        }
      />
    ),
  };
  const shown = fields.filter((f): f is keyof typeof tiles => f in tiles);
  return (
    <section
      className={`instruments ${raceView ? "race" : ""}`}
      aria-label="Instruments"
    >
      <div className="inst-src">
        <span className={`live-dot ${source}`} />
        {source === "sim"
          ? "Simulated NMEA 2000"
          : source === "n2k"
            ? "NMEA 2000 via Signal K"
            : "Phone GPS"}
        {b.manoeuvre ? (
          <span className="chip warn">
            {b.manoeuvre.kind === "tack" ? "Tacking" : "Gybing"}
          </span>
        ) : null}
        <button
          className="inst-edit"
          onClick={() => actions.setCustomize(true)}
          title="Choose which data boxes show"
          aria-label="Choose data boxes"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path
              d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h9M14 12h0"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle
              cx="10.5"
              cy="4"
              r="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle
              cx="5.5"
              cy="8"
              r="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle
              cx="12.5"
              cy="12"
              r="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
        </button>
      </div>
      {shown.length ? (
        <div className="tiles">
          {shown.map((f) => (
            <Fragment key={f}>{tiles[f]()}</Fragment>
          ))}
        </div>
      ) : (
        <div className="tile-sub">No data boxes chosen.</div>
      )}
      {fields.includes("intent") ? (
        <div className="intent">{b.intent}</div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------ race HUD

export function RaceHud() {
  useUi((s) => s.version);
  const b = world.own;
  const ttg = world.timeToGunS();
  const ln = world.line;
  const seq = world.sequence;
  const L = boatModel(world.boatId).preset.dims.loaM;
  const tg = boatModel(world.boatId).lattice.targetsAt(b.tws);

  if (b.phase === "prestart" && ttg !== null) {
    const lineNm = ln ? distToLine(b.pos, ln, seq[0] ?? null) : null;
    const near = ln ? nearestOnLine(b.pos, ln) : null;
    const ttlS =
      near && lineNm !== null && lineNm > 0
        ? (distance(b.pos, near.at) / Math.max(1, tg.upBsp * 0.95)) * 3600
        : null;
    const burn = ttlS !== null ? ttg - ttlS : null;
    const bias = ln ? lineBias(ln, b.twd) : null;
    return (
      <section className="hud prestart" aria-label="Start">
        <div className="hud-count">{mmss(ttg)}</div>
        <div className="hud-grid">
          <div>
            <label title="Perpendicular distance to the start line (positive = behind it)">
              To line
            </label>
            <b className={lineNm !== null && lineNm < 0 ? "bad" : ""}>
              {lineNm === null ? "–" : `${Math.round(lineNm * 1852)} m`}
            </b>
            <span>
              {lineNm === null
                ? ""
                : `${(Math.abs(lineNm * 1852) / L).toFixed(1)} lengths`}
            </span>
          </div>
          <div>
            <label title="Time to reach the line close-hauled at target speed">
              Time to line
            </label>
            <b>{mmss(ttlS)}</b>
          </div>
          <div>
            <label title="Time to spare: burn it by luffing so you hit the line at full speed on the gun">
              Time to burn
            </label>
            <b
              className={
                burn !== null && burn < 0
                  ? "bad"
                  : burn !== null && burn < 8
                    ? "warn"
                    : "good"
              }
            >
              {mmss(burn)}
            </b>
          </div>
          <div>
            <label title="Which end of the line is further upwind">
              Favoured end
            </label>
            <b>
              {bias === null
                ? "–"
                : Math.abs(bias) < 2
                  ? "Square"
                  : bias > 0
                    ? "Pin"
                    : "Boat"}
            </b>
            <span>
              {bias === null ? "" : `${Math.abs(bias).toFixed(0)}° bias`}
            </span>
          </div>
        </div>
        {lineNm !== null && lineNm < 0 ? (
          <div className="hud-alert">
            Over the line: dip back below it before the gun
          </div>
        ) : null}
      </section>
    );
  }

  if (b.phase === "racing" || b.phase === "finished") {
    const mark = seq[b.leg];
    const since = world.gunT !== null ? (world.t - world.gunT) / 1000 : null;
    const place =
      world.boats.length > 1
        ? world.standings().findIndex((x) => x.own) + 1
        : null;
    if (b.phase === "finished" || !mark) {
      return (
        <section className="hud" aria-label="Race">
          <div className="hud-title">
            Finished{place ? ` · ${place} of ${world.boats.length}` : ""}
          </div>
          <div className="hud-sub">
            Race time{" "}
            {mmss(
              b.finishedT && world.gunT
                ? (b.finishedT - world.gunT) / 1000
                : since,
            )}
          </div>
          <button className="btn sm" onClick={() => actions.setTab("coach")}>
            See the coach's debrief
          </button>
        </section>
      );
    }
    const d = distance(b.pos, mark);
    const btw = bearing(b.pos, mark);
    const kind = b.legKind ?? "beat";
    const lay =
      kind === "reach"
        ? null
        : toLayline({
            pos: b.pos,
            mark,
            twd: b.twd,
            angle: kind === "beat" ? tg.upTwa : tg.downTwa,
            side: b.twa >= 0 ? 1 : -1,
            bsp: b.bsp,
            kind: kind === "beat" ? "beat" : "run",
          });
    const vmc = b.bsp * Math.cos(((b.hdg - btw) * Math.PI) / 180);
    return (
      <section className="hud" aria-label="Race">
        <div className="hud-title">
          Leg {b.leg + 1}/{seq.length} ·{" "}
          {kind === "beat" ? "Beat" : kind === "run" ? "Run" : "Reach"} to{" "}
          {mark.name}
          {place ? (
            <span className="place">
              {place}/{world.boats.length}
            </span>
          ) : null}
        </div>
        {b.ocs ? (
          <div className="hud-alert">OCS: over early. Go back and restart</div>
        ) : null}
        <div className="hud-grid">
          <div>
            <label>Distance</label>
            <b>{nm(d)}</b>
          </div>
          <div>
            <label title="Bearing to the mark">Bearing</label>
            <b>{deg(btw)}</b>
          </div>
          <div>
            <label title="Time until you can tack (or gybe) and lay the mark">
              Layline
            </label>
            <b className={lay?.s != null && lay.s < 20 ? "warn" : ""}>
              {kind === "reach" ? "–" : lay === null ? "Laying" : mmss(lay.s)}
            </b>
          </div>
          <div>
            <label title="Speed made good towards the mark">VMC</label>
            <b>{kn(vmc)} kn</b>
          </div>
        </div>
        <div className="hud-sub">Race clock {mmss(since)}</div>
      </section>
    );
  }
  return null;
}

// ------------------------------------------------------------ live tips

export function Tips() {
  useUi((s) => s.version);
  const on = useUi((s) =>
    s.fields[s.raceView ? "race" : "setup"].includes("tips"),
  );
  const b = world.own;
  const tips = useMemo(() => {
    if (b.phase !== "racing") return [];
    const mark = world.sequence[b.leg];
    const tg = boatModel(world.boatId).lattice.targetsAt(b.tws);
    const kind = b.legKind;
    const lay =
      mark && kind && kind !== "reach"
        ? toLayline({
            pos: b.pos,
            mark,
            twd: b.twd,
            angle: kind === "beat" ? tg.upTwa : tg.downTwa,
            side: b.twa >= 0 ? 1 : -1,
            bsp: b.bsp,
            kind: kind === "beat" ? "beat" : "run",
          })
        : null;
    return liveTips(world.samples.slice(-200), { laylineS: lay?.s ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useUi.getState().version]);
  if (!on || !tips.length) return null;
  return (
    <section className="tips" aria-label="Coach tips" aria-live="polite">
      <div className="tips-head">Coach</div>
      {tips.map((t) => (
        <div key={t.id} className={`tip ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------ forecast edge

/** Shown when the map is looking somewhere the forecast doesn't reach. */
export function ForecastEdge() {
  const outside = useUi((s) => s.forecastOutside);
  const busy = useUi((s) => s.forecastBusy);
  if (busy)
    return <div className="edge-chip">Loading the forecast for this area…</div>;
  if (!outside) return null;
  return (
    <div className="edge-chip">
      No forecast here
      <button className="btn sm" onClick={actions.forecastForView}>
        Load it for this area
      </button>
    </div>
  );
}

// ------------------------------------------------------------ legend

export function Legend() {
  const colors = useUi((s) => s.colors);
  if (!colors) return null;
  const max = 35;
  const stops = WIND_STOPS.filter((s) => s.kn <= max);
  const grad = stops
    .map((s) => `${windCss(s.kn)} ${(s.kn / max) * 100}%`)
    .join(", ");
  return (
    <div className="legend" title="Wind speed in knots">
      <div
        className="legend-bar"
        style={{ background: `linear-gradient(90deg, ${grad})` }}
      />
      <div className="legend-ticks">
        {[0, 5, 10, 15, 20, 25, 30, 35].map((k) => (
          <span key={k} style={{ left: `${(k / max) * 100}%` }}>
            {k}
          </span>
        ))}
      </div>
      <div className="legend-cap">wind, knots</div>
    </div>
  );
}

// ------------------------------------------------------------ timeline

export function Timeline() {
  const viewT = useUi((s) => s.viewT);
  const follow = useUi((s) => s.followClock);
  const running = useUi((s) => s.running);
  const speed = useUi((s) => s.speed);
  const source = useUi((s) => s.source);
  const raceView = useUi((s) => s.raceView);
  useUi((s) => s.version);
  const cov = world.forecast.field.coverage();
  const hours: number[] = [];
  const stepH = cov.t1 - cov.t0 > 30 * 3_600_000 ? 6 : 3;
  for (
    let t = Math.ceil(cov.t0 / (stepH * 3_600_000)) * stepH * 3_600_000;
    t <= cov.t1;
    t += stepH * 3_600_000
  )
    hours.push(t);
  const w = world.forecast.field.wind(
    world.own.pos.lat,
    world.own.pos.lon,
    viewT,
  );
  const atBoat = w
    ? {
        tws: Math.hypot(w.u, w.v),
        twd: ((Math.atan2(-w.u, -w.v) * 180) / Math.PI + 360) % 360,
      }
    : null;
  return (
    <footer className={`timeline ${raceView ? "compact" : ""}`}>
      {source === "sim" ? (
        <div className="sim-ctl">
          <button
            className="btn icon"
            onClick={actions.toggleRun}
            title={running ? "Pause the simulation" : "Run the simulation"}
            aria-label={running ? "Pause" : "Play"}
          >
            {running ? "❚❚" : "▶"}
          </button>
          <select
            aria-label="Simulation speed"
            value={speed}
            onChange={(e) => actions.setSpeed(Number(e.target.value))}
          >
            {[1, 2, 4, 8, 16, 32].map((x) => (
              <option key={x} value={x}>
                {x}×
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {raceView ? null : (
        <div className="scrub">
          <div className="scrub-head">
            <span className="scrub-time">
              {new Date(viewT).toLocaleString([], {
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <span className="scrub-src">{world.forecast.label}</span>
            {atBoat ? (
              <span
                className="scrub-wind"
                style={{ borderColor: windCss(atBoat.tws) }}
              >
                at the boat: {deg(atBoat.twd)} {kn(atBoat.tws, 0)} kn
              </span>
            ) : null}
            <button
              className={`btn ghost sm ${follow ? "on" : ""}`}
              onClick={actions.follow}
              title="Show the forecast for the current time"
            >
              {follow ? "Live" : "Back to now"}
            </button>
          </div>
          <input
            type="range"
            aria-label="Forecast time"
            min={cov.t0}
            max={cov.t1}
            step={5 * 60_000}
            value={Math.min(cov.t1, Math.max(cov.t0, viewT))}
            onChange={(e) => actions.scrub(Number(e.target.value))}
          />
          <div className="scrub-ticks">
            {hours.map((t) => (
              <span
                key={t}
                style={{ left: `${((t - cov.t0) / (cov.t1 - cov.t0)) * 100}%` }}
              >
                {clock(t)}
              </span>
            ))}
            <i
              className="now"
              style={{
                left: `${((world.t - cov.t0) / (cov.t1 - cov.t0)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}
    </footer>
  );
}
