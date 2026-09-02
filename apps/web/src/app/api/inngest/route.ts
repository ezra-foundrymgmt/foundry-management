import { serve } from "inngest/next";
import { generateDailyCreatorReport, inngest } from "@/lib/inngest";
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [generateDailyCreatorReport],
});
