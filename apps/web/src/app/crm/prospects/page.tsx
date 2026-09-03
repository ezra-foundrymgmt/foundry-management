import { PIPELINE_STAGES, prospects } from "@creatoros/domain";
import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { ProspectBoard, type ProspectCard } from "@/components/prospect-board";
import { isMockMode } from "@/lib/environment";
import { getLiveProspects } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

export default async function ProspectsPage() {
  const access = await authorizePage("prospect.read");
  if (!access.allowed)
    return <AccessDenied title="Prospects" permission="prospect.read" reason={access.reason} />;

  const mock = isMockMode();
  // Writes are disabled in mock mode because there is no database behind them;
  // the board renders read-only rather than offering controls that would 503.
  const records: ProspectCard[] = mock
    ? prospects.map((prospect) => ({
        id: prospect.id,
        stageName: prospect.stageName,
        niche: prospect.niche,
        followerCountEstimate: prospect.followerCountEstimate,
        fitScore: prospect.fitScore,
        fitTier: prospect.fitTier,
        pipelineStage: prospect.pipelineStage,
        owner: prospect.owner,
        nextFollowupAt: null,
      }))
    : await getLiveProspects();

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Acquisition CRM"
        title="Prospects"
        subtitle="Qualify opportunities with a consistent fit model and preserve every relationship touchpoint."
        actions={
          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            {PIPELINE_STAGES.length} stages configured
          </span>
        }
      />
      <ProspectBoard prospects={records} readOnly={mock} />
    </main>
  );
}
