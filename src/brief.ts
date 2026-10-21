import type { HandoffBrief, HandoffRecord } from "./contract.js";

export function renderBrief(brief: HandoffBrief): string {
  const sections: [string, string | undefined][] = [
    ["Task", brief.task],
    ["Done so far", brief.done],
    ["Decisions", brief.decisions],
    ["Files", brief.files?.length ? brief.files.map((file) => `- ${file}`).join("\n") : undefined],
    ["Next step", brief.nextStep],
    ["How to verify", brief.verification],
  ];
  return [
    `# ${brief.title}`,
    ...sections.filter(([, body]) => body?.trim()).map(([heading, body]) => `\n## ${heading}\n\n${body!.trim()}`),
    "",
  ].join("\n");
}

export function continuationPrompt(record: HandoffRecord): string {
  const context = record.transferSession
    ? "Your earlier conversation was moved here with you. The brief below summarizes where it ended."
    : "You are continuing work another agent started. The brief below is everything it handed over.";
  return [
    `agent-handoff moved this task from the user's machine to a cloud sandbox (handoff ${record.id}).`,
    `The repository is at ${record.remoteDir} on branch ${record.resultBranch}. It includes every local change, including uncommitted work.`,
    context,
    "The user may be offline. Do not wait for answers. Make reasonable decisions and note them in your commit messages.",
    "Commit your work as you go. When the task is done, stop. The runner pushes the branch and opens a draft pull request.",
    "",
    renderBrief(record.brief),
  ].join("\n");
}
