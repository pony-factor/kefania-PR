# ChatGPT Sites previews for upstream pull requests

Kefania prepares a development Site for an upstream pull request sourced from a published fork branch. After a separately approved deployment in ChatGPT Sites, Kefania can publish the associated custom-domain DNS records through the Spaceship API.

## Workflow

1. Publish an upstream PR from a fork through Kefania.
2. Supply the optional previewZone argument to github_create_pull_request to receive a preview handoff, or call github_prepare_preview_site after opening the PR. Include upstream owner/repo, fork headRepository, head branch, base, and DNS zone.
3. Kefania verifies the published fork head and existing upstream PR, then proposes branch.repo.preview.example.com. A short deterministic suffix handles branch names requiring DNS normalization. The handoff prompt instructs ChatGPT Sites to build the exact commit SHA.
4. Use the generated prompt with @Sites in ChatGPT. Import or build that revision, save a private candidate, review it, and deploy the approved version. Kefania does not have a documented Sites deployment API and cannot initiate that step itself.
5. In the Site settings, add the exact preview hostname and copy the CNAME and verification TXT records Sites provides, using full DNS names. Confirm the Site's public sharing audience separately.
6. Review the exact records, explicitly approve the DNS changes, then call github_publish_preview_dns with the same PR fields, expectedHeadSha, the actual Sites URL, copied records, and approved=true.
7. Kefania rechecks the live upstream PR, unchanged branch SHA, Spaceship DNS-zone allowlist, record names, and all existing DNS records before writing with force=false. It never deletes records or replaces conflicting values.
8. Verify the custom-domain status, public sharing, and HTTPS access in ChatGPT Sites. A successful DNS request does not prove the Site is deployed or publicly reachable.

Each branch gets its own hostname; repository and branch names occupy separate labels. The actual published domain must be owned and controlled by the user.

## Spaceship configuration

Create an API key with the minimum dnsrecords:read and dnsrecords:write permissions. Store the following only in Kefania's server environment, not in the repository, GitHub PR, Sites prompt, browser storage, or site configuration:

- KEFANIA_SPACESHIP_API_KEY
- KEFANIA_SPACESHIP_API_SECRET
- KEFANIA_SPACESHIP_ALLOWED_DOMAINS=example.com,other.example

The explicit allowlist is mandatory for every DNS write; Spaceship API permissions alone do not guarantee per-domain restrictions. Only the generated preview hostname and one-label verification TXT children are writable. A DNS conflict blocks publication. Only CNAME and TXT records can be published by this integration, with a 60–3600 second TTL.

The domain must use Spaceship's authoritative nameservers for this DNS update to become effective. If the custom-domain settings demand a different record type, do not improvise values or force changes; report the unsupported requirement.

## ChatGPT Sites limitation

ChatGPT Sites currently documents creation, review, saving versions, deployment, public sharing, and custom-domain settings through ChatGPT web and desktop. It does not document a third-party Sites create/build/deploy API for Kefania's MCP server. This feature therefore provides a verified handoff for ChatGPT Sites, not automatic site creation or deployment. If Sites cannot import or build the repository, stop and request a compatible source or build settings rather than claiming success.

Official references:
- https://learn.chatgpt.com/docs/sites
- https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites
- https://docs.spaceship.dev/
