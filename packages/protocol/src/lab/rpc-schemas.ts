import { z } from "zod";
import { LabGateRecordSchema, LabGoalSpecSchema, StoredLabGoalSchema } from "./types.js";

export const LabGoalCreateRequestSchema = LabGoalSpecSchema.extend({
  type: z.literal("lab.goal.create.request"),
  requestId: z.string(),
});

export const LabGoalListRequestSchema = z.object({
  type: z.literal("lab.goal.list.request"),
  requestId: z.string(),
});

export const LabGoalInspectRequestSchema = z.object({
  type: z.literal("lab.goal.inspect.request"),
  requestId: z.string(),
  goalId: z.string(),
});

export const LabGoalActionRequestSchema = z.object({
  type: z.literal("lab.goal.action.request"),
  requestId: z.string(),
  goalId: z.string(),
  action: z.enum(["queue", "pause", "resume", "cancel", "start", "mark-blocked", "waive-issue"]),
  reason: z.string().trim().min(1).optional(),
  issueId: z.string().trim().min(1).optional(),
});

/** Internal/evaluator-only RPC. The service still validates legal transitions. */
export const LabGoalGateRecordRequestSchema = z.object({
  type: z.literal("lab.goal.gate-record.request"),
  requestId: z.string(),
  goalId: z.string(),
  record: LabGateRecordSchema,
});

const GoalPayloadSchema = z.object({
  requestId: z.string(),
  goal: StoredLabGoalSchema.nullable(),
  error: z.string().nullable(),
});

export const LabGoalCreateResponseSchema = z.object({
  type: z.literal("lab.goal.create.response"),
  payload: GoalPayloadSchema,
});

export const LabGoalInspectResponseSchema = z.object({
  type: z.literal("lab.goal.inspect.response"),
  payload: GoalPayloadSchema,
});

export const LabGoalActionResponseSchema = z.object({
  type: z.literal("lab.goal.action.response"),
  payload: GoalPayloadSchema,
});

export const LabGoalGateRecordResponseSchema = z.object({
  type: z.literal("lab.goal.gate-record.response"),
  payload: GoalPayloadSchema,
});

export const LabGoalListResponseSchema = z.object({
  type: z.literal("lab.goal.list.response"),
  payload: z.object({
    requestId: z.string(),
    goals: z.array(StoredLabGoalSchema),
    error: z.string().nullable(),
  }),
});
