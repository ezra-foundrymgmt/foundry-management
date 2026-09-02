import { ImageResponse } from "next/og";

export async function GET(_request: Request, context: { params: Promise<{ size: string }> }) {
  const size = (await context.params).size === "192" ? 192 : 512;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#1c1d1b",
        color: "#d9b58e",
        fontFamily: "serif",
        fontWeight: 700,
        fontSize: size * 0.58,
        border: `${Math.max(8, Math.round(size * 0.045))}px solid #a16d42`,
      }}
    >
      F
    </div>,
    { width: size, height: size },
  );
}
