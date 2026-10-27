import type { Budgets } from "./project-config.js";
import type { Task, TaskEvent, TaskState } from "./types.js";

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";

  constructor(
    readonly state: TaskState,
    readonly event: TaskEvent,
  ) {
    super(`Invalid transition: ${state} --${event}-->`);
  }
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["rejected", "merged", "cancelled"]);

/** `budgets` caps the retries sent back to in_progress; one more failure escalates. */
export function transition(task: Task, event: TaskEvent, budgets: Budgets): Task {
  const next = nextFields(task, event, budgets);
  if (next === null) {
    throw new InvalidTransitionError(task.state, event);
  }
  return { ...task, ...next };
}

function nextFields(task: Task, event: TaskEvent, budgets: Budgets): Partial<Task> | null {
  if (event === "cancel") {
    return TERMINAL_STATES.has(task.state) ? null : { state: "cancelled" };
  }

  switch (`${task.state}:${event}`) {
    case "proposed:approve":
      return { state: "approved" };
    case "proposed:reject":
      return { state: "rejected" };
    case "approved:plan":
      return { state: "planned" };
    case "planned:start":
      return { state: "in_progress" };
    case "in_progress:run_checks":
      return { state: "checks" };
    case "checks:checks_passed":
      return { state: "in_review" };
    case "checks:checks_failed":
      return task.checkIterations < budgets.checkIterations
        ? { state: "in_progress", checkIterations: task.checkIterations + 1 }
        : { state: "escalated" };
    case "in_review:request_changes":
      return task.reviewIterations < budgets.reviewIterations
        ? { state: "in_progress", reviewIterations: task.reviewIterations + 1 }
        : { state: "escalated" };
    case "in_review:approve":
      return { state: task.riskClass === "low" ? "merged" : "awaiting_merge" };
    case "awaiting_merge:merge":
      return { state: "merged" };
    default:
      return null;
  }
}
