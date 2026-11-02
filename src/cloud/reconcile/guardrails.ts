import { CreateBudgetCommand, DescribeBudgetCommand } from "@aws-sdk/client-budgets";
import {
  CreateAnomalyMonitorCommand,
  CreateAnomalySubscriptionCommand,
  GetAnomalyMonitorsCommand,
  GetAnomalySubscriptionsCommand,
} from "@aws-sdk/client-cost-explorer";
import { accountId, budgets, costExplorer, log, orUndefined } from "../aws.ts";
import { platform } from "../names.ts";

/** Two monthly budgets are free; the first says "something is running", the second "stop it". */
export const BUDGETS: readonly { name: string; dollars: number }[] = [
  { name: platform.budgetSmall, dollars: 5 },
  { name: platform.budgetLarge, dollars: 20 },
];

/** Anomaly alerts fire for an unexpected jump of at least this many dollars. */
const ANOMALY_DOLLARS = "5";

export async function ensureBudgets(email: string) {
  const account = await accountId();
  for (const budget of BUDGETS) {
    const existing = await orUndefined(
      budgets().send(new DescribeBudgetCommand({ AccountId: account, BudgetName: budget.name })),
      "NotFoundException",
    );
    if (existing) continue;
    await budgets().send(
      new CreateBudgetCommand({
        AccountId: account,
        Budget: {
          BudgetName: budget.name,
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: { Amount: String(budget.dollars), Unit: "USD" },
        },
        NotificationsWithSubscribers: [
          {
            Notification: {
              NotificationType: "ACTUAL",
              ComparisonOperator: "GREATER_THAN",
              Threshold: 100,
              ThresholdType: "PERCENTAGE",
            },
            Subscribers: [{ SubscriptionType: "EMAIL", Address: email }],
          },
          {
            Notification: {
              NotificationType: "FORECASTED",
              ComparisonOperator: "GREATER_THAN",
              Threshold: 100,
              ThresholdType: "PERCENTAGE",
            },
            Subscribers: [{ SubscriptionType: "EMAIL", Address: email }],
          },
        ],
      }),
    );
    log(`  budget $${budget.dollars}/month → ${email}`);
  }
}

/**
 * Cost Anomaly Detection watches every service; a new one appearing on the bill is exactly what it
 * catches. An account may have one per-service monitor, so an existing one is used as is.
 */
export async function ensureAnomalyAlerts(email: string) {
  const monitors = await costExplorer().send(new GetAnomalyMonitorsCommand({}));
  let monitorArn = monitors.AnomalyMonitors?.find(
    (monitor) => monitor.MonitorType === "DIMENSIONAL" && monitor.MonitorDimension === "SERVICE",
  )?.MonitorArn;
  if (!monitorArn) {
    const created = await costExplorer().send(
      new CreateAnomalyMonitorCommand({
        AnomalyMonitor: {
          MonitorName: platform.anomalyMonitor,
          MonitorType: "DIMENSIONAL",
          MonitorDimension: "SERVICE",
        },
      }),
    );
    monitorArn = created.MonitorArn;
    log("  created cost anomaly monitor");
  }
  if (!monitorArn) return;
  const subscriptions = await costExplorer().send(new GetAnomalySubscriptionsCommand({ MonitorArn: monitorArn }));
  const subscribed = subscriptions.AnomalySubscriptions?.some((subscription) =>
    subscription.Subscribers?.some((subscriber) => subscriber.Address === email),
  );
  if (subscribed) {
    log(`  cost anomalies already alert ${email}`);
    return;
  }
  await costExplorer().send(
    new CreateAnomalySubscriptionCommand({
      AnomalySubscription: {
        SubscriptionName: platform.anomalyMonitor,
        MonitorArnList: [monitorArn],
        Subscribers: [{ Type: "EMAIL", Address: email }],
        Frequency: "IMMEDIATE",
        ThresholdExpression: {
          Dimensions: {
            Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
            MatchOptions: ["GREATER_THAN_OR_EQUAL"],
            Values: [ANOMALY_DOLLARS],
          },
        },
      },
    }),
  );
  log(`  cost anomalies ≥ $${ANOMALY_DOLLARS} → ${email}`);
}
