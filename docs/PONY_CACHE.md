# Permanent pony library and guided curation

Kafania stores character research as **readable, Git-trackable JSON files in this repository's `ponies/` directory**, grouped by pack. For example: `ponies/g4-mares/berry-punch.json`. This is not a transient cache: character facts never expire automatically.

## Sweetiebot's automatic first lookup

Sweetiebot PR #270 calls `node src/pony-cache.js` with a JSON request on stdin:

- `{"action":"get","pony":{"packId":"g4-mares","slug":"berry-punch"}}` reads the existing profile. A hit supplies Markdown to the independent pony portion of the confirmation page and skips the redundant ChatGPT research tab.
- `{"action":"put","pony":{"packId":"g4-mares","slug":"berry-punch"},"profile":"Sourced research..."}` **creates a draft record only when none exists**. Subsequent automatic lookups must not overwrite an existing file, whether draft or reviewed.
- `{"action":"remove","pony":{...}}` can discard an unreviewed draft for re-research. It refuses to discard a reviewed profile.
- `KEFANIA_PONY_CACHE_DIR` optionally overrides the directory for testing or a custom local checkout. The default is `<kefania repository>/ponies/`. Existing files at `~/.cache/kefania/pony-profiles/` are not automatically migrated.

Files use `<packId>/<canonicalSlug>.json`, so aliases share the canonical record while G4/G5 collisions remain separate. Catalog source changes do not invalidate approved character facts. The 60 KB profile size limit remains. No search or publication operation commits or pushes the new working-tree files.

### Unified source-reference index

`ponies/sources.json` is the versioned, Git-trackable reference index for sources migrated from Sweetiebot's branch-name packs. It groups HTTPS `[{"url":"…","label":"…"}]` entries under `packs[packId][canonicalSlug]`. All 119 previously listed pony references were moved here; Leaf Litter also has a second cheekibat post containing artwork and context. This is a shared reference list, **not 119 generated biographies**.

A lookup for a pony without a saved profile returns `hit:false` alongside its indexed `sources`; the independent research workflow still runs, receiving those sources as starting points rather than unverified facts. On a profile hit, its references are merged with any record-specific sources and surfaced on the pony page when absent from the original Markdown. Initial `put` operations copy indexed references into new records; curated saves merge them without overwriting existing curated labels or unrelated sources. Keep edits to migrated references in this index, not in the branch-name catalog. Cache use remains local unless changes are explicitly committed to GitHub.

## Guided MCP workflow

A connected, authorized **local** Kafania MCP client can:

1. Call `pony_get_profile` for the pack and slug; read its entire record and `revision`. Or use `pony_list_profiles` to discover existing records.
2. Invoke the `curate_pony` prompt. Research primary/attributable sources, mark official versus fandom names, check appearances and speaking status, and distinguish confirmed details from uncertainty.
3. Show the user the proposed biography, aliases, appearance, speaking status, appearances, naming history, source links and art links, and ask explicitly whether the proposed change should be saved.
4. Only after approval, call `pony_curate_profile` with `approved:true`, the complete `profile`, applicable fields, and the revision returned in step 1 (or `expectedRevision:null` to create a record). Stale revisions are rejected. `status:"reviewed"` requires at least one HTTPS source URL.
5. Review `git diff -- ponies/`, then separately stage/commit/push through an explicitly authorized Git workflow. The MCP curation tool changes only the local working tree.

The GitHub-connected PR drafting and publishing tools remain independent; character lore and art are **never** added to PR titles, descriptions, comments or provenance.

## Canonical appearance screencaps

For on-screen characters, prefer **one to three verified animation frames** from named episodes in a dedicated `### In the show` section of the Markdown profile. Show the real character's appearance when identifiable; when only a crowd shot exists, describe its limitations rather than implying a close-up. An example is `ponies/g4-stallions/dark-moon.json` for *A Canterlot Wedding – Part 2* (S2E26).

Embed each image using a **direct HTTPS image URL** wrapped in a link to its verified contextual image/post page (`[![Scene and character](https://host/image.jpg)](https://host/post)`). Add an episode caption and the correct rights attribution: a still from the television show is **not** fan art by the booru uploader. Do not confuse creator, uploader, and host. Preserve distinct source links for fan artworks elsewhere in the profile. Don't use a generic episode image that lacks a verified appearance, or invent a direct URL or attribution when a gallery lists only a filename. If a source image fails to resolve, link to the episode/character gallery without embedding a broken thumbnail. External image bytes remain on their hosts and are not copied into this repository.

Screen appearance stills are **not** placed in the weekly-rotating `artwork` array; that feature is for selected attributed art. Unlike the featured art, the episode stills and their citations stay adjacent to the appearance narrative so readers can inspect visual evidence.

## Artwork rotation

Store a small list of attributed, externally hosted HTTPS images in each record's `artwork` array, with `url`, `alt`, `credit`, and an optional source-page `source`. Kafania chooses a featured image each week using a stable per-character offset, so the art cycles over time while the text remains unchanged. Image URLs must remain valid and licensed/attributed appropriately; the system does not download or rehost image bytes or automatically claim any URL has been verified.

Files are shared and versioned only when **you choose to commit** them. If running an MCP instance on another server, its tools operate on *that server's* checkout, not automatically on your Mac.
