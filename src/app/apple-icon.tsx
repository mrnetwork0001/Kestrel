import { ImageResponse } from "next/og";
import { OG, PromptMark } from "@/lib/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  // iOS applies its own corner mask, so the tile stays square; a phosphor hairline frames the mark.
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: OG.canvas }}>
        <div style={{ display: "flex", width: 148, height: 148, alignItems: "center", justifyContent: "center", border: `2px solid ${OG.phosphor}40` }}>
          <PromptMark size={124} />
        </div>
      </div>
    ),
    size
  );
}
