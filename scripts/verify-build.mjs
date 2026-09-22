import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(root, "build");
const [manifest, docsConfig] = await Promise.all([
  readFile(path.join(root, "sources", "manifest.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "site", "docs.json"), "utf8").then(JSON.parse),
]);
const origin = docsConfig.siteUrl;
const failures = [];
const allPages = [...manifest.pages, ...manifest.adaptedPages];
const internalDocumentationRoutes = new Set([
  ...manifest.pages.map((page) => normalizedRoute(page.route)),
  ...(docsConfig.redirects ?? []).flatMap((redirect) => [
    normalizedRoute(redirect.source),
    normalizedRoute(redirect.destination),
  ]),
]);
let checkedInternalLinks = 0;

for (const page of allPages) {
  const relative = page.route.slice(1);
  const htmlPath = relative ? path.join(build, relative, "index.html") : path.join(build, "index.html");
  const twinPath = path.join(build, relative ? `${relative}.md` : "index.md");
  const [html, twin] = await Promise.all([
    readFile(htmlPath, "utf8").catch(() => null),
    readFile(twinPath, "utf8").catch(() => null),
  ]);
  if (html === null) failures.push(`${relative}: rendered HyperText Markup Language page is missing`);
  if (twin === null) failures.push(`${relative}: Markdown twin is missing`);
  if (html !== null && !html.includes(escapeHtml(page.title))) {
    failures.push(`${relative}: rendered page does not contain its source title`);
  }
  if (html !== null && (html.match(/<h1\b/g) ?? []).length !== 1) {
    failures.push(`${relative}: rendered page must contain exactly one level-one heading`);
  }
  if (twin !== null && markdownLevelOneHeadingCount(twin) !== 1) {
    failures.push(`${relative}: Markdown twin must contain exactly one level-one heading`);
  }
  if (html !== null && /\.gitbook\/assets\//.test(html)) failures.push(`${relative}: rendered page links a GitBook asset path`);
  if (html !== null && /\{%\s*(?:end)?hint/.test(html)) failures.push(`${relative}: rendered page shows GitBook hint syntax`);
  if (html !== null) {
    for (const destination of htmlLinkDestinations(html)) {
      const url = new URL(decodeHtmlAttribute(destination), `${origin}${page.route === "/" ? "/" : `${page.route}/`}`);
      if (url.origin !== origin || !url.pathname.startsWith("/docs")) continue;
      checkedInternalLinks += 1;
      const target = normalizedRenderedDocumentationRoute(url.pathname);
      if (!internalDocumentationRoutes.has(target)) {
        failures.push(`${page.route}: rendered internal documentation link has no route: ${url.pathname}`);
      }
    }
    for (const source of htmlImageSources(html)) {
      if (!source.startsWith("/img/")) continue;
      const built = await readFile(path.join(build, decodeHtmlAttribute(source))).catch(() => null);
      if (built === null) failures.push(`${page.route}: rendered image is missing from the build: ${source}`);
    }
  }
}

const landingHtml = await readFile(path.join(build, "index.html"), "utf8");
const landingTwin = await readFile(path.join(build, "index.md"), "utf8");
if (!landingHtml.includes('data-gs-layout="landing"')) {
  failures.push("/: rendered homepage does not use the landing-page frame");
}
if (!landingHtml.includes('class="gs-landing-hero ')) {
  failures.push("/: rendered homepage is missing its landing hero");
}
if (landingHtml.includes('class="gs-page-header')) {
  failures.push("/: rendered homepage includes the documentation page header");
}
if (landingHtml.includes("data-gs-toc")) {
  failures.push("/: rendered homepage includes the documentation table of contents");
}
for (const componentClass of ["gs-landing-cta", "gs-landing-footer", "gs-card"]) {
  if (!landingHtml.includes(componentClass)) failures.push(`/: rendered homepage is missing ${componentClass}`);
}
const normalizedLandingTwin = contentText(landingTwin);
for (const assertion of manifest.homepageCopyAssertions) {
  if (!normalizedLandingTwin.includes(contentText(assertion))) {
    failures.push(`/: Markdown twin is missing reviewed landing-page copy: ${assertion}`);
  }
}

const documentationHtml = await readFile(path.join(build, "docs", "introduction", "index.html"), "utf8");
if (!documentationHtml.includes('data-gs-layout="docs"')) {
  failures.push("/docs/introduction: rendered documentation page does not use the documentation frame");
}
if (!documentationHtml.includes('class="gs-page-header')) {
  failures.push("/docs/introduction: rendered documentation page is missing its page header");
}
if (!documentationHtml.includes("data-gs-toc")) {
  failures.push("/docs/introduction: rendered documentation page is missing its table of contents");
}

const figureHtml = await readFile(path.join(build, "docs", "unit-6-content-listing-with-views", "exercise-6-10-administration-with-view-bulk-operations", "index.html"), "utf8");
if (!figureHtml.includes("gs-frame-caption")) {
  failures.push("/docs/unit-6-content-listing-with-views/exercise-6-10-administration-with-view-bulk-operations: figure captions did not render as Frame captions");
}
if (!/gs-callout/.test(figureHtml)) {
  failures.push("/docs/unit-6-content-listing-with-views/exercise-6-10-administration-with-view-bulk-operations: GitBook hint did not render as a callout");
}

for (const asset of [...manifest.assets.filter((entry) => entry.published), ...manifest.brandAssets]) {
  const built = await readFile(path.join(build, "img", path.basename(asset.output))).catch(() => null);
  if (built === null) failures.push(`${asset.output}: built asset is missing`);
  else if (sha256(built) !== asset.sha256) failures.push(`${asset.output}: built asset digest differs`);
}

const sitemap = await readFile(path.join(build, "sitemap-0.xml"), "utf8");
for (const page of allPages) {
  const expected = page.route === "/" ? `${origin}/` : `${origin}${page.route}/`;
  if (!sitemap.includes(`<loc>${expected}</loc>`)) failures.push(`${page.route}: missing from sitemap`);
}

if (failures.length > 0) {
  console.error(`Build verification failed with ${failures.length} error(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${manifest.pageCount} rendered pages, ${manifest.pageCount} Markdown twins, ` +
      `${manifest.publishedAssetCount} byte-identical built assets, branded site routes, and complete sitemap coverage. ` +
      `Checked ${checkedInternalLinks} rendered internal documentation links.`,
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function contentText(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replace(/\\([\\`*_{}[\]()#+\-.!<>])/g, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function markdownLevelOneHeadingCount(markdown) {
  let count = 0;
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    if (/^ {0,3}#(?!#)(?:[ \t]+|$)/.test(line)) count += 1;
  }
  return count;
}

function htmlLinkDestinations(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref=(['"])(.*?)\1/gi)].map((match) => match[2]);
}

function htmlImageSources(html) {
  return [...html.matchAll(/<img\b[^>]*\bsrc=(['"])(.*?)\1/gi)].map((match) => match[2]);
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function normalizedRoute(route) {
  if (route === "/") return route;
  return route.replace(/\/+$/, "");
}

function normalizedRenderedDocumentationRoute(route) {
  if (route.endsWith("/index.md")) return normalizedRoute(route.slice(0, -9));
  if (route.endsWith(".md")) return normalizedRoute(route.slice(0, -3));
  return normalizedRoute(route);
}
