import { expect, test } from "@playwright/test";

test("founder can review the operating command center", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Foundry Command Center" })).toBeVisible();
  await expect(
    page.getByText("First-purchase monetization", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Sarah Vale").first()).toBeVisible();
});

test("creator activation is visible and idempotent through the API", async ({ page, request }) => {
  const first = await request.post("/api/onboarding", { data: { creatorId: "madison" } });
  const second = await request.post("/api/onboarding", { data: { creatorId: "madison" } });
  expect(first.ok()).toBeTruthy();
  expect(second.ok()).toBeTruthy();
  const firstBody = (await first.json()) as { run: { id: string; status: string } };
  const secondBody = (await second.json()) as { run: { id: string; status: string } };
  expect(secondBody.run.id).toBe(firstBody.run.id);
  expect(firstBody.run.status).toBe("WAITING_EXTERNAL");
  await page.goto("/workflows");
  await expect(page.getByText("ONB-2026-000001")).toBeVisible();
  await expect(page.getByText("BASELINE DATA", { exact: true })).toBeVisible();
});

test("signed prospect conversion is idempotent", async ({ request }) => {
  const first = await request.post("/api/prospects/convert", { data: { prospectId: "jessica" } });
  const second = await request.post("/api/prospects/convert", { data: { prospectId: "jessica" } });
  expect(first.ok()).toBeTruthy();
  expect(second.ok()).toBeTruthy();
  expect((await first.json()).creatorId).toBe((await second.json()).creatorId);
});

test("global search is keyboard accessible", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Search creators/ }).click();
  await expect(page.getByRole("dialog", { name: "Global search" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Global search" })).toBeHidden();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Global search" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search CreatorOS" }).fill("Madison");
  await expect(page.getByRole("button", { name: /Madison Carter/ })).toBeVisible();
});

test("WebMCP tools register and use the same tenant-scoped search", async ({ page }) => {
  await page.addInitScript(() => {
    const registry: unknown[] = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => {
          registry.push(tool);
          options?.signal?.addEventListener("abort", () => {
            const index = registry.indexOf(tool);
            if (index >= 0) registry.splice(index, 1);
          });
        },
      },
    });
    (globalThis as unknown as { __creatorOsTools: unknown[] }).__creatorOsTools = registry;
  });
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as unknown as { __creatorOsTools: Array<{ name: string }> }
        ).__creatorOsTools.map((tool) => tool.name),
      ),
    )
    .toEqual(["search_creatoros", "open_creator_record"]);
  const result = await page.evaluate(async () => {
    const tools = (
      globalThis as unknown as {
        __creatorOsTools: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }>;
      }
    ).__creatorOsTools;
    return tools.find((tool) => tool.name === "search_creatoros")?.execute({ query: "Madison" });
  });
  expect(result).toMatchObject({ data: [{ type: "creator", id: "madison" }] });
  const invalidRejected = await page.evaluate(async () => {
    const tools = (
      globalThis as unknown as {
        __creatorOsTools: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }>;
      }
    ).__creatorOsTools;
    try {
      await tools.find((tool) => tool.name === "search_creatoros")?.execute({ query: 42 });
      return false;
    } catch {
      return true;
    }
  });
  expect(invalidRejected).toBe(true);
});

test("integration registry and installable PWA assets are navigable", async ({ page, request }) => {
  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Slack" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Notion" })).toBeVisible();
  await expect(page.getByText("OAuth state is single-use")).toBeVisible();
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.json()).toMatchObject({
    name: "CreatorOS — Foundry Management",
    display: "standalone",
  });
  expect((await request.get("/icons/192")).headers()["content-type"]).toContain("image/png");
  expect((await request.get("/icons/512")).headers()["content-type"]).toContain("image/png");
});
