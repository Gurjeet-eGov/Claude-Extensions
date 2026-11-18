// Writes prompts/*.md from apps-script/prompts.gs so the exact text that
// "Copy for Claude" produces can be read and reviewed in the repo.
//   npm run prompts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCore, ROOT } from '../dev/load.mjs';

export function renderPromptDocs() {
  const { TRPrompts } = loadCore();
  const t = TRPrompts.TEMPLATES;
  const doc = (title, intro, body) => `# ${title}\n\n${intro}\n\nGenerated from \`apps-script/prompts.gs\` by \`npm run prompts\`. Do not edit by hand.\n\nWords in \`{{double braces}}\` are filled in by the console from the selected items only.\n\n\`\`\`\`text\n${body}\n\`\`\`\`\n`;
  return {
    'draft-scenarios.md': doc(
      'Prompt: write up findings as test cases',
      'Built when a tester selects findings and clicks **Copy for Claude** on the Findings screen. It carries the selected findings, the scenario titles of related cases (for the duplicate check), and the Feature / Sub feature / Test type values already used in the tab. No names, emails or sheet links.',
      t.draftScenarios.replace('{{houseStyle}}', TRPrompts.HOUSE_STYLE),
    ),
    'plan-paths.md': doc(
      'Prompt: plan test paths',
      'Built when a tester clicks **Copy for Claude** under Test paths on the Plan screen. It carries one line per case: ID, feature, sub feature, test type, pre condition and scenario.',
      t.planPaths,
    ),
  };
}

if (process.argv[1] && process.argv[1].endsWith('export-prompts.mjs')) {
  const dir = join(ROOT, 'prompts');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(renderPromptDocs())) {
    writeFileSync(join(dir, name), text);
    console.log(`wrote prompts/${name}`);
  }
}
