import { Document } from "yaml";

export function defaultPipelineSource(
  ownerUserId: string,
  steps: {
    title: string;
    instructions: string;
    fileName?: string;
    description?: string;
  }[],
) {
  const stages = steps.map((_, i) => `stage_${i + 1}`);
  const source: Record<string, unknown> = { kind: "gitlab_yaml", stages };
  steps.forEach((step, i) => {
    source[`node_${i + 1}`] = {
      title: step.title,
      stage: stages[i],
      needs: i ? [`node_${i}`] : [],
      ...(i === steps.length - 1
        ? { when: "manual", owner_user_id: ownerUserId }
        : { instructions: step.instructions }),
      ...(step.fileName
        ? {
            artifacts: {
              files: [
                {
                  name: step.fileName,
                  path: step.fileName,
                  description: step.description ?? "",
                },
              ],
            },
          }
        : {}),
    };
  });
  return new Document(source).toString();
}
