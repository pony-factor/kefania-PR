# Kefania MCP

Kefania supplies the GitHub tools requested by Sweetiebot's New PR button. The MCP server identifies itself as `codex-drafter`. It runs locally over stdio or over authenticated Streamable HTTP.

The drafting model writes the title and description from repository evidence. Kefania reads the published branch comparison, publishes the PR, publishes the final description without an automatic footer image, and records supplied conversation provenance in a separate comment. When the proposed PR diverged from its base, Kefania also checks GitHub's verified test-merge tree against newer base-branch changes and posts a **non-blocking review comment** for potential lost or resurrected code. If the merge result cannot be verified, it comments that the review is incomplete instead of claiming safety. Humans discuss intentional changes in the PR conversation; Kefania does not approve or reject them. The review is rerun when an existing PR is submitted through Kefania again, once per head/base revision. It never stages, commits, pushes, or merges repository changes.

## Setup by client

### Open pull requests against upstream

Kefania can now propose changes from your **published fork branch** to another repository in the same GitHub fork network. Set `owner` and `repo` (for MCP), or `repository` (for the local runner), to the **upstream destination**. Supply `headRepository` with the full fork name, `head` with the fork branch, and `base` with the upstream branch.

For example, the local runner accepts:

```sh
printf '%s\n' '{"repository":"upstream/project","headRepository":"your-account/project","head":"my-fix","base":"main","draftOnly":true}' | npm run --silent pr:local
```

Omit `draftOnly` to publish a ready-for-review upstream PR. For MCP, pass `headRepository: "your-account/project"` to both `github_get_pull_request_context` and `github_create_pull_request`. Kefania validates fork ancestry, compares the published branches across repositories, verifies the fork head SHA before publishing, and detects existing PRs for the exact fork.

**Local upstream publishing uses your existing `gh auth login` identity**, not the codex-pony App: an external upstream is unlikely to have installed that App. The fork branch must already be committed and pushed; Kefania never commits, pushes, or creates a fork. Hosted mode stays App-only, and requires codex-pony installed on the upstream repository with the necessary permissions (see [HOSTING.md](HOSTING.md)).


For a hosted bot publisher with GitHub OAuth, see [the hosting guide](HOSTING.md). The local setup page can deploy that separate web-authenticated publisher to AWS App Runner without changing local PR drafting. It accepts completed drafts through MCP or HTTP without another model run.

See **[the canonical Kafania MCP setup guide](docs/MCP_SETUP.md)** for VS Code stdio registration, ChatGPT plugins/Secure MCP Tunnel, authenticated HTTP, verification, and troubleshooting. VS Code registration does not make the tools available in a ChatGPT browser conversation.

## Local setup

Sweetiebot's PR button opens independent ChatGPT workflows for PR drafting and pony research in VS Code's Integrated Browser. Each returns to a local confirmation page and closes its intermediate tab when finished. PR drafting receives verified published-branch evidence and the canonical instructions; pony research receives only the character context. Either result can arrive first, and the PR can be published without waiting for the pony description. Encoded launch URLs stay below 70 KB and result requests respect the 100 KB limit. The standalone window automatically publishes the completed draft locally using the saved GitHub App credentials without another Codex inference run. Turn off **SCM Toolkit: Auto Publish Pull Requests** to review the text and use its **Publish pull request** button instead. The window's header shows the published PR number. Active Kefania browser tabs keep running when their window is behind another app or minimized; completion does not restore or focus the window. VS Code must remain running. The confirmation expires after one hour and publication rejects a changed branch head. No OpenAI API key or public tunnel is required. Keep this checkout beside the repository using Sweetiebot and install its dependencies with `npm ci --ignore-scripts`.

The runner reads the published comparison through the GitHub App API and withholds secret-bearing patches. Kefania publishes a ready-for-review PR using the verified head SHA and existing duplicate and provenance handling. It never stages, commits, or pushes. If the Integrated Browser is unavailable before launch, Sweetiebot falls back to a read-only local Codex drafter authenticated through your ChatGPT login (`codex login`). A failed or unfinished browser chat never silently starts that fallback.

To generate text without publishing, send a JSON request on stdin:

```sh
printf '%s\n' '{"repository":"owner/repo","head":"branch","base":"main","draftOnly":true}' | npm run --silent pr:local
```

Omit `draftOnly` to draft and publish. The runner forces ChatGPT login and removes API-key environment variables from the drafting process. On every draft, it queries the CLI's available model catalog, selects its recommended model (following any available recommended upgrade), and explicitly uses **medium reasoning**. No model version is pinned. If discovery fails or that model does not support medium, the Ollama fallback applies. Codex runs locally but inference uses your ChatGPT plan. See the [Codex authentication documentation](https://learn.chatgpt.com/docs/auth).

The MCP transports below remain available for clients that already use them.

### Ollama fallback

Drafting follows ChatGPT in Sweetiebot's Integrated Browser, then the Codex CLI when the browser is unavailable, then local Ollama if Codex drafting fails. Completed browser drafts publish directly without invoking either local model. Failed GitHub writes do not trigger model fallback.

Open **Ollama fallback** in the local setup UI to enable or disable it, refresh installed models, and choose the model, local server address, temperature, context tokens, output tokens, timeout, and thinking mode. Click **Save preferences** to persist the choices. The default is `qwen2.5-coder:7b` at `http://127.0.0.1:11434`; the model must already be installed. The settings are read on each fallback run and remain outside the repository. Ollama receives the same canonical instructions and filtered branch evidence as the Codex drafter, and returns structured title/body JSON using the [Ollama generation API](https://docs.ollama.com/api/generate). Invalid or truncated output cannot publish a PR.

Install Node.js 20 or newer. An existing `gh auth login` is sufficient for fallback access; configure the app when ready, then run:

```sh
npm ci --ignore-scripts
npm start
```

`npm start` speaks MCP over stdin/stdout; it does not open a web page. The included `.vscode/mcp.json` registers the local server when this repository is open in VS Code. To make it available in other VS Code workspaces, use the supported `code --add-mcp` command with an absolute entrypoint path:

```sh
code --add-mcp '{"name":"codex-drafter","command":"node","args":["/absolute/path/to/kefania/src/index.js"]}'
```

### Browser setup and GitHub identity

Launch the local setup page:

```sh
npm run setup:web
```

Open **http://127.0.0.1:8766/**. The interface guides you through GitHub authorization, repository selection, PR writing voice and length, editable instructions, and a safe local preview. It serves only on the local loopback address, not as a published website. To use another port set `KEFANIA_SETUP_PORT`.

For the optional user-account flow, an administrator of the **codex-pony** GitHub App must enable **Device Flow** in the app's settings. The setup page fills in the app's **public Client ID** automatically. You can override it under **Use your account with the App badge instead**. The administrator must also grant Contents (read), Pull requests (read/write), Issues (read/write), and Metadata (read) repository permissions, then install the app on the desired repositories. [GitHub's user authorization guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) documents the device flow. The user clicks **Connect your account**, opens GitHub's device-authorization page, enters the displayed one-time code, and approves access. Kefania polls for completion within GitHub's rate limits. No private key, client secret, or personal access token is entered in the browser.

GitHub user sessions are stored in **macOS Keychain**, with no token placed in URLs, logs, files, or browser storage. On non-macOS systems, user sessions remain in memory only and must be reauthorized for a new process; use the existing authenticated `gh` CLI fallback for persistent local workflows there. In the local UI, the only persisted file is `~/.config/kefania/preferences.json`, containing **non-secret** style, public app client ID, and chosen repository names.

**Attribution:** A PR published with the authorized **user** session shows that GitHub user as the creator. The installation-token path publishes as `codex-pony[bot]`. A CLI fallback PR is attributed to the active `gh` user. GitHub's own commit authorship is independent of the PR creator. In automatic mode, Kefania chooses the App installation bot first, then the user connection, then `gh`; it selects the identity before any write and never retries a failed write under another identity.

Configure the preferred bot identity on macOS in the setup page's **Set up codex-pony[bot]** section: enter the numeric App ID, select its downloaded RSA private-key PEM file, click **Find installations**, and click **Save bot connection**. Kefania automatically finds the installation for each PR repository and lists accessible repositories across all active installations; no account or organization is pinned. Existing Keychain credentials work without re-uploading the key. Kefania validates access before saving credentials in macOS Keychain. The file input is cleared after submission; the key is never returned to the page or saved in browser storage or preferences. Finish within five minutes or select the file again. New local PR runs use the saved bot connection; restart running MCP servers after setup. The terminal command `npm run setup:github` and environment variables `KEFANIA_GITHUB_APP_ID`, `KEFANIA_GITHUB_INSTALLATION_ID`, and `KEFANIA_GITHUB_PRIVATE_KEY` remain available. The optional user connection does not require that key. Set `KEFANIA_GITHUB_AUTH=user` to require human attribution, `app` to require bot attribution, or `cli` for the CLI-only fallback. Keep credentials in your process environment or Keychain, not source or repository files.

The style settings are appended as **supplemental drafting instructions** to the canonical policy and read by **both** `github_get_pull_request_context`/MCP prompt generation and `src/local-pr.js` on every run. They cannot supersede repository-diff evidence or publication safeguards. Preview from the browser uses `draftOnly` and does not create a GitHub PR. The explicit Publish action runs the existing local Codex drafter and publisher.



### Sweetiebot PR-button readiness in the setup UI

Under **Choose where Kefania can work**, expand **Set up Sweetiebot's PR button** and enter the absolute path of the local repository checkout (for example, `/Users/GitHub/blocktransfer/SEC-publications`). Save the repository selection first. **Check PR-button setup** verifies that the checkout's GitHub origin matches, that a sibling `kefania` path points to the current Kefania installation, and that its PR runner and npm dependencies exist.

**Set up or repair** installs missing dependencies via `npm ci --ignore-scripts` in Kefania's own checkout and creates the sibling directory symlink if the destination is absent. It never overwrites an existing directory or conflicting/broken symlink. **Update Kefania** first checks that its checkout is on clean `main`, fast-forwards from `pony-factor/kefania` with `git pull --ff-only`, and reinstalls dependencies. These actions are opt-in and do not modify the selected SEC-publications checkout. Restart a running Kefania setup server after updating. A ready indicator verifies local files and paths, **not** whether the VS Code PR button was clicked successfully.

## Permanent pony research library

Kafania keeps curated character information in the tracked [`ponies/`](ponies/) directory, not in `~/.cache` and not in ChatGPT history. Files are readable JSON organized by catalog pack and canonical slug, with no automatic expiration. Sweetiebot can create an initial unreviewed draft after independent character research, but subsequent lookups cannot overwrite an existing record. Existing 90-day cache files are not migrated.

The MCP prompt `curate_pony` guides a review of naming, appearance, speaking status, appearances, provenance, and artwork. `pony_get_profile` and `pony_list_profiles` read existing records; `pony_curate_profile` requires explicit user approval and a matching revision to modify them. Each profile can keep multiple attributed HTTPS artwork URLs; the featured image rotates weekly without changing the biography. Writes modify the **local repository working tree**, not GitHub, and do not commit or push. See [pony curation documentation](docs/PONY_CACHE.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `pony_get_profile` | Read a durable curated pony profile, revision and featured artwork. |
| `pony_list_profiles` | Browse draft and reviewed profiles by pack. |
| `pony_curate_profile` | Save an explicitly approved record to the local `ponies/` tree, using revision checks. |
| `kefania_status` | Check GitHub access and repository scope without writing. |
| `kefania_drafting_rules` | Read the canonical instructions. |
| `github_get_pull_request_context` | Read the published branch comparison, return its head SHA and drafting rules. |
| `github_create_pull_request` | Create a ready-for-review PR, or return the existing open PR for the same head/base. |
| `github_comment_pull_request_source` | Record supplied originating conversation metadata once on an open PR. |
| `github_create_issue` | Preserve a supplied prompt in edit history and publish the final issue text. |

The server also exposes `kefania://pull-request/rules` and the `draft_pull_request` and `curate_pony` prompts.

Read the comparison before creating a PR and pass its `headSha` as `expectedHeadSha`. Creation rejects a changed head or a branch with no committed difference from the base. This version supports branches in the selected repository. Comparisons flag omitted, unavailable, or truncated patches; do not describe unseen changes as reviewed.

PRs default to ready for review. Set `draft: true` explicitly through the MCP tool to request a draft PR. PR descriptions have no automatic image or footer. The optional `prompt` argument is published verbatim under `## AI Prompt` and then replaced by the final description, preserving the original in GitHub edit history. Only supply text the user authorized for publication; source-conversation metadata belongs in the separate `source` argument. Issue creation requires `prompt`.

When description finalization or provenance recording fails after creation, the result retains the created PR or issue URL and identifies the failed step. Do not repeat creation to repair that step.

## HTTP and remote clients

Set these environment variables through the hosting platform or process environment:

- `KEFANIA_MCP_TOKEN`: a separate bearer secret of at least 32 characters; never the GitHub token.
- `KEFANIA_ALLOWED_REPOSITORIES`: a comma-separated list of exact `owner/repo` names.
- `KEFANIA_HOST`: defaults to `127.0.0.1`.
- `PORT`: defaults to `8765`.
- `KEFANIA_ALLOWED_HOSTS`: required for a non-local listener; list the hostnames served by the reverse proxy.

Then run `npm run start:http`. The MCP endpoint is `/mcp`; `/health` reports whether the HTTP listener is running. `kefania_status` checks actual GitHub access. MCP requests require `Authorization: Bearer <KEFANIA_MCP_TOKEN>`. HTTP rejects browser-origin requests and validates the Host header. Repository restrictions apply to every read and write.

The prior environment names `MCP_HOST`, `MCP_PORT`, `MCP_BEARER_TOKEN`, and `MCP_PUBLIC_HOSTNAME` remain supported. The Dockerfile includes Node and the GitHub CLI and starts HTTP mode. Provide secrets at runtime, never in the image or repository.

Local VS Code registration makes the server available to VS Code's MCP clients. It does **not** connect ChatGPT inside the Integrated Browser. A browser/cloud client needs a reachable HTTPS endpoint and a compatible authentication connection. The HTTP transport currently supports bearer-authenticated clients; it does not implement an OAuth authorization service. Configure supported authentication at the hosting gateway before connecting ChatGPT. No public endpoint is deployed by this checkout.

## Verification

`npm test` exercises MCP startup and discovery, authenticated HTTP, repository scope, exact prompt preservation, duplicate PR prevention, changed-head rejection, attribution, browser authorization, preferences, and provenance failures. GitHub writes in tests use fixtures. Live setup verification can call `kefania_status` and a read-only branch comparison without publishing anything.

Transport implementation follows the [official MCP SDK server guidance](https://ts.sdk.modelcontextprotocol.io/server).
