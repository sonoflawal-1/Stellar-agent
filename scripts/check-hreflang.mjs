#!/usr/bin/env node
import fs from "node:fs";

const html = fs.readFileSync("landing/index.html", "utf8");
const required = ["en", "de", "es", "fr", "ja", "pt", "zh-CN", "x-default"];
for (const lang of required) {
  if (!html.includes(`hreflang="${lang}"`)) {
    console.error(`Missing hreflang=${lang} in landing/index.html`);
    process.exit(1);
  }
}
const sitemap = fs.readFileSync("landing/sitemap.xml", "utf8");
for (const lang of ["en", "de", "es", "fr"]) {
  if (!sitemap.includes(`lang=${lang}`)) {
    console.error(`Missing ?lang=${lang} entry in landing/sitemap.xml`);
    process.exit(1);
  }
}
console.log("hreflang check OK");