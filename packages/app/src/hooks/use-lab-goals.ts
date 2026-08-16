import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  fetchAggregatedLabGoals,
  type AggregatedLabGoal,
  type LabGoalHostError,
} from "@/lab/aggregated-goals";

export function useLabGoals(): {
  goals: AggregatedLabGoal[];
  errors: LabGoalHostError[];
  isLoading: boolean;
  refetch: () => void;
} {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const statusKey = useMemo(
    () => serverIds.map((serverId) => statuses.get(serverId) ?? "connecting").join("|"),
    [serverIds, statuses],
  );
  const query = useFetchQuery({
    queryKey: ["lab-goals", serverIds.join("|"), statusKey],
    queryFn: () =>
      fetchAggregatedLabGoals({
        hosts: hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
        runtime,
      }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });
  return {
    goals: query.data?.goals ?? [],
    errors: query.data?.errors ?? [],
    isLoading: query.isLoading,
    refetch: () => {
      void query.refetch();
    },
  };
}
