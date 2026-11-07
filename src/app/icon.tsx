import { ImageResponse } from "next/og";
import { OG, PromptMark } from "@/lib/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: OG.canvas, borderRadius: 4 }}>
        <PromptMark size={30} />
      </div>
    ),
    size
  );
}
