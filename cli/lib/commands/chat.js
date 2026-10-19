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

/**
 * TUI-DIVIDER: `quox chat --trace` prints the turn's protocol events as they arrive, so the
 * per-layer AOCL record (`aocl.layer`: id, name, result, ms) is visible in the CLI before any
 * UI animates it. Returns { text, tone } or null for an event --trace does not show.
 * tone: ok | warn | fail | accent (no grey: every tone is a real colour).
 */
const RESULT_TONE = { pass: 'ok', gated: 'warn', blocked: 'fail', bypass: 'accent' };
const fmtTraceMs = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return n < 10 ? `${Math.round(n * 10) / 10} ms` : `${Math.round(n)} ms`;
};
export function formatTraceEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.type) {
    case 'turn.started':
      return { text: `▸ turn.started  ${[ev.provider, ev.model].filter(Boolean).join(' ')}`, tone: 'accent' };
    case 'aocl.layer': {
      const result = String(ev.result || 'pass');
      const line = `▤ aocl.layer  ${String(ev.id || '?').padEnd(4)}${String(ev.name || '').padEnd(10)}${result.padEnd(8)}${fmtTraceMs(ev.ms).padStart(8)}  ${ev.phase || ''}${ev.reason ? `  ${ev.reason}` : ''}`;
      return { text: line, tone: RESULT_TONE[result] || 'accent' };
    }
    case 'aocl.summary':
      return { text: `▤ aocl.summary ${ev.accounted ?? '?'}/${ev.total ?? '?'} accounted · ${ev.passed ?? 0} passed · ${ev.bypassed ?? 0} bypassed · ${ev.rejected ?? 0} rejected${ev.ms != null ? ` · ${fmtTraceMs(ev.ms)}` : ''}`, tone: ev.rejected ? 'fail' : 'ok' };
    case 'aocl.verdict':
      return { text: `▤ aocl.verdict ${ev.layer || 'L8'} ${ev.verdict}${ev.reason ? `: ${ev.reason}` : ''}`, tone: ev.verdict === 'blocked' ? 'fail' : 'warn' };
    case 'trace':
      return { text: `· trace ${ev.protocol || ''} ${ev.label || ''}${ev.detail ? `  ${ev.detail}` : ''}`, tone: 'accent' };
    case 'turn.finished':
      return { text: `▸ turn.finished ${ev.status || ''}${ev.usage?.elapsed_ms != null ? ` · ${ev.usage.elapsed_ms} ms` : ''}`, tone: ev.status === 'completed' ? 'ok' : 'fail' };
    default:
      return null;
  }
}
const TONE_PAINT = { ok: chalk.green, warn: chalk.yellow, fail: chalk.red, accent: chalk.cyan };
function printTrace(ev) {
  const f = formatTraceEvent(ev);
  if (f) process.stderr.write((TONE_PAINT[f.tone] || chalk.cyan)(f.text) + '\n');
}

function generateQueryId() {
  return `CLI_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Consume a chat SSE stream, printing chunks as they arrive.
 * Returns { text, sessionId, agentUsed } once the stream completes.
 */
export async function consumeStream(client, { message, agent, sessionId, context }, { onAgentLabel, trace = false } = {}) {
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

  const iter = client.stream(resolveEndpoint('chat.stream').path, { service: resolveEndpoint('chat.stream').service, body, untilClose: Boolean(trace) })[Symbol.asyncIterator]();
  while (true) {
    let step;
    try {
      step = await iter.next();
    } catch (err) {
      // A refusal before the stream opened carries the layers it really evaluated.
      if (trace && Array.isArray(err?.body?.aocl_layers)) for (const l of err.body.aocl_layers) printTrace({ type: 'aocl.layer', ...l });
      throw err;
    }
    if (step.done) break;
    const event = step.value;
    if (trace) printTrace(event);
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
    .option('--trace', 'print the turn\'s protocol events (per-layer AOCL, traces, summary) to stderr as they arrive')
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
                trace: Boolean(options.trace),
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
            trace: Boolean(options.trace),
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
