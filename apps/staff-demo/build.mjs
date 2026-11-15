// Bundles the demo into one self-contained HTML file: dist/staff-demo.html
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile(join(here, "src/styles.css"), "utf8");
const template = await readFile(join(here, "index.html"), "utf8");
const html = template.replace("/*__STYLES__*/", () => css).replace("/*__SCRIPT__*/", () => js);

await mkdir(join(here, "dist"), { recursive: true });
const out = join(here, "dist/staff-demo.html");
await writeFile(out, html);
console.log(`Built ${out} (${(html.length / 1024).toFixed(0)} KB)`);
