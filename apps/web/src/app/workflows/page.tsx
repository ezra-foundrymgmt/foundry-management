import { ACTIVATION_STEPS } from "@creatoros/workflows";
import { creators } from "@creatoros/domain";
import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { OnboardingButton } from "@/components/onboarding-button";
import { ResumeWorkflowButton } from "@/components/resume-workflow-button";
import { isMockMode } from "@/lib/environment";
import { getLiveWorkflowRuns, type LiveWorkflowRun } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/**
 * The demo run, shaped exactly like a live one so the page has a single render
 * path. Previously the page hardcoded 92% progress and a run number regardless
 * of any real state.
 */
function demoRun(): LiveWorkflowRun {
  const waitingIndex = ACTIVATION_STEPS.indexOf("AWAIT_BASELINE_READINESS");
  const steps = ACTIVATION_STEPS.map((name, index) => ({
    name,
    status:
      index < waitingIndex ? "SUCCEEDED" : index === waitingIndex ? "WAITING_EXTERNAL" : "PENDING",
    attempts: index < waitingIndex ? 1 : 0,
    error: null,
    provider: name.startsWith("PROVISION_SLACK")
      ? "SLACK"
      : name.startsWith("PROVISION_NOTION")
        ? "NOTION"
        : null,
    externalId: null,
  }));
  const succeeded = steps.filter((step) => step.status === "SUCCEEDED").length;
  return {
    id: "demo",
    runNumber: "ONB-2026-000001",
    status: "WAITING_EXTERNAL",
    creatorId: null,
    creatorName: creators[0]?.stageName ?? "Madison Carter",
    startedAt: new Date().toISOString(),
    completedAt: null,
    blockers: [],
    steps,
    progressPercent: Math.round((succeeded / steps.length) * 100),
  };
}

export default async function WorkflowsPage() {
  const access = await authorizePage("creator.read");
  if (!access.allowed)
    return (
      <AccessDenied title="Workflow control" permission="creator.read" reason={access.reason} />
    );

  const mock = isMockMode();
  const runs = mock ? [demoRun()] : await getLiveWorkflowRuns();

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Deterministic operations"
        title="Workflow control"
        subtitle="Every durable run, step, retry, provider result, and blocker in one auditable view."
        actions={<OnboardingButton />}
      />

      {runs.length === 0 ? (
        <section className="card card-pad">
          <div className="empty-state" style={{ padding: 32 }}>
            <strong>No activation runs yet</strong>
            Start a creator activation and its steps will appear here.
          </div>
        </section>
      ) : (
        runs.map((run) => <WorkflowRunCard key={run.id} run={run} live={!mock} />)
      )}
    </main>
  );
}

function WorkflowRunCard({ run, live }: { run: LiveWorkflowRun; live: boolean }) {
  const failed = run.steps.find((step) => step.status === "FAILED");
  const resumable = run.status === "WAITING_EXTERNAL" || run.status === "FAILED";
  // Names the step the run is parked on, so the blocker shown is the real one
  // rather than a fixed string that could outlive the condition it describes.
  const waitingStep = run.steps.find((step) => step.status === "WAITING_EXTERNAL");
  const waitingOn =
    run.status === "WAITING_EXTERNAL" && waitingStep
      ? waitingStep.name === "AWAIT_BASELINE_READINESS"
        ? "BASELINE DATA"
        : waitingStep.name.replaceAll("_", " ")
      : null;
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="section-head">
        <div>
          <h2 style={{ marginBottom: 3 }}>{run.creatorName} — Creator Activation</h2>
          <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
            {run.runNumber} · CREATOR_ACTIVATION_V1 · {new Date(run.startedAt).toLocaleString()}
          </span>
        </div>
        <StatusBadge value={run.status} />
      </div>

      <div className="card-pad">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            marginBottom: 7,
          }}
        >
          <strong>Step progress</strong>
          {/* Derived from the steps themselves, so it cannot drift from reality. */}
          <span>
            {run.steps.filter((step) => step.status === "SUCCEEDED").length} of {run.steps.length} ·{" "}
            {run.progressPercent}%
          </span>
        </div>
        <div className="progress" style={{ height: 8 }}>
          <span style={{ width: `${run.progressPercent}%` }} />
        </div>

        {run.blockers.length ? (
          <p className="subtitle" style={{ marginTop: 10 }}>
            Blocked: {run.blockers.join("; ")}
          </p>
        ) : null}
        {failed ? (
          <p className="subtitle" style={{ marginTop: 10, color: "var(--red)" }}>
            Failed at {failed.name.replaceAll("_", " ").toLowerCase()}
            {failed.error ? `: ${failed.error}` : ""}
          </p>
        ) : null}
        {waitingOn ? (
          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 11 }}>Current blocker</strong>
            <div style={{ marginTop: 6 }}>
              {/* Label derives from the step that is actually waiting. */}
              <StatusBadge value="WAITING_EXTERNAL" label={waitingOn} />
            </div>
            <p className="subtitle" style={{ marginTop: 10, lineHeight: 1.6 }}>
              The run resumes from this step without repeating completed provisioning. Unknown stays
              unknown until the data arrives.
            </p>
          </div>
        ) : null}

        {live && resumable && run.creatorId ? (
          <div style={{ marginTop: 12 }}>
            <ResumeWorkflowButton creatorId={run.creatorId} />
          </div>
        ) : null}
      </div>

      <div className="workflow-steps card-pad" style={{ paddingTop: 0 }}>
        {run.steps.map((step, index) => (
          <div className="workflow-step" key={step.name}>
            <span className="step-icon">
              {step.status === "SUCCEEDED"
                ? "✓"
                : step.status === "WAITING_EXTERNAL"
                  ? "…"
                  : step.status === "FAILED"
                    ? "!"
                    : index + 1}
            </span>
            <span>
              {step.name.replaceAll("_", " ").toLowerCase()}
              {step.attempts > 1 ? ` · ${step.attempts} attempts` : ""}
              {step.provider ? ` · ${step.provider}` : ""}
            </span>
            <StatusBadge value={step.status} />
          </div>
        ))}
      </div>
    </section>
  );
}
