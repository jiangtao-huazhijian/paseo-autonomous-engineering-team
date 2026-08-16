import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { StoredLabGoal } from "@getpaseo/protocol/lab/types";
import { toErrorMessage } from "@/utils/error-messages";

export interface LabGoalHostInput {
  serverId: string;
  serverName: string;
}

export interface AggregatedLabGoal extends StoredLabGoal {
  serverId: string;
  serverName: string;
}

export interface LabGoalHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface LabGoalRuntime {
  getClient(serverId: string): Pick<DaemonClient, "labGoalList"> | null;
  getSnapshot(serverId: string): { connectionStatus: string } | null | undefined;
}

export async function fetchAggregatedLabGoals(input: {
  hosts: readonly LabGoalHostInput[];
  runtime: LabGoalRuntime;
}): Promise<{ goals: AggregatedLabGoal[]; errors: LabGoalHostError[] }> {
  const goals: AggregatedLabGoal[] = [];
  const errors: LabGoalHostError[] = [];
  await Promise.all(
    input.hosts.map(async (host) => {
      if (input.runtime.getSnapshot(host.serverId)?.connectionStatus !== "online") {
        return;
      }
      const client = input.runtime.getClient(host.serverId);
      if (!client) {
        return;
      }
      try {
        const payload = await client.labGoalList();
        if (payload.error) {
          throw new Error(payload.error);
        }
        for (const goal of payload.goals) {
          goals.push({
            ...goal,
            serverId: host.serverId,
            serverName: host.serverName,
          });
        }
      } catch (error) {
        errors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );
  return {
    goals: goals.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    errors,
  };
}
