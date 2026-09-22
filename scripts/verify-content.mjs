import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "sources", "manifest.json"), "utf8"));
const docsConfig = JSON.parse(await readFile(path.join(root, "site", "docs.json"), "utf8"));
const failures = [];
const internalDocumentationRoutes = new Set([
  ...manifest.pages.map((page) => normalizedRoute(page.route)),
  ...(docsConfig.redirects ?? []).flatMap((redirect) => [
    normalizedRoute(redirect.source),
    normalizedRoute(redirect.destination),
  ]),
]);

const upstreamCommit = (await readFile(path.join(root, "sources", "upstream-commit.txt"), "utf8")).trim();
if (manifest.upstreamCommit !== upstreamCommit) {
  failures.push(`manifest commit ${manifest.upstreamCommit} does not match ${upstreamCommit}`);
}

const summarySource = await readFile(path.join(root, "sources", "upstream", "SUMMARY.md"), "utf8");
const summaryPaths = [...summarySource.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]);
const manifestSources = manifest.pages.map((page) => page.source);
if (JSON.stringify(summaryPaths) !== JSON.stringify(manifestSources)) {
  failures.push("manifest pages do not match the pages SUMMARY.md lists, in order");
}

const publishedAssetByName = new Map(
  manifest.assets.filter((asset) => asset.published).map((asset) => [path.basename(asset.output), asset]),
);
for (const asset of manifest.brandAssets) publishedAssetByName.set(path.basename(asset.output), asset);

for (const page of manifest.pages) {
  const source = await readFile(path.join(root, "sources", "upstream", page.source));
  const generated = await readFile(path.join(root, page.output));
  const generatedSource = generated.toString("utf8");
  if (sha256(source) !== page.sourceSha256) failures.push(`${page.source}: source digest changed`);
  if (sha256(generated) !== page.generatedSha256) failures.push(`${page.output}: generated digest changed`);
  if (frontmatterTitle(generatedSource) !== page.title) {
    failures.push(`${page.output}: generated title does not match the manifest`);
  }
  if (authoredLevelOneHeading(stripFrontmatter(generatedSource))) {
    failures.push(`${page.output}: standard documentation body contains a level-one heading`);
  }
  const corrections = manifest.sourceCorrections.filter((correction) => correction.source === page.source);
  const expectedPayload = sourceTextPayload(source.toString("utf8"), corrections);
  const actualPayload = generatedTextPayload(generatedSource);
  if (expectedPayload !== actualPayload) {
    const at = firstDifference(expectedPayload, actualPayload);
    failures.push(
      `${page.output}: rendered text payload differs from the upstream page near ` +
        `"${expectedPayload.slice(Math.max(0, at - 40), at + 60)}" (upstream) vs ` +
        `"${actualPayload.slice(Math.max(0, at - 40), at + 60)}" (generated)`,
    );
  }
  for (const destination of markdownLinkDestinations(generatedSource)) {
    if (destination.startsWith("./") || destination.startsWith("../") || (!/^[a-z][a-z\d+.-]*:/i.test(destination) && destination.endsWith(".md"))) {
      failures.push(`${page.output}: source-relative documentation link remains: ${destination}`);
      continue;
    }
    if (destination.includes("\\")) failures.push(`${page.output}: link destination contains a backslash: ${destination}`);
    const target = normalizedDocumentationDestination(destination);
    if (target && !internalDocumentationRoutes.has(target)) {
      failures.push(`${page.output}: internal documentation link has no route: ${destination}`);
    }
  }
  for (const image of imageSources(generatedSource)) {
    if (/^https:\/\//.test(image)) continue;
    if (!image.startsWith("/img/")) {
      failures.push(`${page.output}: image is not served from the published asset root: ${image}`);
    } else if (!publishedAssetByName.has(image.slice(5))) {
      failures.push(`${page.output}: image has no published asset: ${image}`);
    }
  }
  if (/\.gitbook\/assets\//.test(generatedSource)) failures.push(`${page.output}: GitBook asset path remains`);
  if (/\{%/.test(generatedSource)) failures.push(`${page.output}: GitBook block syntax remains`);
}

for (const correction of manifest.sourceCorrections) {
  if (!correction.source || !correction.find || correction.replace === undefined || !correction.reason) {
    failures.push("source correction is missing its source, find, replace, or reason");
    continue;
  }
  const source = await readFile(path.join(root, "sources", "upstream", correction.source), "utf8");
  const occurrences = correction.occurrences ?? 1;
  if (source.split(correction.find).length !== occurrences + 1) {
    failures.push(`${correction.source}: source correction does not match exactly ${occurrences} time(s): ${correction.find}`);
  }
  if (!manifest.pages.some((page) => page.source === correction.source)) {
    failures.push(`${correction.source}: source correction targets a page that is not published`);
  }
}

for (const page of manifest.unpublishedPages) {
  await readFile(path.join(root, "sources", "upstream", page.source)).catch(() => {
    failures.push(`${page.source}: unpublished page is missing from the upstream snapshot`);
  });
  if (summaryPaths.includes(page.source)) failures.push(`${page.source}: SUMMARY.md lists a page the manifest calls unpublished`);
}

for (const page of manifest.adaptedPages) {
  const source = await readFile(path.join(root, page.source));
  const generated = await readFile(path.join(root, page.output));
  if (sha256(source) !== page.sourceSha256) failures.push(`${page.source}: adapted source digest changed`);
  if (sha256(generated) !== page.generatedSha256) failures.push(`${page.output}: generated digest changed`);
  if (sha256(source) !== sha256(generated)) failures.push(`${page.output}: generated page differs from its reviewed adaptation`);
}

let adaptationSource = "";
for (const input of manifest.adaptationInputs) {
  const source = await readFile(path.join(root, "sources", "upstream", input.source));
  if (sha256(source) !== input.sha256) failures.push(`${input.source}: landing-page input digest changed`);
  adaptationSource += `\n${source}`;
}
const adaptedHomepageSource = await readFile(path.join(root, "sources", "adapted", "index.mdx"), "utf8");
const homepage = contentText(adaptedHomepageSource);
const normalizedAdaptationSource = contentText(adaptationSource);
for (const assertion of manifest.homepageCopyAssertions) {
  if (!normalizedAdaptationSource.includes(contentText(assertion))) failures.push(`landing-page copy is not present upstream: ${assertion}`);
  if (!homepage.includes(contentText(assertion))) failures.push(`landing-page adaptation is missing reviewed copy: ${assertion}`);
}

const generatedHomepageSource = await readFile(path.join(root, "site", "pages", "index.mdx"), "utf8");
for (const [label, source] of [
  ["reviewed landing-page adaptation", adaptedHomepageSource],
  ["generated landing page", generatedHomepageSource],
]) {
  if (!/^pageLayout: landing$/m.test(source)) {
    failures.push(`${label} does not declare the SaturnDocs landing-page layout`);
  }
  for (const component of ["LandingHero", "LandingSection", "CardGroup", "LandingCta", "LandingFooter"]) {
    if (!source.includes(`<${component}`)) failures.push(`${label} is missing ${component}`);
  }
  for (const destination of markdownLinkDestinations(source).concat(attributeHrefs(source))) {
    const target = normalizedDocumentationDestination(destination);
    if (target && !internalDocumentationRoutes.has(target)) {
      failures.push(`${label}: internal documentation link has no route: ${destination}`);
    }
  }
}

const homeTab = docsConfig.navigation.tabs?.find((tab) => tab.tab === "Home");
const manualTab = docsConfig.navigation.tabs?.find((tab) => tab.tab === "Manual");
if (!homeTab || !flattenNavigation(homeTab.groups).includes("index")) {
  failures.push("navigation is missing a dedicated Home tab for the landing page");
}
if (manualTab && flattenNavigation(manualTab.groups).includes("index")) {
  failures.push("the Manual tab incorrectly claims the landing page route");
}
if (manualTab) {
  const summaryGroups = manifest.navigation.map((group) => group.group);
  const configGroups = manualTab.groups.map((group) => group.group);
  if (JSON.stringify(summaryGroups) !== JSON.stringify(configGroups)) {
    failures.push("Manual tab groups do not match the SUMMARY.md sections, in order");
  }
}

for (const asset of manifest.assets) {
  const source = await readFile(path.join(root, "sources", "upstream", asset.source));
  if (sha256(source) !== asset.sha256) failures.push(`${asset.source}: source asset digest changed`);
  if (asset.published) {
    const published = await readFile(path.join(root, asset.output));
    if (sha256(published) !== asset.sha256) failures.push(`${asset.output}: published asset differs from source`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path.basename(asset.output))) {
      failures.push(`${asset.output}: published asset name is not canonical`);
    }
  }
}

for (const asset of manifest.brandAssets) {
  const source = await readFile(path.join(root, asset.source));
  const published = await readFile(path.join(root, asset.output));
  if (sha256(source) !== asset.sha256) failures.push(`${asset.source}: brand asset digest changed`);
  if (sha256(published) !== asset.sha256) failures.push(`${asset.output}: published brand asset differs from source`);
}

const upstreamPages = (await walk(path.join(root, "sources", "upstream")))
  .filter((entry) => entry.endsWith(".md") && entry !== "SUMMARY.md");
const generatedPages = (await walk(path.join(root, "site", "pages")))
  .filter((entry) => entry.endsWith(".mdx"));
if (upstreamPages.length !== manifest.documentationPageCount + manifest.unpublishedPageCount) {
  failures.push(`found ${upstreamPages.length} upstream pages; manifest records ${manifest.documentationPageCount} published and ${manifest.unpublishedPageCount} unpublished`);
}
if (generatedPages.length !== manifest.pageCount) {
  failures.push(`found ${generatedPages.length} generated pages; manifest records ${manifest.pageCount}`);
}
const publishedFiles = (await walk(path.join(root, "site", "public", "img"))).length;
if (publishedFiles !== manifest.publishedAssetCount) {
  failures.push(`found ${publishedFiles} published assets; manifest records ${manifest.publishedAssetCount}`);
}

const navigationGroups = docsConfig.navigation.tabs.flatMap((tab) => tab.groups);
const navigationPages = flattenNavigation(navigationGroups);
const navigationEntries = navigationPageEntries(navigationGroups);
const manifestRoutes = [
  ...manifest.pages.map((page) => page.route.slice(1)),
  ...manifest.adaptedPages.filter((page) => page.navigation).map((page) => page.navigationRoute ?? page.route.slice(1)),
].sort();
const navigationRoutes = [...navigationPages].sort();
if (JSON.stringify(manifestRoutes) !== JSON.stringify(navigationRoutes)) {
  const missing = manifestRoutes.filter((route) => !navigationPages.includes(route));
  const extra = navigationPages.filter((route) => !manifestRoutes.includes(route));
  failures.push(`navigation mismatch; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`);
}
for (const page of manifest.pages) {
  const entry = navigationEntries.get(page.route.slice(1));
  if (page.navigationTitle !== undefined && entry?.label !== page.navigationTitle) {
    failures.push(`${page.route}: navigation label does not preserve ${page.navigationTitle}`);
  }
  if (page.navigationTitle === undefined && entry?.label !== undefined) {
    failures.push(`${page.route}: navigation label ${entry.label} is not the upstream navigation title`);
  }
}

const publishedAssets = [
  ...manifest.assets.filter((asset) => asset.published),
  ...manifest.brandAssets,
];
if (publishedAssets.length !== manifest.publishedAssetCount) {
  failures.push("published asset count does not match manifest");
}

if (failures.length > 0) {
  console.error(`Content verification failed with ${failures.length} error(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${manifest.documentationPageCount} upstream pages, ${manifest.pageCount} generated pages, ` +
      `${manifest.unpublishedPageCount} unpublished upstream pages, ${manifest.assetCount} source assets, ` +
      `${manifest.publishedAssetCount} published assets, canonical internal links, landing-page copy provenance, ` +
      "and complete navigation coverage.",
  );
}

function flattenNavigation(groups) {
  const pages = [];
  const visit = (entries) => {
    for (const entry of entries) {
      if (typeof entry === "string") pages.push(entry);
      else if (entry.page) pages.push(entry.page);
      else if (entry.pages) visit(entry.pages);
    }
  };
  for (const group of groups) visit(group.pages);
  return pages;
}

function navigationPageEntries(groups) {
  const pages = new Map();
  const visit = (entries) => {
    for (const entry of entries) {
      if (typeof entry === "string") pages.set(entry, { page: entry });
      else if (entry.page) pages.set(entry.page, entry);
      else if (entry.pages) visit(entry.pages);
    }
  };
  for (const group of groups) visit(group.pages);
  return pages;
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stripFrontmatter(source) {
  if (!source.startsWith("---\n")) return source;
  const closing = source.indexOf("\n---\n", 4);
  return closing === -1 ? source : source.slice(closing + 5);
}

// Reduces a GitBook page to the words a reader sees: hints become their body,
// figures become alt text then caption, and URLs lose their escapes.
function sourceTextPayload(source, corrections) {
  let body = source.replace(/<!--[\s\S]*?-->/g, "");
  for (const correction of corrections) body = body.replaceAll(correction.find, correction.replace);
  body = stripLeadingPageHeading(body);
  body = body
    .replace(/<figure><img src="[^"]*" alt="([^"]*)"(?: data-size="original")?><figcaption>(?:<p>([^<]*)<\/p>)?<\/figcaption><\/figure>/g, (_match, alt, caption) => `${caption ?? ""} ${alt}`)
    .replace(/^\s*\|(?:\s*-+\s*\|)+\s*$/gm, "")
    .replace(/<p><img src="[^"]*" alt="([^"]*)"(?: data-size="original")?><\/p>(?:<p>([^<]*)<\/p>)?/g, (_match, alt, caption) => `${caption ?? ""} ${alt}`)
    .replace(/<img src="[^"]*" alt="([^"]*)"(?: data-size="original")?>/g, "$1")
    .replace(/(?<!\\)<\/?p>/g, " ")
    .replace(/^\s*\{%\s*hint[^%]*%\}\s*$/gm, "")
    .replace(/^\s*\{%\s*endhint\s*%\}\s*$/gm, "");
  return markdownTextPayload(body);
}

function stripLeadingPageHeading(body) {
  return body.replace(/^(?:[ \t]*\r?\n)*[ \t]*#(?!#)[ \t]+.+?[ \t]*(?:\r?\n|$)/, "");
}

function frontmatterTitle(source) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
  const raw = block && /^title:\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^["']|["']$/g, "");
  }
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

function generatedTextPayload(source) {
  let body = stripFrontmatter(source);
  body = body
    .replace(/<Frame(?: caption="([^"]*)")?><img src="[^"]*" alt="([^"]*)" \/><\/Frame>/g, (_match, caption, alt) => `${decodeAttribute(caption ?? "")} ${decodeAttribute(alt)}`)
    .replace(/<img src="[^"]*" alt="([^"]*)" \/>/g, (_match, alt) => decodeAttribute(alt))
    .replace(/<\/?(?:Info|Check|Warning|Danger|Note|Tip|Columns)(?: cols=\{\d\})?>/g, "")
    .replace(/^\s*\|(?:\s*-+\s*\|)+\s*$/gm, "");
  return markdownTextPayload(body);
}

function markdownTextPayload(source) {
  return source
    .replace(/!\[([^\]]*)\]\(<[^>]*>\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\\([_&{}])/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstDifference(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function decodeAttribute(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function markdownLinkDestinations(source) {
  const destinations = [];
  let fence = null;
  for (const line of stripFrontmatter(source).split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    for (const match of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      destinations.push(match[1]);
    }
  }
  return destinations;
}

function imageSources(source) {
  const sources = [];
  for (const match of source.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) sources.push(match[1]);
  for (const match of source.matchAll(/<img src="([^"]*)"/g)) sources.push(match[1]);
  return sources;
}

function attributeHrefs(source) {
  return [...source.matchAll(/\b(?:href|primaryHref|secondaryHref)="([^"]*)"/g)].map((match) => match[1]);
}

function normalizedDocumentationDestination(destination) {
  if (!destination.startsWith("/docs")) return null;
  const pathname = destination.split(/[?#]/, 1)[0];
  return normalizedRoute(pathname);
}

function normalizedRoute(route) {
  if (route === "/") return route;
  return route.replace(/\/+$/, "");
}

function contentText(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replace(/\\([\\`*_{}[\]()#+\-.!<>])/g, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
