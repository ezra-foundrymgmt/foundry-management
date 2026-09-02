export interface PnlInput {
  creatorPlatformReceipts: number;
  commissionRate: number;
  fanOpsLabor: number;
  creatorSuccessLabor: number;
  editingCost: number;
  growthLabor: number;
  creatorSpecificSoftware: number;
  promotionCost: number;
  paidTrafficCost: number;
  contractorCost: number;
  otherDirectCost: number;
}

export function calculateCreatorPnl(input: PnlInput) {
  const foundryRevenue = input.creatorPlatformReceipts * input.commissionRate;
  const directCost =
    input.fanOpsLabor +
    input.creatorSuccessLabor +
    input.editingCost +
    input.growthLabor +
    input.creatorSpecificSoftware +
    input.promotionCost +
    input.paidTrafficCost +
    input.contractorCost +
    input.otherDirectCost;
  const contributionProfit = foundryRevenue - directCost;
  const contributionMargin = foundryRevenue === 0 ? null : contributionProfit / foundryRevenue;
  return { foundryRevenue, directCost, contributionProfit, contributionMargin };
}
