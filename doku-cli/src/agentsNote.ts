import fs from 'node:fs';
import path from 'node:path';
import { readFileOr, removeBlock, upsertBlock } from './managedBlock.js';

/**
 * A note in the project's CLAUDE.local.md telling AI assistants where the private
 * docs live. Needed because git-ignored folders are skipped by ripgrep-based
 * search and @-mention completion, even though direct reads work fine.
 */
export const NOTE_FILE = 'CLAUDE.local.md';

function markers(linkName: string) {
  return { start: `<!-- doku:start ${linkName} -->`, end: `<!-- doku:end ${linkName} -->` };
}

/** Instructions for AI assistants about the linked docs folder. Printed by `doku prompt`. */
export function agentsSnippet(linkName: string): string {
  const dir = `\`${linkName}/\``;
  return [
    `## Private project docs (${dir})`,
    '',
    `${dir} holds this project's private working docs: architecture notes, decisions, task plans, client notes.`,
    "It is managed by doku: a link into a central storage that is synced between machines, excluded from this repo's git.",
    '',
    `- Before larger tasks, check ${dir} for relevant notes; keep them up to date when decisions change.`,
    `- Put new working docs (plans, decision records, notes) in ${dir}, not in the repo.`,
    `- It is git-ignored, so search tools may skip it: list and read ${dir} directly.`,
    `- Never \`git add\` its files or reference them from committed code or docs.`,
    `- Files listed in ${dir}\`.dokuignore\` stay on this machine only (not synced, not zipped); add more with \`doku ignore <path>\`.`,
    `- Edit files inside freely, but never delete, move or recreate the \`${linkName}\` folder itself: it is a link.`,
  ].join('\n');
}

export function addAgentsNote(projectPath: string, linkName: string): void {
  const file = path.join(projectPath, NOTE_FILE);
  const text = readFileOr(file);
  const next = upsertBlock(text, markers(linkName), agentsSnippet(linkName));
  if (next !== text) fs.writeFileSync(file, next);
}

/** Remove the note; deletes the file when nothing else is left in it. Returns whether the file still exists. */
export function removeAgentsNote(projectPath: string, linkName: string): boolean {
  const file = path.join(projectPath, NOTE_FILE);
  if (!fs.existsSync(file)) return false;
  const text = readFileOr(file);
  const next = removeBlock(text, markers(linkName));
  if (next.trim() === '') {
    fs.rmSync(file);
    return false;
  }
  if (next !== text) fs.writeFileSync(file, next);
  return true;
}
