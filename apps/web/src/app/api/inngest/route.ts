import { serve } from "inngest/next";
import {
  activateCreator,
  generateDailyCreatorReport,
  inngest,
  runReportSchedules,
} from "@/lib/inngest";
import { respondToSlackMention } from "@/lib/agent/inngest-function";
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    generateDailyCreatorReport,
    activateCreator,
    respondToSlackMention,
    runReportSchedules,
  ],
});
