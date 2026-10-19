/**
 * File commands: upload, download, list, delete
 */

import { createWriteStream, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerFileCommands(program, ctx) {
  const { client, auth } = ctx;

  const file = program
    .command('file')
    .description('Manage files');

  file
    .command('list')
    .description('List files')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('files.list').path, { service: resolveEndpoint('files.list').service });
      formatOutput({
        columns: ['id', 'name', 'size', 'type', 'created_at'],
        headers: ['ID', 'Name', 'Size', 'Type', 'Created'],
        rows: data.files || data,
      }, { format: program.opts().output });
    });

  file
    .command('upload')
    .description('Upload a file')
    .argument('<path>', 'local file path')
    .option('--name <name>', 'override filename')
    .action(async (filePath, options) => {
      auth.requireAuth();
      // fleet #381: node:buffer exports Blob but has NEVER exported
      // FormData (it's a global from undici on Node >= 18). Destructuring
      // it here yielded undefined and shadowed the working global, so
      // `new FormData()` threw "FormData is not a constructor" — this
      // command had never once worked.
      const { Blob } = await import('node:buffer');
      const { readFile } = await import('node:fs/promises');

      const content = await readFile(filePath);
      const fileName = options.name || basename(filePath);

      const formData = new FormData();
      // Field name must be 'files' (plural): the files service parses with
      // multer's `upload.array('files', 100)`. Sending 'file' leaves
      // req.files undefined, and the route's `for (const file of req.files)`
      // then throws — measured against the live service as a 500 with zero
      // files stored, vs 200 + 1 stored for 'files'. So this is a genuine
      // second bug: fixing the FormData crash alone would have swapped a
      // client-side crash for a server-side 500, still with no upload.
      formData.append('files', new Blob([content]), fileName);

      const data = await client.post(resolveEndpoint('files.upload').path, {
        service: resolveEndpoint('files.upload').service,
        body: formData,
        timeout: 120000,
      });
      // The route responds {success, files: [{id, originalName, ...}]}.
      // Report the id the server actually stored, and refuse to claim
      // success when it stored nothing — the old fallback to the local
      // fileName would print "File uploaded" for an empty result set.
      const uploaded = data.files?.[0];
      if (!uploaded?.id) {
        throw new Error(`Upload failed: server accepted the request but stored no file (got: ${JSON.stringify(data).slice(0, 120)})`);
      }
      printSuccess(`File uploaded: ${uploaded.id}${uploaded.originalName ? ` (${uploaded.originalName})` : ''}`);
    });

  file
    .command('download')
    .description('Download a file')
    .argument('<fileId>', 'file ID')
    // fleet #384: this used to be `--output <path>`, which collided with the
    // global `-o, --output <format>` (table|json|csv|quiet) declared in
    // bin/quox.js. Commander binds the value to the PARENT option, so the
    // subcommand's options.output was always undefined and the file-write
    // branch below was unreachable — every download fell through to stdout.
    // Renamed rather than made clever: guessing whether an --output value is
    // "a format" or "a path" is exactly the kind of heuristic that breaks
    // later. --output never worked here, so nothing can depend on it.
    .option('--dest <path>', 'write the file to this path (the global -o/--output sets output FORMAT, not a path)')
    .action(async (fileId, options) => {
      auth.requireAuth();
      const res = await client.get(resolveEndpoint('file.get', { fileId }).path, { service: resolveEndpoint('file.get', { fileId }).service, raw: true });

      if (!res.ok) {
        throw new Error(`Download failed: ${res.status}`);
      }

      const { pipeline } = await import('node:stream/promises');

      if (options.dest) {
        const writer = createWriteStream(options.dest);
        await pipeline(res.body, writer);
        printSuccess(`Downloaded to ${options.dest}`);
      } else {
        // Stream the raw body. This used to be `res.text()`, which UTF-8
        // decodes: any byte sequence that isn't valid UTF-8 became U+FFFD,
        // so a piped binary came out corrupted AND larger than the original
        // (measured 1.77x on a PNG). Piping the body preserves bytes exactly.
        await pipeline(res.body, process.stdout);
      }
    });

  file
    .command('delete')
    .description('Delete a file')
    .argument('<fileId>', 'file ID')
    .action(async (fileId) => {
      auth.requireAuth();
      await client.delete(resolveEndpoint('file.delete', { fileId }).path, { service: resolveEndpoint('file.delete', { fileId }).service });
      printSuccess('File deleted.');
    });

  file
    .command('stats')
    .description('Show file storage stats')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('files.stats').path, { service: resolveEndpoint('files.stats').service });
      formatDetail(data.stats || data, { format: program.opts().output, title: 'File Storage Stats' });
    });

  // F01 A': legacy files with no proven owner are hidden from every org until a human instance admin assigns them.
  file
    .command('quarantine')
    .description('List files with no proven owner org (instance admin only)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('files.quarantine.list');
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({ columns: ['id', 'name', 'size'], headers: ['ID', 'Name', 'Size'], rows: data.files || [] }, { format: program.opts().output });
    });

  file
    .command('assign')
    .description('Assign a quarantined file to an org (instance admin only; witnessed): <fileId> --org <orgId>, or --from-report <dry-run.json>')
    .argument('[fileId]', 'quarantined file id')
    .option('--org <orgId>', 'org that owns the file')
    .option('--from-report <path>', 'an owner-approved backfill dry-run report: assigns only rows with a derived owner')
    .action(async (fileId, options) => {
      auth.requireAuth();
      let assignments;
      if (options.fromReport) {
        const report = JSON.parse(readFileSync(options.fromReport, 'utf8'));
        assignments = (report.rows || []).filter((r) => r && r.id && r.orgId).map((r) => ({ file_id: r.id, org_id: r.orgId }));
        if (!assignments.length) throw new Error('The report has no rows with a derived owner; nothing to assign.');
      } else if (fileId) {
        if (!options.org) throw new Error('Give the owning org: quox file assign <fileId> --org <orgId>');
        assignments = [{ file_id: fileId, org_id: options.org }];
      } else {
        throw new Error('Give <fileId> --org <orgId>, or --from-report <dry-run.json>');
      }
      const ep = resolveEndpoint('files.quarantine.assign');
      const data = await client.post(ep.path, { service: ep.service, body: { assignments } });
      formatOutput({ columns: ['file_id', 'org_id', 'ok', 'error'], headers: ['File', 'Org', 'Assigned', 'Error'], rows: data.results || [] }, { format: program.opts().output });
      const failed = (data.results || []).filter((r) => !r.ok).length;
      if (failed) { process.exitCode = 1; } else { printSuccess(`Assigned ${assignments.length} file(s).`); }
    });
}
