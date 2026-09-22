# GovCMS Site Building Training Manual site

This public repository publishes the GovCMS Site Building Training Manual on
SaturnDocs at <https://govcms-site-builder.saturndocs.net>.

The manual originates from the public [`govcms-training/site-
builder`](https://github.com/govcms-training/site-builder) repository, a
GitBook export by Salsa Digital. This repository is a GitHub fork of it. The
complete upstream tree is preserved under `sources/upstream/`, and the fork's
history before the SaturnDocs restructure is the upstream history. The Creative
Commons Attribution-ShareAlike 3.0 Australia license from the upstream
repository is preserved as `LICENSE.md` and applies to this adaptation.

## Repository layout

- `sources/upstream/` is the immutable source snapshot used for this import.
- `sources/adapted/` contains the reviewed static landing page, built from
  copy in the upstream `README.md`, `SUMMARY.md`, and `contributing.md`.
- `brand/` contains the original page-layout logo and favicon created for the
  SaturnDocs site.
- `site/` is the SaturnDocs source root connected to production.
- `scripts/import-upstream.mjs` performs the documented, mechanical format
  conversion required by the SaturnDocs source contract.
- `scripts/verify-content.mjs` verifies source digests, generated pages,
  navigation coverage, image references, and published asset equality.

The importer publishes the pages that the upstream `SUMMARY.md` lists, in its
order, and records every other upstream Markdown file in the manifest as
unpublished. GitBook never served those files. The upstream sections become
sidebar groups. The SaturnDocs sidebar renders a group's pages before its
nested groups, so the exercises nested under a page in `SUMMARY.md` are listed
flat, in the upstream order, rather than as nested groups. The manifest keeps
the upstream nesting.

For each page the importer moves the leading level-one heading into SaturnDocs
page-title metadata, converts GitBook hint blocks to callouts, converts GitBook
figures to the Frame component, converts side-by-side image tables to Columns
of Frames, unwraps the paragraph tags GitBook writes into table cells, resolves
source-relative documentation links to their canonical SaturnDocs routes,
removes the backslash escapes GitBook writes into URLs, turns each bare URL
into an explicit link, and escapes braces in prose. When the `SUMMARY.md` label
differs from the page heading, the label is preserved as an explicit navigation
label. It does not rewrite documentation prose.

GitBook asset names carry spaces and parenthesised duplicate counters, which
the source contract does not admit. The importer publishes each referenced
asset under a canonical name (`image (39).png` becomes `image-39.png`) and
refuses to run if two names collide. Unreferenced assets stay in the snapshot
and are not published.

The upstream root `README.md` has no path of its own in GitBook, so it is
published at `/docs/introduction`. Three literal source repairs are recorded in
the manifest as `sourceCorrections` with their reasons: a link whose target
GitBook lost, an image whose alt text spans a blank line, and a license badge
served through GitHub's image proxy, which refuses requests from other sites.
The upstream text is otherwise reproduced as written, including its
typographical errors.

## Verify the import

```sh
npm test
```

To rebuild the generated SaturnDocs pages from the preserved source snapshot:

```sh
npm run import
```

The SaturnDocs platform repository is required only for source-contract
validation and the production renderer build. With the platform checked out and
built beside this repository, run:

```sh
node scripts/validate-source.mjs
SATURNDOCS_DOCS_DIR="$PWD/site" \
SATURNDOCS_OUT_DIR="$PWD/build" \
SATURNDOCS_WORKER_DIR="$PWD/worker" \
pnpm --dir ../saturndocs-platform/renderer build
node scripts/verify-build.mjs
```

Set `SATURNDOCS_PLATFORM_DIR` when the platform checkout is elsewhere.
