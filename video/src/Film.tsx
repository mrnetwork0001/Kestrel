import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAt } from "./timing";
import { C } from "./theme";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { markOf, syncTo } from "./ui/Footage";
import { Open } from "./scenes/Open";
import { Problem } from "./scenes/Problem";
import { Evidence } from "./scenes/Evidence";
import { Turn } from "./scenes/Turn";
import { Briefing } from "./scenes/Briefing";
import { Pager } from "./scenes/Pager";
import { Rescue } from "./scenes/Rescue";
import { Lab } from "./scenes/Lab";
import { Shield } from "./scenes/Shield";
import { Agents } from "./scenes/Agents";
import { Hood } from "./scenes/Hood";
import { Different } from "./scenes/Different";
import { Close } from "./scenes/Close";

const SCENES: Record<string, React.FC> = {
  open: Open, problem: Problem, evidence: Evidence, turn: Turn, briefing: Briefing, pager: Pager, rescue: Rescue,
  lab: Lab, shield: Shield, agents: Agents, hood: Hood, different: Different, close: Close,
};
const OVERLAP = 12; // frames each scene starts early, to dissolve over the last

/** Each scene eases in (a short rise, un-blur and settle) over the tail of the previous one, holding its first frame. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.04 - 0.04 * p})`, filter: p < 1 ? `blur(${(1 - p) * 12}px)` : undefined }}>{body}</AbsoluteFill>;
};

// --- Music, ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 20], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 50, end], [1, 0], clamp);
  return (0.62 - 0.42 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

interface Fx { file: string; at: number; vol: number; dur?: number }
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => wordAt(id, word, n);
  // footage events, in film frames
  const heroStart = syncTo("hero", "hero.pasted", w("briefing", "Paste") - sc("briefing") + 22);
  const runAt = sc("briefing") + markOf("hero", "hero.run") - heroStart;
  const pagerStart = syncTo("pager", "pager.result", w("pager", "Telegram") - sc("pager") - 40);
  const evalAt = sc("pager") + markOf("pager", "pager.eval") - pagerStart;
  const labStart = syncTo("lab", "lab.whale", w("lab", "whale") - sc("lab") - 4);
  const fx: Fx[] = [
    { file: "tick", at: 6, vol: 0.25 }, { file: "tick", at: 36, vol: 0.25 },
    ...["USDC", "VIBES", "WETH"].map((x) => ({ file: "ping", at: w("open", x) + 2, vol: 0.4 })),
    { file: "whoosh", at: sc("problem") - 8, vol: 0.3 },
    ...["liquidity", "contracts", "admin"].map((x) => ({ file: "pop", at: w("problem", x) - 4, vol: 0.3 })),
    { file: "glitch", at: w("problem", "drained.") - 2, vol: 0.35 },
    { file: "whoosh", at: sc("evidence") - 8, vol: 0.3 },
    { file: "blips", at: w("evidence", "forty-four") - 6, vol: 0.3 },
    { file: "riser", at: sc("turn") - 84, vol: 0.4 },
    { file: "impact", at: w("turn", "Kestrel.") - 4, vol: 0.55 },
    { file: "whoosh", at: sc("briefing") - 8, vol: 0.3 },
    { file: "type", at: w("briefing", "Paste") + 14, vol: 0.22 },
    { file: "click", at: runAt, vol: 0.45 },
    { file: "alert", at: w("briefing", "forty-five") - 2, vol: 0.35 },
    ...(evalAt > sc("pager") + 10 ? [{ file: "click", at: evalAt, vol: 0.45 }] : []),
    { file: "buzz", at: w("pager", "Telegram") - 6, vol: 0.5 },
    { file: "whoosh", at: sc("rescue") - 8, vol: 0.3 },
    ...["Two", "revokes."].map((x) => ({ file: "lock", at: w("rescue", x) - 2, vol: 0.45 })),
    ...["VIBES", "swapped"].map((x) => ({ file: "coin", at: w("rescue", x), vol: 0.3 })),
    { file: "chime", at: w("rescue", "Score:") + 4, vol: 0.4 },
    { file: "click", at: sc("lab") + markOf("lab", "lab.whale") - labStart, vol: 0.45 },
    { file: "click", at: sc("lab") + markOf("lab", "lab.lp") - labStart, vol: 0.45 },
    { file: "chime", at: w("lab", "exact.") - 2, vol: 0.3 },
    { file: "whoosh", at: sc("shield") - 8, vol: 0.3 },
    ...["Allow,", "warn", "block."].map((x) => ({ file: "pop", at: w("agents", x) - 2, vol: 0.38 })),
    { file: "coin", at: w("agents", "twenty-five.") - 2, vol: 0.4 },
    { file: "whoosh", at: sc("hood") - 8, vol: 0.3 },
    ...["indexer", "mock"].map((x) => ({ file: "glitch", at: w("hood", x) + 4, vol: 0.25 })),
    { file: "whoosh", at: sc("different") - 8, vol: 0.35 },
    { file: "impact", at: w("different", "Kestrel") - 4, vol: 0.25 },
    { file: "chime", at: w("close", "Kestrel.") - 2, vol: 0.4 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < T.totalFrames);
}

export const Film: React.FC = () => {
  // Captions sit out where big type already carries the words.
  const hideCaptions = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    return !s || ["turn", "different", "close", "problem"].includes(s.id);
  };
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {T.scenes.map((s, i) => {
        const S = SCENES[s.id];
        const from = i === 0 ? s.from : s.from - OVERLAP;
        const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
        return S ? (
          <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
            <SceneIn S={S} first={i === 0} />
          </Sequence>
        ) : null;
      })}
      <Grain opacity={0.07} />
      <Captions hidden={hideCaptions} bottom={60} />
      <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} />
      {T.scenes.flatMap((s) => s.lines).map((l, i) => (
        <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames} name={`vo ${l.text.slice(0, 18)}`}>
          <Audio src={staticFile(l.file)} volume={1} />
        </Sequence>
      ))}
      {effects().map((x, i) => (
        <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 150} name={`fx ${x.file}`}>
          <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 8, x.dur - 20, x.dur], [0, 1, 1, 0], clamp) : 1)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
