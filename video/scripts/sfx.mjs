// Sound effects via ElevenLabs /v1/sound-generation. Skips files that already exist.
//   node scripts/sfx.mjs                 all missing
//   ONLY=stamp,impact node scripts/sfx.mjs   force regenerate some
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const SFX = {
  tick: ["Single crisp quiet clock tick, close, dry, short", 0.5],
  ping: ["Single soft sonar ping, deep and clean, with a short underwater tail, no music", 1.5],
  whoosh: ["Soft fast airy whoosh, smooth cinematic transition, no music", 1.0],
  click: ["Soft modern UI click, single, clean, short", 0.5],
  pop: ["Soft subtle UI pop, single, clean, short", 0.5],
  type: ["Fast soft keyboard typing on a laptop, close, dry, about two seconds, no music", 2.0],
  riser: ["Tension riser, rising airy synth swell building to a peak, cinematic, no drums", 3],
  impact: ["Deep clean cinematic impact with a warm sub tail, modern, single hit", 2],
  alert: ["Soft two-tone warning chime, amber alert, clean, modern, short", 1.0],
  buzz: ["A phone vibrating twice on a wooden bedside table at night, close, no music", 1.2],
  lock: ["Solid metallic latch clicking shut, satisfying, clean, short", 0.6],
  chime: ["Bright clean confirmation chime, two soft ascending notes, modern, short tail", 1.5],
  glitch: ["Short soft digital glitch blip, crisp, single", 0.6],
  blips: ["A short run of soft quiet digital data blips, like a terminal printing, no music", 1.2],
  coin: ["One small clean coin clink, bright, short", 0.5],
};

const dir = join(ROOT, "public/audio/sfx");
mkdirSync(dir, { recursive: true });
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

for (const [name, [text, dur]] of Object.entries(SFX)) {
  const f = join(dir, `${name}.mp3`);
  if (only ? !only.includes(name) : existsSync(f)) { console.log(`${name}: skip`); continue; }
  try {
    const buf = await retry(async () => {
      const res = await post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: dur, prompt_influence: 0.5 });
      return Buffer.from(await res.arrayBuffer());
    });
    writeFileSync(f, buf);
    console.log(`${name}: ${(buf.length / 1024).toFixed(0)}kb`);
  } catch (e) { console.error(`${name}: FAILED ${e.message}`); }
}
