// Renders one short line in each candidate narrator voice so the owner can pick by ear. Never prints the key.
import fs from "node:fs";
import { post, retry } from "./env.mjs";
const OUT = process.argv[2];
const TEXT = "Sunday, six fifty-five in the morning UTC, on Base. Meet Kestrel. Stay asleep. Kestrel watches the chain.";
const V = { brian: "nPczCjzI2devNBz1zQrb", daniel: "onwK4e9ZLuTAKqWW03F9", eric: "cjVigY5qzO86Huf0OWal", george: "JBFqnCBsd6RMkjVDRZzb" };
fs.mkdirSync(OUT, { recursive: true });
for (const [name, id] of Object.entries(V)) {
  const res = await retry(() => post(`/text-to-speech/${id}?output_format=mp3_44100_128`, { text: TEXT, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }));
  fs.writeFileSync(`${OUT}/${name}.mp3`, Buffer.from(await res.arrayBuffer()));
  console.log("wrote", `${OUT}/${name}.mp3`);
}
