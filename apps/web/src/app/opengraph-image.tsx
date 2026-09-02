import { ImageResponse } from "next/og";

export const alt = "CreatorOS by Foundry Management";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#f3f0e9",
        color: "#20211f",
        padding: "72px 78px",
        border: "22px solid #1c1d1b",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div
          style={{
            display: "flex",
            width: 58,
            height: 58,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            background: "#1c1d1b",
            color: "#d9b58e",
            fontSize: 29,
            fontWeight: 800,
          }}
        >
          F
        </div>
        <div
          style={{ display: "flex", fontSize: 25, letterSpacing: 4, textTransform: "uppercase" }}
        >
          Foundry Management
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", fontSize: 86, fontWeight: 700, letterSpacing: -4 }}>
          CreatorOS
        </div>
        <div
          style={{ display: "flex", width: 850, fontSize: 31, lineHeight: 1.35, color: "#5f625d" }}
        >
          One operating system for creator acquisition, activation, performance, and contribution
          profit.
        </div>
      </div>
      <div
        style={{ display: "flex", alignItems: "center", gap: 14, color: "#a16d42", fontSize: 23 }}
      >
        <div style={{ display: "flex", width: 90, height: 3, background: "#a16d42" }} />
        Built for operational clarity
      </div>
    </div>,
    size,
  );
}
