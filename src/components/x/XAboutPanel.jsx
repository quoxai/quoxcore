/**
 * XAboutPanel: the X plugin's About tab. X-PLUGIN phase 11.
 *
 * Static explainer only: no props, no network calls, no state. It exists so
 * a reader can understand what the plugin is, how compose and approval work,
 * what the budgets and read costs actually are, how to reach it from chat,
 * workflows and the CLI, and where the honest limits sit, all in one place
 * rather than scattered across tooltips.
 */

const CLI_COMMANDS = [
  { cmd: 'quox x post <text>', desc: 'draft a post, files an approval card' },
  { cmd: 'quox x thread <file>', desc: 'draft a thread from a file, blank-line separated blocks, an !image: <path> line attaches an image' },
  { cmd: 'quox x delete <tweet_id>', desc: 'file an approval card to delete a post' },
  { cmd: 'quox x status', desc: 'posting budget usage and credential health' },
  { cmd: 'quox x media-root', desc: 'print the directory image files must live under' },
]

const POLL_COSTS = [
  { interval: 'Every 15 minutes', cost: 'about $14.40 a month' },
  { interval: 'Hourly', cost: 'about $3.60 a month' },
  { interval: 'Every 6 hours', cost: 'about $0.60 a month' },
  { interval: 'Daily', cost: 'about $0.15 a month' },
]

export default function XAboutPanel() {
  return (
    <section className="qx-card xs-about">
      <div className="qx-stack">
        <div className="qx-stack qx-stack--tight xs-about__block">
          <h3 style={{ margin: 0 }}>About the X plugin</h3>
          <p>
            This is a governed connector for X, not a content engine. It is the pipe and the
            approval gate. Other plugins own content generation, campaigns and scheduling.
          </p>
        </div>

        <div className="qx-stack qx-stack--tight xs-about__block">
          <span className="qx-section-title xs-title">What it is</span>
          <ul>
            <li>
              Nothing posts directly. Drafting files an approval card in the inbox and returns
              immediately with &quot;awaiting approval&quot;. Publishing happens only when a human
              approves, and the approval is what drives the publish.
            </li>
            <li>
              Credentials are OAuth 1.0a and live in the encrypted vault. They are resolved at
              publish time and never travel in the approval card.
            </li>
            <li>Every approval and every publish emits AEE evidence and is WARD witnessed.</li>
          </ul>
        </div>

        <div className="qx-stack qx-stack--tight xs-about__block">
          <span className="qx-section-title xs-title">How to compose and approve</span>
          <ul>
            <li>
              Compose tab: write a post or a thread, optionally attach up to 4 images (png, jpg,
              webp, gif, up to 5MB each) either by uploading them or by picking them out of the
              org media library, then either save it as a draft or, if you are an org owner or
              admin, send it in one step with the black Send now button.
            </li>
            <li>
              Send now files the same approval card and then approves it. It is not a
              shortcut around the gate: the budget claim, the replay guard, the credential binding
              and the evidence all live on the approval path.
            </li>
            <li>
              Approve and schedule approves the post now and delays only the publish. It goes out at
              the time you choose with no further tap, so treat it as posting. Your approval, the
              approver and both timestamps are recorded, and the post holds a slot in your posting
              budget from the moment you approve it.
            </li>
            <li>
              A scheduled post can be cancelled by an owner or admin from the Activity tab at any
              point before it fires, which hands its budget slot back. Once it has started
              publishing it cannot be cancelled, because it may already have reached X.
            </li>
            <li>
              If a scheduled publish fails, it is retried a few times with a growing gap and then
              given up on. Nothing is posted, the budget slot is released, and an item lands in your
              inbox saying so. If the server stops mid-publish, that post is NOT retried, because
              retrying could publish it twice; you are told to check the account instead.
            </li>
            <li>
              Only a human owner or admin can schedule a publish. Agents cannot: agent-initiated
              posts keep full approval-per-post exactly as before, so an agent can never
              pre-authorise its own future publish.
            </li>
            <li>
              Non-admins can save drafts. Approving is for owners and admins, because X approval
              cards are assigned to them.
            </li>
          </ul>
        </div>

        <div className="qx-stack qx-stack--tight xs-about__block">
          <span className="qx-section-title xs-title">Budgets and costs</span>
          <ul>
            <li>
              Posting limits default to 17 posts per 24 hours and 500 per 30 days, which are X's
              free tier per-user caps. Both windows are rolling, counted from each post, not reset
              at midnight.
            </li>
            <li>
              An org owner or admin can change the limits on the Budget tab. Ceilings: 1 to 100
              posts a day, 1 to 1500 per 30 days, 1 to 1000 reads a day.
            </li>
            <li>
              Limits are enforced server-side twice: when the draft is filed and again inside the
              transaction that reserves the slot at approval time. A post that would exceed the
              budget is refused by the collector.
            </li>
            <li>
              Reads are pay per use at roughly $0.005 each. One engagement refresh is one read.
              Reading the account identity, the budget, the activity list and this page costs
              nothing, because they are served from the collector's own store.
            </li>
            <li>Mentions polling is off by default. When on, each check is one read.</li>
          </ul>

          <table className="qx-table">
            <thead>
              <tr>
                <th>Polling interval</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {POLL_COSTS.map((row) => (
                <tr key={row.interval}>
                  <td>{row.interval}</td>
                  <td>{row.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="qx-stack qx-stack--tight xs-about__block">
          <span className="qx-section-title xs-title">Using it from chat (CommanderQ delegation)</span>
          <ul>
            <li>
              The agent is called HERALD, the Herald social suite voice, with X as its first
              channel. Its agent id is <code className="qx-code">xtwitter</code>.
            </li>
            <li>
              CommanderQ routes to HERALD on phrasings like &quot;draft a tweet&quot;, &quot;post
              to x&quot;, &quot;start an x thread&quot;, &quot;show me our recent mentions&quot;,
              &quot;what is my x budget&quot;.
            </li>
            <li>
              Honest limit to state: some X-flavoured questions go elsewhere on purpose.
              &quot;Check my x credentials&quot; goes to REGULA, which owns the vault, and
              governance questions go to AUDITUS. Ask for HERALD by name if you want it
              specifically.
            </li>
            <li>HERALD drafts and files for approval. It never publishes. Asking it to help write or tighten a post is in scope.</li>
          </ul>
        </div>

        <div className="qx-stack qx-stack--tight xs-about__block">
          <span className="qx-section-title xs-title">Using it from workflows</span>
          <p>
            The x-scheduled-post workflow template is cron triggered and files a fresh approval
            card on each run via x_post. That template still drafts and never publishes, which is
            the right shape for a recurring job. It is a different thing from Approve and schedule
            above, which is a single pre-approved publish at a chosen time.
          </p>
        </div>

        <div className="qx-stack qx-stack--tight xs-about__block">
          <span className="qx-section-title xs-title">Using it from the CLI</span>
          <table className="qx-table">
            <thead>
              <tr>
                <th>Command</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {CLI_COMMANDS.map((row) => (
                <tr key={row.cmd}>
                  <td><code className="qx-code">{row.cmd}</code></td>
                  <td>{row.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Honest gap: the CLI has no read verb yet. The four read tools (get_tweet,
            get_user_tweets, search_recent, get_mentions) are reachable from an agent and from the
            dashboard, but not from the CLI.
          </p>
        </div>

        <div className="qx-stack qx-stack--tight xs-about__block">
          <span className="qx-section-title xs-title">Known limits</span>
          <ul>
            <li>
              Still images only, up to 4 per post. No video, no alt text, no polls, no quote
              tweets, no reply settings.
            </li>
            <li>
              GIF files are accepted by the uploader but no X media category is set for them, so
              animated GIF behaviour is unproven. Do not rely on it.
            </li>
            <li>One X account per org. Multi-account and OAuth2 are not built yet.</li>
            <li>Follower monitoring is not implemented.</li>
            <li>Direct messages are not supported and need a different credential type.</li>
          </ul>
        </div>
      </div>
    </section>
  )
}
