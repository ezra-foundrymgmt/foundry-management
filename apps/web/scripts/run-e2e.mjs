import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack"], {
  cwd: process.cwd(),
  stdio: "ignore",
  windowsHide: true,
});

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3000/api/health");
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the CreatorOS test server");
}

function stopServer() {
  if (!server.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    server.kill("SIGTERM");
  }
}

let exitCode = 1;
try {
  await waitForServer();
  exitCode = await new Promise((resolve) => {
    const runner = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: "1" },
      windowsHide: true,
    });
    runner.on("exit", (code) => resolve(code ?? 1));
    runner.on("error", () => resolve(1));
  });
} finally {
  stopServer();
}

process.exit(exitCode);
