export type RiskClass = "low" | "medium" | "high";

export type TaskState =
  | "proposed"
  | "approved"
  | "rejected"
  | "planned"
  | "in_progress"
  | "checks"
  | "in_review"
  | "awaiting_merge"
  | "merged"
  | "escalated"
  | "cancelled";

export type TaskEvent =
  | "approve"
  | "reject"
  | "plan"
  | "start"
  | "run_checks"
  | "checks_passed"
  | "checks_failed"
  | "request_changes"
  | "merge"
  | "cancel";

export interface Task {
  readonly id: string;
  readonly projectPath: string;
  readonly title: string;
  readonly specPath: string;
  readonly riskClass: RiskClass;
  readonly state: TaskState;
  /** Number of failed checks sent back to in_progress. */
  readonly checkIterations: number;
  /** Number of review change requests sent back to in_progress. */
  readonly reviewIterations: number;
}
