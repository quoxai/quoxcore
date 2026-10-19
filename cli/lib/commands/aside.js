/**
 * quox aside "<question>"
 *
 * A read-only side question: the model gets no tools and no conversation, so nothing it says can change
 * anything or land in a conversation's history. The TUI's /aside is the same call with the recent
 * exchanges passed as read-only context.
 */
import { askAside } from '../core/aside.js';

export function registerAsideCommand(program, ctx) {
  const { client, auth } = ctx;
  program
    .command('aside')
    .description('Ask a read-only side question: no tools, not saved to any conversation')
    .argument('<question...>', 'the question')
    .option('--agent <id>', 'who answers (default quox)')
    .action(async (words, opts) => {
      auth.requireAuth();
      const r = await askAside(client, { question: words.join(' '), agent: opts.agent });
      if (program.opts().output === 'json') { console.log(JSON.stringify({ answer: r.text, model: r.model, provider: r.provider, tools_used: r.tools, read_only: true }, null, 2)); return; }
      console.log(r.text || '(no answer)');
      console.log(`· aside, read only: no tools, not saved${r.model ? ` · ${r.provider ? `${r.provider}/` : ''}${r.model}` : ''}`);
    });
}
