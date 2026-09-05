import {
  MockFileStorageProvider,
  MockNotionProvider,
  MockSlackProvider,
} from "@creatoros/integrations";
import {
  MemoryOnboardingRepository,
  OnboardingService,
  type OnboardingCreator,
} from "@creatoros/workflows";

const repository = new MemoryOnboardingRepository();
export const onboardingService = new OnboardingService(repository, {
  slack: new MockSlackProvider(),
  notion: new MockNotionProvider(),
  files: new MockFileStorageProvider(),
});
export const onboardingCreators: Record<string, OnboardingCreator> = {
  madison: {
    id: "madison",
    creatorNumber: "CR-000001",
    stageName: "Madison Carter",
    stageSlug: "madison",
    status: "ONBOARDING",
    contractSigned: true,
    adultConfirmed: true,
    jurisdictionApproved: true,
    contactEmail: "madison@fictional.demo",
    timezone: "America/Los_Angeles",
    assignedTeam: true,
    teamSlackUserIds: [],
    boundariesCollected: true,
    intakeApplied: true,
    baselineReady: false,
  },
};
