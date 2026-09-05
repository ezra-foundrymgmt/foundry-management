import { AccessDenied } from "@/components/access-denied";
import { IntakeReviewList } from "@/components/intake-review-list";
import { LiveEmpty } from "@/components/live-empty";
import { PageHeader } from "@/components/page-header";
import { listIntakeSubmissions } from "@/lib/creator-intake";
import { isMockMode } from "@/lib/environment";
import { getLiveCreators } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/**
 * Where a creator's Model Information Sheet is read before any of it reaches
 * her record.
 *
 * A server component because the submission and the creator list both come from
 * the service layer, and going through an API route would only add a round trip
 * and a second place for the shape to drift. The actions live in a client
 * component below it.
 */
export default async function IntakePage() {
  const access = await authorizePage("creator.read");
  if (!access.allowed)
    return <AccessDenied title="Intake review" permission="creator.read" reason={access.reason} />;

  if (isMockMode())
    return (
      <main className="page">
        <PageHeader
          eyebrow="Onboarding"
          title="Intake review"
          subtitle="Model Information Sheet submissions, read before anything is written to a creator."
        />
        <LiveEmpty
          title="Intake is a live-mode feature"
          hint="Submissions arrive from the real Google Form, so there is nothing meaningful to show in demo mode."
        />
      </main>
    );

  const [submissions, creators] = await Promise.all([
    listIntakeSubmissions(access.session),
    getLiveCreators(),
  ]);

  return (
    <main className="page">
      <PageHeader
        eyebrow="Onboarding"
        title="Intake review"
        subtitle="What each creator told us, and exactly what would be written if you apply it. Nothing here has touched a creator record yet."
      />
      {submissions.length === 0 ? (
        <LiveEmpty
          title="No submissions yet"
          hint="Issue an intake link from a creator's page, and her answers appear here once she submits the form."
        />
      ) : (
        <IntakeReviewList
          submissions={submissions}
          creators={creators.map((creator) => ({
            id: creator.id,
            label: `${creator.stageName} · ${creator.creatorNumber}`,
          }))}
        />
      )}
    </main>
  );
}
