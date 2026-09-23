import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The upstream tree is a GitBook export. Only the pages that SUMMARY.md lists
// are published; every other Markdown file is an orphan that GitBook never
// served, and it is recorded in the manifest as unpublished.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "sources", "upstream");
const sourceAssets = path.join(sourceRoot, ".gitbook", "assets");
const adaptedRoot = path.join(root, "sources", "adapted");
const brandRoot = path.join(root, "brand");
const sitePages = path.join(root, "site", "pages");
const siteAssets = path.join(root, "site", "public", "img");

// GitBook serves README.md as the book's root page, which has no path of its
// own, so it is the one page whose route is chosen here rather than derived.
const ROOT_PAGE_ROUTE = "docs/introduction";
const IMPLICIT_GROUP = "About this manual";

// Literal source repairs. Each must match exactly once and is recorded in the
// manifest so the departure from the upstream text stays auditable.
const SOURCE_CORRECTIONS = [
  {
    source: "unit-7-url-aliases/exercise-7-3-breadcrumbs.md",
    find: "[Exercise 6.2](broken-reference)",
    replace: "Exercise 6.2",
    reason: "GitBook exported the link with no target and SUMMARY.md lists no Exercise 6.2 page, so the link text is kept and the link is removed.",
  },
  {
    source: "software-and-module-requirements.md",
    find: "![A screenshot of a cell phone\n\n  Description automatically generated](.gitbook/assets/0%20%282%29.png)",
    replace: "![A screenshot of a cell phone. Description automatically generated](.gitbook/assets/0%20%282%29.png)",
    reason: "The image alt text spans a blank line, which CommonMark does not read as an image, so the alt text is joined onto one line.",
  },
  {
    source: "README.md",
    find: "https://camo.githubusercontent.com/54f85ff154017b9f86a8882c3469d7dfcab63442ae40f2ec49b7bbffede2d475/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f4c6963656e73652d434325323042592d2d5341253230332e3025323041552d6c69676874677265792e737667",
    replace: "https://img.shields.io/badge/License-CC%20BY--SA%203.0%20AU-lightgrey.svg",
    occurrences: 2,
    reason: "GitHub's image proxy answers requests from other sites with 403, so the badge is loaded from the shields.io address the proxy path encodes.",
  },
];

const upstreamCommit = (await readFile(path.join(root, "sources", "upstream-commit.txt"), "utf8")).trim();
const upstreamRepository = (await readFile(path.join(root, "sources", "upstream-repository.txt"), "utf8")).trim();

await rm(sitePages, { recursive: true, force: true });
await rm(siteAssets, { recursive: true, force: true });
await mkdir(sitePages, { recursive: true });
await mkdir(siteAssets, { recursive: true });

const summarySource = await readFile(path.join(sourceRoot, "SUMMARY.md"), "utf8");
const summary = parseSummary(summarySource);
const navigationPaths = summary.flatMap((group) => group.entries.flatMap((entry) => [entry.path, ...entry.children.map((child) => child.path)]));
const navigationLabels = new Map(
  summary.flatMap((group) => group.entries.flatMap((entry) => [[entry.path, entry.label], ...entry.children.map((child) => [child.path, child.label])])),
);
if (new Set(navigationPaths).size !== navigationPaths.length) {
  throw new Error("SUMMARY.md lists the same page more than once");
}

const routeBySourcePath = new Map(navigationPaths.map((relative) => [relative, `/${routeFor(relative)}`]));
const referencedAssets = new Map();
const pages = [];

for (const relative of navigationPaths) {
  const source = await readFile(path.join(sourceRoot, relative), "utf8");
  const { title, body } = splitLeadingHeading(source, relative);
  const navigationLabel = navigationLabels.get(relative);
  const route = routeFor(relative);
  const transformed = transformBody(body, relative, routeBySourcePath, referencedAssets);
  const generated = renderPage(title, transformed);
  await write(`${route}.mdx`, generated);
  pages.push({
    source: relative,
    output: `site/pages/${route}.mdx`,
    route: `/${route}`,
    title,
    ...(navigationLabel !== title ? { navigationTitle: navigationLabel } : {}),
    sourceSha256: sha256(source),
    generatedSha256: sha256(generated),
  });
}

const unpublishedPages = (await walk(sourceRoot))
  .filter((entry) => entry.endsWith(".md") && entry !== "SUMMARY.md" && !routeBySourcePath.has(entry))
  .sort()
  .map((entry) => ({ source: entry, reason: "not listed in SUMMARY.md, so GitBook never published it" }));

const adaptedPageDefinitions = [
  { source: "index.mdx", output: "index.mdx", route: "/", navigationRoute: "index", title: "GovCMS Site Building Training Manual", navigation: true },
];
const adaptedPages = [];
for (const definition of adaptedPageDefinitions) {
  const source = await readFile(path.join(adaptedRoot, definition.source), "utf8");
  await write(definition.output, source);
  adaptedPages.push({
    source: `sources/adapted/${definition.source}`,
    output: `site/pages/${definition.output}`,
    route: definition.route,
    navigationRoute: definition.navigationRoute ?? null,
    title: definition.title,
    navigation: definition.navigation,
    sourceSha256: sha256(source),
    generatedSha256: sha256(source),
  });
}

const adaptationInputPaths = ["README.md", "SUMMARY.md", "contributing.md"];
const adaptationInputs = [];
let adaptationSource = "";
for (const relative of adaptationInputPaths) {
  const source = await readFile(path.join(sourceRoot, relative), "utf8");
  adaptationSource += `\n${source}`;
  adaptationInputs.push({ source: relative, sha256: sha256(source) });
}

const homepageCopyAssertions = [
  "GovCMS Site Building Training Manual",
  "This manual is aimed at developers familiar with Drupal and/or other web content management systems (CMSs) who want to build or extend a GovCMS SaaS website.",
  "You should have skills in basic HTML, CSS, some Twig and basic PHP.",
  "created for the GovCMS Site Builder course",
  "What you will learn",
  "In this training manual, you will learn how to:",
  "Extend default functionality in GovCMS to meet advanced functional requirements",
  "Show best practices for GovCMS site building",
  "Configure both controlled vocabularies and free tagging with Taxonomy",
  "Manage navigation through the GovCMS menu system",
  "Use URL path configuration to improve your site’s search",
  "Configure automatically generated images and thumbnails",
  "Create advanced listings of content",
  "Maintain a secure and well-performing website",
  "This manual also includes challenge exercises, which are designed for those who have additional time or who want to know more about a particular feature.",
  "Table of contents",
  "Unit 1: Functional analysis",
  "Unit 2: Designing and planning content",
  "Unit 3: Manage media",
  "Unit 4: Taxonomy - Categorising content",
  "Unit 5: Text formats and rich text",
  "Unit 6: Content listing with Views",
  "Unit 7: URL aliases",
  "Unit 8: Site building exercises",
  "Unit 9: Search and related content",
  "Unit 10: Site performance",
  "Layout of a GovCMS page",
  "Roles and Permissions",
  "Blocks in GovCMS",
  "Planning your site structure",
  "Add and configure fields",
  "Manage form display",
  "Customise image display with image styles",
  "Review configuration of image media display",
  "Add new Vocabulary",
  "About input options",
  "Editorial considerations",
  "Set up the Rich Text editor",
  "About cross-site scripting",
  "Text formats",
  "Build the employment news view",
  "Related content by term",
  "Customize the content administration experience",
  "URL aliases - Patterns",
  "Configure redirects",
  "Breadcrumbs",
  "Extend content types with new fields",
  "Job list dropdown filter",
  "Employee list and custom profiles",
  "Explore the default search",
  "Create new search page with Search API",
  "Extend the search with Facets",
  "Planning for Peformance",
  "Review current issues and bottlenecks",
  "Glossary of terms",
  "Contributing & Feedback",
  "We’re continually working on improving these documents with community input and we appreciate any feedback, whether it's helping to contribute to further documentation or code, grammar issues, or simply a suggestion or improvement!",
  "Contributing guide",
  "govcms.training@salsadigital.com.au",
  "Software and module requirements",
  "Contributing and Feedback Guide",
  "https://salsa-digital.gitbook.io/govcms-site-builder",
  "https://github.com/govcms-training/site-builder",
  "Creative Commons Attribution-ShareAlike 3.0 Australia License (CC BY-SA 3.0 AU)",
  "Creative Commons License, Attribution-ShareAlike 2.0 (CC BY-SA 2.0)",
];
const homepage = contentText(await readFile(path.join(adaptedRoot, "index.mdx"), "utf8"));
const normalizedAdaptationSource = contentText(adaptationSource);
for (const assertion of homepageCopyAssertions) {
  if (!normalizedAdaptationSource.includes(contentText(assertion))) {
    throw new Error(`Landing-page copy is not present in the pinned upstream source: ${assertion}`);
  }
  if (!homepage.includes(contentText(assertion))) {
    throw new Error(`Landing-page adaptation is missing reviewed copy: ${assertion}`);
  }
}

const sourceAssetPaths = (await walk(sourceAssets)).sort();
const publishedNames = new Map();
for (const [name, published] of referencedAssets) {
  if (!sourceAssetPaths.includes(name)) {
    throw new Error(`Referenced asset is missing from the upstream snapshot: ${name}`);
  }
  const collision = publishedNames.get(published);
  if (collision !== undefined && collision !== name) {
    throw new Error(`Published asset name collides: ${collision} and ${name} both become ${published}`);
  }
  publishedNames.set(published, name);
}

const assets = [];
for (const relative of sourceAssetPaths) {
  const bytes = await readFile(path.join(sourceAssets, relative));
  const published = referencedAssets.get(relative) ?? null;
  if (published !== null) await writeBinary(published, bytes);
  assets.push({
    source: `.gitbook/assets/${relative}`,
    output: published === null ? null : `site/public/img/${published}`,
    published: published !== null,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  });
}

const brandAssets = [];
for (const relative of (await walk(brandRoot)).sort()) {
  const bytes = await readFile(path.join(brandRoot, relative));
  if (publishedNames.has(relative)) throw new Error(`Brand asset name collides with an upstream asset: ${relative}`);
  await writeBinary(relative, bytes);
  brandAssets.push({
    source: `brand/${relative}`,
    output: `site/public/img/${relative}`,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  });
}

const manifest = {
  upstreamRepository,
  upstreamCommit,
  rootPageRoute: `/${ROOT_PAGE_ROUTE}`,
  pageCount: pages.length + adaptedPages.length,
  documentationPageCount: pages.length,
  adaptedPageCount: adaptedPages.length,
  unpublishedPageCount: unpublishedPages.length,
  assetCount: assets.length,
  publishedAssetCount: assets.filter((asset) => asset.published).length + brandAssets.length,
  navigation: summary,
  pages,
  unpublishedPages,
  adaptedPages,
  adaptationInputs,
  homepageCopyAssertions,
  sourceCorrections: SOURCE_CORRECTIONS,
  assets,
  brandAssets,
};
await writeFile(path.join(root, "sources", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  `Imported ${pages.length} documentation pages, ${adaptedPages.length} site ` +
    `page${adaptedPages.length === 1 ? "" : "s"}, and ${manifest.publishedAssetCount} published assets ` +
    `from ${upstreamCommit}. ${unpublishedPages.length} upstream pages are not listed in SUMMARY.md.`,
);

function parseSummary(source) {
  const groups = [];
  let current = null;
  let parent = null;
  for (const line of source.split(/\r?\n/)) {
    const section = /^##\s+(.+?)\s*$/.exec(line);
    if (section) {
      current = { group: section[1], entries: [] };
      groups.push(current);
      parent = null;
      continue;
    }
    const entry = /^(\s*)\*\s+\[([^\]]+)\]\(([^)]+)\)\s*$/.exec(line);
    if (!entry) continue;
    if (current === null) {
      current = { group: IMPLICIT_GROUP, entries: [] };
      groups.push(current);
    }
    const [, indent, label, target] = entry;
    if (indent.length === 0) {
      parent = { label, path: target, children: [] };
      current.entries.push(parent);
    } else {
      if (parent === null) throw new Error(`SUMMARY.md nests ${target} under no page`);
      parent.children.push({ label, path: target });
    }
  }
  return groups;
}

function splitLeadingHeading(source, relative) {
  const match = /^(?:[ \t]*\r?\n)*[ \t]*#(?!#)[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error(`${relative}: no leading level-one heading`);
  const body = source.slice(match[0].length);
  if (authoredLevelOneHeading(body)) {
    throw new Error(`${relative}: contains another level-one heading after its page title`);
  }
  return { title: unescapeMarkdown(match[1]), body };
}

function unescapeMarkdown(value) {
  return value.replace(/\\([\\`*_{}[\]()#+\-.!<>])/g, "$1").trim();
}

function authoredLevelOneHeading(body) {
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = opening[1][0] === "`" ? "`{3,}" : "~{3,}";
      continue;
    }
    if (/^ {0,3}#(?!#)(?:[ \t]+|$)/.test(line)) return true;
  }
  return false;
}

function routeFor(relative) {
  if (relative === "README.md") return ROOT_PAGE_ROUTE;
  return `docs/${relative.slice(0, -3)}`;
}

function renderPage(title, body) {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body.trimEnd()}\n`;
}


function transformBody(body, relative, routeBySourcePath, referencedAssets) {
  let transformed = body.replace(/<!--[\s\S]*?-->/g, "");
  for (const correction of SOURCE_CORRECTIONS.filter((entry) => entry.source === relative)) {
    const occurrences = correction.occurrences ?? 1;
    if (transformed.split(correction.find).length !== occurrences + 1) {
      throw new Error(`${relative}: source correction does not match exactly ${occurrences} time(s): ${correction.find}`);
    }
    transformed = transformed.replaceAll(correction.find, correction.replace);
  }
  transformed = transformHints(transformed, relative);
  transformed = transformFigures(transformed, relative);
  transformed = mapLines(transformed, transformImageRun);
  transformed = mapLines(transformed, (line) => {
    line = rewriteAssetReferences(line, relative, referencedAssets);
    line = rewriteInternalDocumentationLinks(line, relative, routeBySourcePath);
    line = wrapBareUrls(line);
    line = escapeBraces(line);
    return line;
  });
  const remaining = /(^|[^\\])<(?!\/?(?:Frame|Columns|Info|Check|Warning|Danger|Note|Tip|img)\b|https?:\/\/)[A-Za-z]/.exec(stripCode(transformed));
  if (remaining) throw new Error(`${relative}: raw HTML remains after conversion near: ${remaining[0]}`);
  return transformed;
}

// Runs a line transform outside fenced code blocks only.
function mapLines(source, transform) {
  let fence = null;
  return source
    .split("\n")
    .map((line) => {
      if (fence) {
        if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
        return line;
      }
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening) {
        fence = { marker: opening[1][0], length: opening[1].length };
        return line;
      }
      return transform(line);
    })
    .join("\n");
}

function stripCode(source) {
  return source.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function transformHints(source, relative) {
  const component = { info: "Info", success: "Check", warning: "Warning", danger: "Danger" };
  const stack = [];
  const transformed = source
    .split("\n")
    .map((line) => {
      const opening = /^\s*\{%\s*hint\s+style="(\w+)"\s*%\}\s*$/.exec(line);
      if (opening) {
        const name = component[opening[1]];
        if (!name) throw new Error(`${relative}: unknown GitBook hint style ${opening[1]}`);
        stack.push(name);
        return `<${name}>`;
      }
      if (/^\s*\{%\s*endhint\s*%\}\s*$/.test(line)) {
        const name = stack.pop();
        if (!name) throw new Error(`${relative}: unmatched GitBook endhint`);
        return `</${name}>`;
      }
      if (/\{%/.test(line)) throw new Error(`${relative}: unsupported GitBook block: ${line.trim()}`);
      return line;
    })
    .join("\n");
  if (stack.length > 0) throw new Error(`${relative}: unclosed GitBook hint`);
  return transformed;
}

// A GitBook figure is a bordered image with an optional caption, which is the
// Frame component. `data-size` is a GitBook display hint with no equivalent.
function transformFigures(source, relative) {
  source = transformImageTables(source);
  const figure = /<figure><img src="([^"]*)" alt="([^"]*)"(?: data-size="original")?><figcaption>(?:<p>([^<]*)<\/p>)?<\/figcaption><\/figure>/g;
  let transformed = source.replace(figure, (_match, src, alt, caption) => {
    const attributes = caption ? ` caption="${escapeAttribute(decodeEntities(caption))}"` : "";
    return `<Frame${attributes}><img src="${src}" alt="${escapeAttribute(alt)}" /></Frame>`;
  });
  transformed = transformed.replace(/<img src="([^"]*)" alt="([^"]*)"(?: data-size="original")?>/g, (_match, src, alt) => {
    return `<img src="${src}" alt="${escapeAttribute(alt)}" />`;
  });
  // GitBook wraps each block of a table cell in <p>. A cell holds inline
  // content only, so the wrappers become spaces.
  transformed = transformed
    .split("\n")
    .map((line) => (/^\s*\|/.test(line) ? line.replace(/<p>/g, "").replace(/<\/p>/g, " ").replace(/ {2,}/g, " ") : line))
    .join("\n");
  if (/(^|[^\\])<(figure|figcaption|\/p|p)>/.test(transformed)) throw new Error(`${relative}: a figure did not match the expected GitBook shape`);
  return transformed;
}

// GitBook laid a paragraph of images out inline, side by side. Prose styling
// gives each image its own line, so the run becomes Columns of Frames. The
// light surface keeps the white page the images were drawn against: the
// upstream GovCMS logo is black on transparent and is illegible on the dark
// theme without it.
function transformImageRun(line) {
  const run = /^(\s*)((?:!\[[^\]]*\]\([^)\s]+\)\s*){2,})$/.exec(line);
  if (!run) return line;
  const indent = run[1];
  const images = [...run[2].matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)];
  const output = [`${indent}<Columns cols={${images.length}}>`];
  for (const [, alt, src] of images) {
    output.push(`${indent}  <Frame surface="light"><img src="${src}" alt="${escapeAttribute(alt)}" /></Frame>`);
  }
  output.push(`${indent}</Columns>`);
  return output.join("\n");
}

// GitBook places images side by side as a header-only table whose cells each
// hold an image and a caption. A table cell cannot size an image, so the row
// becomes Columns of Frames.
function transformImageTables(source) {
  const cell = /<p><img src="([^"]*)" alt="([^"]*)"(?: data-size="original")?><\/p>(?:<p>([^<]*)<\/p>)?/;
  const lines = source.split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const row = /^(\s*)\|(.*)\|\s*$/.exec(lines[index]);
    const separator = lines[index + 1] !== undefined && /^\s*\|(?:\s*-+\s*\|)+\s*$/.test(lines[index + 1]);
    const cells = row ? row[2].split("|").map((value) => value.trim()) : [];
    if (!row || !separator || cells.length === 0 || !cells.every((value) => new RegExp(`^${cell.source}$`).test(value))) {
      output.push(lines[index]);
      continue;
    }
    const indent = row[1];
    output.push(`${indent}<Columns cols={${cells.length}}>`);
    for (const value of cells) {
      const [, src, alt, caption] = cell.exec(value);
      const attributes = caption ? ` caption="${escapeAttribute(decodeEntities(caption))}"` : "";
      output.push(`${indent}  <Frame${attributes}><img src="${src}" alt="${escapeAttribute(alt)}" /></Frame>`);
    }
    output.push(`${indent}</Columns>`);
    index += 1;
  }
  return output.join("\n");
}

function rewriteAssetReferences(line, relative, referencedAssets) {
  const register = (raw) => {
    const name = decodeURIComponent(raw).replace(/^(?:\.\.\/)*\.gitbook\/assets\//, "");
    const published = publishedAssetName(name);
    referencedAssets.set(name, published);
    return `/img/${published}`;
  };
  // The image alt text may span lines, so only the `](` prefix is matched.
  line = line.replace(/(\]\()<((?:\.\.\/)*\.gitbook\/assets\/[^>]+)>(\))/g, (_match, prefix, raw, suffix) => `${prefix}${register(raw)}${suffix}`);
  line = line.replace(/(\]\()((?:\.\.\/)*\.gitbook\/assets\/[^)\s]+)(\))/g, (_match, prefix, raw, suffix) => `${prefix}${register(raw)}${suffix}`);
  line = line.replace(/(src=")((?:\.\.\/)*\.gitbook\/assets\/[^"]+)(")/g, (_match, prefix, raw, suffix) => `${prefix}${register(raw)}${suffix}`);
  if (/\.gitbook\/assets\//.test(line)) throw new Error(`${relative}: unrecognised asset reference: ${line.trim()}`);
  return line;
}

// GitBook asset names carry spaces and parenthesised duplicate counters. The
// source contract admits only [A-Za-z0-9._-] in a path segment.
function publishedAssetName(name) {
  const published = name.replace(/[()]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/-(\.[A-Za-z0-9]+)$/, "$1");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(published) || published.endsWith(".")) {
    throw new Error(`Asset name cannot be made canonical: ${name}`);
  }
  return published;
}

function rewriteInternalDocumentationLinks(line, relative, routeBySourcePath) {
  return line.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?\))/g, (match, image, text, destination, suffix) => {
    if (image) return `![${text}](${unescapeUrl(destination)}${suffix}`;
    const rewritten = internalDocumentationRoute(unescapeUrl(destination), relative, routeBySourcePath);
    if (rewritten === null) throw new Error(`${relative}: internal link has no published page: ${destination}`);
    return `[${text}](${rewritten}${suffix}`;
  });
}

function internalDocumentationRoute(destination, relative, routeBySourcePath) {
  if (/^(?:#|\/|[a-z][a-z\d+.-]*:)/i.test(destination)) return destination;
  const hashAt = destination.indexOf("#");
  const fragment = hashAt === -1 ? "" : destination.slice(hashAt);
  const pathname = hashAt === -1 ? destination : destination.slice(0, hashAt);
  if (!pathname.endsWith(".md")) return destination;
  const candidates = [
    path.posix.normalize(path.posix.join(path.posix.dirname(relative), pathname)),
    path.posix.normalize(pathname),
  ];
  const target = candidates.find((candidate) => routeBySourcePath.has(candidate));
  return target ? `${routeBySourcePath.get(target)}${fragment}` : null;
}

// GitBook backslash-escapes `_` and `&` inside URLs. A backslash is not
// admissible in a link destination, and a bare URL that carries one is cut
// short by the autolink reader, so every bare URL becomes an explicit link
// with its escapes removed. MDX has no angle-bracket autolink.
function unescapeUrl(value) {
  return value.replace(/\\([_&])/g, "$1");
}

function wrapBareUrls(line) {
  const url = /(?<!(?<!\\)\[)(?<!\]\()(?<![<"=/\w])(https?:\/\/(?:[^\s<>()"'\[\]\\`]|\\[_&])+)/g;
  return line.replace(/(`[^`]*`)|(?:[^`]+)/g, (segment, code) =>
    code ? code : segment.replace(url, (_match, raw) => {
      const trailing = /[.,:;!?]+$/.exec(raw)?.[0] ?? "";
      const address = unescapeUrl(raw.slice(0, raw.length - trailing.length));
      return `[${address}](${address})${trailing}`;
    }),
  );
}

// MDX reads a bare brace as an expression, so braces in prose must be escaped.
function escapeBraces(line) {
  return line.replace(/(`[^`]*`|<[A-Za-z][^<>]*>)|(?<!\\)([{}])/g, (match, literal, brace) => (literal ? literal : `\\${brace}`));
}

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function decodeEntities(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#x20;", " ");
}

async function walk(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(directory, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function write(relative, contents) {
  const target = path.join(sitePages, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function writeBinary(relative, contents) {
  const target = path.join(siteAssets, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// SUMMARY.md labels its sections in upper case, so copy is compared without
// regard to case. Markdown escapes and entities are removed on both sides.
function contentText(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replace(/\\([\\`*_{}[\]()#+\-.!<>])/g, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
