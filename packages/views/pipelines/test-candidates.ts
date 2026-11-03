import { PipelineCandidatesSchema } from "@multica/core/pipelines";
export const testCandidates = PipelineCandidatesSchema.parse({
  squad_id: "s",
  current_user: {
    user_id: "00000000-0000-4000-8000-000000000001",
    member_id: "00000000-0000-4000-8000-000000000002",
    name: "Current human",
  },
  default_owner_user_id: "00000000-0000-4000-8000-000000000001",
  leader_id: "00000000-0000-4000-8000-000000000010",
  humans: [
    {
      user_id: "00000000-0000-4000-8000-000000000001",
      member_id: "00000000-0000-4000-8000-000000000002",
      name: "Current human",
    },
  ],
  agents: ["Planner", "Executor", "Cassia", "Designer"].map((name, i) => ({
    agent_id: `00000000-0000-4000-8000-00000000001${i}`,
    name,
    role: i === 0 ? "leader" : "",
    can_invoke: true,
    reason: "",
    is_leader: i === 0,
  })),
});
