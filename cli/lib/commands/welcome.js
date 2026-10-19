/**
 * quox welcome: print the greeting from the first screen again. Read only: no server, no login, and it never
 * touches the first-run marker or any config.
 */
export function registerWelcomeCommand(program) {
  program
    .command('welcome')
    .description('Show the welcome screen again (read only; changes no setup or config)')
    .action(async () => {
      const { INTRO_HEAD, INTRO_LINES } = await import('../quoxon/render.js');
      const { packageVersion } = await import('../quoxon/welcome.js');
      console.log([INTRO_HEAD, ...INTRO_LINES, `${packageVersion()} · ${process.cwd()}`].join('\n'));
    });
}
