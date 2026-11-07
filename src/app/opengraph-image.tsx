import { renderSiteCard, SITE_OG_ALT } from "@/lib/og-site";

export const alt = SITE_OG_ALT;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 300;

export default function Image() {
  return renderSiteCard();
}
