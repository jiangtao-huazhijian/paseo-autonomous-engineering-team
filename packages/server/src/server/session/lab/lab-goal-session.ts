import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { LabGoalService } from "../../lab/service.js";

export interface LabGoalSessionOptions {
  host: { emit(message: SessionOutboundMessage): void };
  service: LabGoalService;
  logger: pino.Logger;
}

type LabRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "lab.goal.create.request"
      | "lab.goal.list.request"
      | "lab.goal.inspect.request"
      | "lab.goal.action.request";
  }
>;

export class LabGoalSession {
  constructor(private readonly options: LabGoalSessionOptions) {}

  private emitError(request: LabRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.logger.error({ err: error, requestType: request.type }, "Lab goal request failed");
    this.options.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "lab_goal_request_failed",
      },
    });
  }

  async dispatch(request: LabRequest): Promise<void> {
    try {
      switch (request.type) {
        case "lab.goal.create.request": {
          const { type: _type, requestId, ...input } = request;
          this.options.host.emit({
            type: "lab.goal.create.response",
            payload: { requestId, goal: await this.options.service.create(input), error: null },
          });
          return;
        }
        case "lab.goal.list.request":
          this.options.host.emit({
            type: "lab.goal.list.response",
            payload: {
              requestId: request.requestId,
              goals: await this.options.service.list(),
              error: null,
            },
          });
          return;
        case "lab.goal.inspect.request":
          this.options.host.emit({
            type: "lab.goal.inspect.response",
            payload: {
              requestId: request.requestId,
              goal: await this.options.service.inspect(request.goalId),
              error: null,
            },
          });
          return;
        case "lab.goal.action.request":
          this.options.host.emit({
            type: "lab.goal.action.response",
            payload: {
              requestId: request.requestId,
              goal: await this.options.service.action(
                request.goalId,
                request.action,
                request.reason,
                request.issueId,
              ),
              error: null,
            },
          });
          return;
      }
    } catch (error) {
      this.emitError(request, error);
    }
  }
}
