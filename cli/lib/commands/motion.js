/**
 * quox motion: play the Quox motion gallery (every Q animation, captioned). No server needed.
 * CLI-QUOX lab parity: the product version of ~/quoxon-work/intro/lab.
 */
export function registerMotionCommand(program) {
  program
    .command('motion')
    .description('Play the Quox motion gallery: the Q intro, portal, particle, the Dragon\'s Eye, the status Q, ring, reveals and the living dragon (no server needed)')
    .argument('[scenes...]', 'only these: orbit portal particle eye hello perpetual ring fx dragon dragon-fire dragon-moods')
    .option('--narrow', 'use the 40-column layout (the compact Q)')
    .option('--slow', 'play three times slower')
    .option('--mono', 'no colour (also honoured: NO_COLOR)')
    .action(async (scenes, opts) => {
      const { runGallery } = await import('../quoxon/gallery.js');
      try {
        await runGallery({ only: scenes || [], narrow: Boolean(opts.narrow), slow: Boolean(opts.slow), mono: Boolean(opts.mono) });
      } catch (e) {
        console.error(e.message);
        process.exitCode = 2;
      }
    });
}
