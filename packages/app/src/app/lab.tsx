import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { LabGoalsScreen } from "@/screens/lab-goals-screen";

export default function LabRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <LabGoalsScreen />
    </HostRouteBootstrapBoundary>
  );
}
