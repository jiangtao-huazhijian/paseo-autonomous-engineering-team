import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";

/**
 * The durable lifecycle for an Autonomous Lab goal. A goal is intentionally
 * more explicit than a Paseo agent: the evaluator is the only component that
 * can move a goal to `completed`.
 */
export const LabGoalStateSchema = z.enum([
  "draft",
  "queued",
  "planning",
  "implementing",
  "reviewing",
  "verifying",
  "repairing",
  "needs_human",
  "budget_exhausted",
  "blocked",
  "failed",
  "completed",
  "paused",
  "cancelled",
]);
export type LabGoalState = z.infer<typeof LabGoalStateSchema>;

export const LabGoalModeSchema = z.enum(["deliver", "optimize"]);
export type LabGoalMode = z.infer<typeof LabGoalModeSchema>;

export const LabAgentRoleSchema = z.enum(["builder", "reviewer", "verifier"]);
export type LabAgentRole = z.infer<typeof LabAgentRoleSchema>;

export const LabRoleProviderSchema = z.object({
  role: LabAgentRoleSchema,
  provider: AgentProviderSchema,
  model: z.string().trim().min(1).nullable().optional(),
  modeId: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().default(true),
});
export type LabRoleProvider = z.infer<typeof LabRoleProviderSchema>;

export const LabGoalBudgetSchema = z.object({
  maxRounds: z.number().int().positive().default(3),
  maxAgents: z.number().int().positive().default(3),
  maxDurationMinutes: z.number().int().positive().default(120),
  maxRepairRounds: z.number().int().nonnegative().default(2),
  estimatedCostUsd: z.number().nonnegative().nullable().default(null),
});
export type LabGoalBudget = z.infer<typeof LabGoalBudgetSchema>;

export const LabGoalSpecSchema = z.object({
  title: z.string().trim().min(1).max(160),
  repositoryPath: z.string().trim().min(1),
  mode: LabGoalModeSchema,
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  allowedActions: z.array(z.string().trim().min(1)).default([]),
  forbiddenActions: z.array(z.string().trim().min(1)).default([]),
  roleProviders: z.array(LabRoleProviderSchema).min(2),
  budget: LabGoalBudgetSchema,
});
export type LabGoalSpec = z.infer<typeof LabGoalSpecSchema>;

export const LabGateVerdictSchema = z.enum(["passed", "failed", "needs_human"]);
export type LabGateVerdict = z.infer<typeof LabGateVerdictSchema>;

export const LabGateRecordSchema = z.object({
  id: z.string(),
  gate: z.enum(["review", "verification", "acceptance"]),
  verdict: LabGateVerdictSchema,
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).default([]),
  issueFingerprint: z.string().trim().min(1).nullable(),
  createdAt: z.string(),
});
export type LabGateRecord = z.infer<typeof LabGateRecordSchema>;

export const LabGoalTransitionSchema = z.object({
  from: LabGoalStateSchema,
  to: LabGoalStateSchema,
  reason: z.string().trim().min(1),
  at: z.string(),
});
export type LabGoalTransition = z.infer<typeof LabGoalTransitionSchema>;

export const StoredLabGoalSchema = LabGoalSpecSchema.extend({
  id: z.string(),
  state: LabGoalStateSchema,
  stateBeforePause: LabGoalStateSchema.nullable(),
  repairRound: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  transitions: z.array(LabGoalTransitionSchema),
  gateRecords: z.array(LabGateRecordSchema),
});
export type StoredLabGoal = z.infer<typeof StoredLabGoalSchema>;

export type CreateLabGoalInput = LabGoalSpec;
