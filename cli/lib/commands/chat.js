/**
 * Chat commands: send, stream, status
 */

import chalk from 'chalk';
import { formatDetail } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

/**
 * Build the POST body for /chat/stream (quox#782). The prompt and context
 * travel in the JSON body, never in the URL. The name is kept for callers;
 * the collector reads `assistant` (not `selected_agent`, the POST /chat key).
 */
export function buildStreamQuery({ queryId, message, agent, sessionId, context }) {
  const body = {
    query_id: queryId,
    prompt: message,
    assistant: agent || 'quox',
  };
  if (sessionId) body.session_id = sessionId;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) body.timezone = tz;
  } catch { /* best-effort */ }
  if (context) body.context = context;
  return body;
}

function generateQueryId() {
  return `CLI_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Consume a chat SSE stream, printing chunks as they arrive.
 * Returns { text, sessionId, agentUsed } once the stream completes.
 */
export async function consumeStream(client, { message, agent, sessionId, context }, { onAgentLabel } = {}) {
  const queryId = generateQueryId();
  const body = buildStreamQuery({ queryId, message, agent, sessionId, context });

  let text = '';
  let resultSessionId = sessionId;
  let agentUsed = agent;
  let labelPrinted = false;
  let sawChunk = false;

  const printLabel = () => {
    if (labelPrinted) return;
    labelPrinted = true;
    onAgentLabel?.(agentUsed);
  };

  for await (const event of client.stream(resolveEndpoint('chat.stream').path, { service: resolveEndpoint('chat.stream').service, body })) {
    switch (event.type) {
      case 'connected':
        break;

      case 'thinking': {
        const stage = event.stage || '';
        if (stage === 'tool_call' || stage.includes('tool')) {
          console.log(chalk.dim(`  ⚙ using tool: ${event.message}`));
        } else if (process.argv.includes('--verbose') || process.argv.includes('-v')) {
          console.log(chalk.dim(`  … ${event.message}`));
        }
        break;
      }

      case 'chunk':
        printLabel();
        sawChunk = true;
        process.stdout.write(event.content || '');
        text += event.content || '';
        break;

      case 'done':
        if (!sawChunk && event.full_response) {
          printLabel();
          process.stdout.write(event.full_response);
          text = event.full_response;
        }
        if (event.session_id) resultSessionId = event.session_id;
        if (event.agent_used) agentUsed = event.agent_used;
        console.log();
        break;

      case 'error':
        throw new Error(event.error || 'Stream error');

      default:
        break;
    }
  }

  return { text, sessionId: resultSessionId, agentUsed };
}

/** One-shot (non-streaming) chat via POST /chat/claude. */
async function sendOneShot(client, { message, agent, sessionId }) {
  const body = { prompt: message };
  if (agent) body.selected_agent = agent;
  if (sessionId) body.session_id = sessionId;

  const data = await client.post(resolveEndpoint('chat.claude').path, {
    service: resolveEndpoint('chat.claude').service,
    body,
    timeout: 120000,
  });

  const response = data.result || data.response || data.text || JSON.stringify(data);
  return { data, response, sessionId: data.session_id || sessionId };
}

export function registerChatCommands(program, ctx) {
  const { client, auth } = ctx;

  const chat = program
    .command('chat')
    .description('Chat with CommanderQ or any agent, streaming by default')
    .argument('[message]', 'message to send (omit for interactive mode)')
    .option('--agent <name>', 'route to a specific agent (e.g. sentinel, cipher, nova)')
    .option('--no-stream', 'disable streaming output (one-shot request/response)')
    .option('--conversation <id>', 'continue a conversation (session id)')
    .action(async (message, options) => {
      auth.requireAuth();
      const streaming = options.stream !== false;

      // Interactive mode if no message
      if (!message) {
        const { default: inquirer } = await import('inquirer');
        let currentAgent = options.agent || 'quox';
        let sessionId = options.conversation;

        console.log(chalk.bold(currentAgent.toUpperCase()) + chalk.dim(' | Type /exit to quit, /agent <name> to switch agent\n'));

        while (true) {
          const ans = await inquirer.prompt([{
            type: 'input',
            name: 'message',
            message: chalk.cyan('You:'),
          }]);

          const input = (ans.message || '').trim();
          if (!input || input === '/exit') break;

          if (input.startsWith('/agent')) {
            const next = input.slice('/agent'.length).trim();
            if (next) {
              currentAgent = next.toLowerCase();
              console.log(chalk.dim(`Switched to agent: ${currentAgent}\n`));
            } else {
              console.log(chalk.dim(`Current agent: ${currentAgent}\n`));
            }
            continue;
          }

          try {
            if (streaming) {
              const result = await consumeStream(client, {
                message: input,
                agent: currentAgent,
                sessionId,
              }, {
                onAgentLabel: (agentUsed) => process.stdout.write(chalk.green(`${(agentUsed || currentAgent).toUpperCase()}: `)),
              });
              if (result.sessionId) sessionId = result.sessionId;
              console.log();
            } else {
              const { response, sessionId: newSessionId } = await sendOneShot(client, {
                message: input,
                agent: currentAgent,
                sessionId,
              });
              if (newSessionId) sessionId = newSessionId;
              console.log(chalk.green(`${currentAgent.toUpperCase()}:`), response);
              console.log();
            }
          } catch (err) {
            console.error(chalk.red(`Error: ${err.message}`));
          }
        }
        return;
      }

      // Single message mode
      if (streaming) {
        try {
          await consumeStream(client, {
            message,
            agent: options.agent,
            sessionId: options.conversation,
          }, {
            onAgentLabel: () => {}, // no label prefix in single-shot streaming; just print tokens
          });
        } catch (err) {
          console.error(chalk.red(`Error: ${err.message}`));
          process.exitCode = 1;
        }
        return;
      }

      const ora = (await import('ora')).default;
      const spinner = ora('Thinking...').start();

      try {
        const { data, response } = await sendOneShot(client, {
          message,
          agent: options.agent,
          sessionId: options.conversation,
        });
        spinner.stop();

        if (program.opts().output === 'json') {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(response);

          if (data.tools_used?.length) {
            console.log(chalk.dim(`\nTools used: ${data.tools_used.join(', ')}`));
          }
        }
      } catch (err) {
        spinner.fail('Failed');
        throw err;
      }
    });

  // quox chat status
  program
    .command('chat-status')
    .description('Check chat service status')
    .action(async () => {
      // Token attached when logged in: the collector auth gate 401s this
      // route without a JWT (noAuth previously made it fail even when logged in).
      const data = await client.get(resolveEndpoint('chat.status.list').path, { service: resolveEndpoint('chat.status.list').service });
      formatDetail(data, {
        format: program.opts().output,
        title: 'Chat Status',
      });
    });
}
