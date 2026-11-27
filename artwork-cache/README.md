# Local third-party artwork cache

This directory is reserved for locally cached third-party images, **not project-owned assets**. The repository's software LICENSE does not grant any rights to these images, their characters, or associated artwork. Copyright and other rights remain with their respective holders. Attribution is not a license or permission to redistribute.

The ignored `files/<pack>/<canonical-slug>/` subtree contains one JSON provenance sidecar and, when obtainable, one raster image per SHA-256 of its original URL. Each sidecar records the direct URL, contextual source/post URL, alt text and credit exactly as supplied by the displayed gallery (subject to length limits). A label is not an independently verified artist credit. Source links remain available even offline, though their external pages may require connectivity.

Do not commit, force-add, distribute or bundle the cached files. Only cache artwork where the applicable rights and source terms permit local storage. Remove the relevant files or the whole `files/` directory to clear the cache; the versioned pony biographies remain unchanged. No image bytes are uploaded by this workflow.

The downloader accepts a limited set of known image CDN hosts, HTTPS only, with no redirects, a 12 MiB limit, and PNG/JPEG/GIF/WebP validation. Other hosts remain link-only; failures do not block PR work. There are at most 30 entries per character.
